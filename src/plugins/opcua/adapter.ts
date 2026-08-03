/**
 * OPC-UA Protocol Adapter
 * 
 * Implements the BaseProtocolAdapter for OPC-UA (OPC Unified Architecture) devices.
 * This adapter handles connection management, data reading, and error handling for
 * OPC-UA industrial automation devices.
 * 
 * Features:
 * - Automatic endpoint discovery and selection
 * - Username/password authentication
 * - Security mode and policy support
 * - Node browsing and validation
 * - Automatic reconnection with exponential backoff
 * - Data type conversion and scaling
 * 
 * Example OPC-UA device configuration (stored in SQLite devices table):
 * {
 *   "name": "plc-001",
 *   "protocol": "opcua",
 *   "enabled": true,
 *   "pollInterval": 5000,
 *   "connection": {
 *     "endpointUrl": "opc.tcp://10.0.0.60:4840",
 *     "username": "admin",
 *     "password": "password",
 *     "securityMode": "None",
 *     "securityPolicy": "None",
 *     "connectionTimeout": 10000,
 *     "sessionTimeout": 60000,
 *     "keepAliveInterval": 5000
 *   },
 *   "dataPoints": [
 *     {
 *       "name": "temperature",
 *       "nodeId": "ns=2;s=Temperature",
 *       "unit": "°C",
 *       "dataType": "number"
 *     },
 *     {
 *       "name": "pressure",
 *       "nodeId": "ns=2;s=Pressure",
 *       "unit": "bar",
 *       "dataType": "number",
 *       "scalingFactor": 0.01
 *     }
 *   ],
 *   "metadata": {
 *     "manufacturer": "Siemens",
 *     "model": "S7-1500",
 *     "applicationUri": "urn:example:plc001"
 *   }
 * }
 * 
 * @module opcua-adapter
 */

// @ts-ignore - Optional dependency: node-opcua-client may not be installed
import {
	type ClientSession,
	type ClientMonitoredItem,
	type DataValue,
	AttributeIds,
	TimestampsToReturn,
	MonitoringParametersOptions as _MonitoringParametersOptions,
	type ReadValueIdOptions,
	DataType as _DataType,
	BrowsePath,
	type BrowsePathResult,
	ClientMonitoredItemGroup,
} from 'node-opcua-client';
import { BaseProtocolAdapter, type GenericDeviceConfig } from '../base.js';
import { type DeviceDataPoint, type Logger, type IProtocolAdapter as _IProtocolAdapter } from '../types.js';
import { ConsoleLogger } from '../logger.js';
import {
	type OPCUADeviceConfig,
	type OPCUADataPoint,
} from './types.js';
import { OPCUADeviceClient, type OPCUASession } from './client.js';
import { OpcuaStartupDiagnostics } from './diagnostics.js';

/**
 * One physical OPC-UA server session, shared by every configured device
 * whose connection resolves to the same groupKey (same normalized
 * endpointUrl + auth) — see GitHub issue #11.
 */
interface OPCUAConnectionGroup {
	key: string;
	memberDeviceNames: Set<string>;
	/** Synthetic device built from every member's merged dataPoints — see buildCompositeDevice(). */
	compositeDevice: OPCUADeviceConfig;
	/** Real owning device per nodeId, for correct per-device attribution of pooled reads. */
	nodeIdToDevice: Map<string, OPCUADeviceConfig>;
	client: OPCUADeviceClient;
	session: OPCUASession;
	tornDown: boolean;
}

/**
 * OPC-UA Protocol Adapter
 *
 * Extends BaseProtocolAdapter to provide OPC-UA-specific functionality.
 * Manages OPC-UA client connections, sessions, and data reading.
 */
export class OPCUAAdapter extends BaseProtocolAdapter  {
	private clients: Map<string, OPCUADeviceClient> = new Map();
	private sessions: Map<string, OPCUASession> = new Map();

	// Guards against two independent reconnect paths (this adapter's own
	// scheduleReconnect/attemptReconnect, and BaseProtocolAdapter's poll-failure
	// scheduleDeviceRetry -> initializeDevice) calling connectDevice() for the
	// same device concurrently. Without this, a poll that lands in the brief
	// window where attemptReconnect() has torn down the old session but not yet
	// committed the new one (see connectDevice()'s commitSession comment below)
	// throws "No active session", which BaseProtocolAdapter routes into its own
	// independent connectDevice() call — racing the in-flight one. Both used to
	// succeed and both called commitSession(), with whichever finished last
	// winning the map slot; the other's session/subscriptions/monitored items
	// stayed alive on the server, permanently untracked. See GitHub issue #18.
	private connectInFlight: Map<string, Promise<OPCUASession>> = new Map();

	// TEMPORARY — see diagnostics.ts. Remove once the monitored-item-count
	// investigation is done.
	private diagnostics: OpcuaStartupDiagnostics;

	// Human-readable names resolved from the OPC-UA server at connect time.
	// Populated from: metadata.displayName (config override) > server DisplayName attribute > unset
	private resolvedDeviceNames: Map<string, string> = new Map();

	// Per-node display names read from the OPC-UA server's parent folder nodes.
	// Keyed by value-variable nodeId. Populated when the server advertises a DisplayName
	// on the parent device folder (e.g. simulator profile "displayName" field).
	// Takes precedence over resolvedDeviceNames when present.
	private resolvedNodeDisplayNames: Map<string, string> = new Map();
  
	// Subscription splitting (many PLCs struggle with 200+ monitored items)
	private readonly MAX_MONITORED_ITEMS_PER_SUBSCRIPTION = 100; // Split subscriptions beyond this
  
	// Reconnection settings
	private readonly MIN_RETRY_DELAY = 5000;   // 5 seconds
	private readonly MAX_RETRY_DELAY = 60000;  // 60 seconds
	private readonly MAX_RETRY_ATTEMPTS = 10;  // Cap consecutive failures
  
	// Read retry settings (passed into runtime OPCUADeviceClient)
	private readonly MAX_READ_RETRIES = 3;
	private readonly READ_RETRY_DELAY = 100;

	// Rediscovery throttle: only emit 'rediscovery-needed' once per device per cooldown period
	private readonly REDISCOVERY_COOLDOWN_MS = 30000; // 30 seconds
	private lastRediscoveryNeeded: Map<string, number> = new Map();

	// Configured devices that resolve to the same physical server (same
	// normalized endpointUrl + auth) share ONE OPCUADeviceClient/session
	// instead of opening one per configured device — see GitHub issue #11.
	// `groups`/`deviceGroupKey` are adapter-internal only: every public/
	// base-class-facing method still takes/returns plain device names, and
	// `clients`/`sessions` above stay keyed by device.name (with every
	// member of a group pointing at the SAME client/session object) so the
	// rest of this file — readDeviceData(), writeNode(), etc. — needs no
	// changes at all.
	private groups: Map<string, OPCUAConnectionGroup> = new Map();
	private deviceGroupKey: Map<string, string> = new Map();

	private extractNodeScope(nodeId: string): string {
		const stringNodeMatch = nodeId.match(/^ns=(\d+);s=(.+)$/);
		if (stringNodeMatch) {
			const namespace = stringNodeMatch[1];
			const identifier = stringNodeMatch[2].trim();
			const segments = identifier.split(/[\\/.]/).filter(Boolean);
			const scope = segments.length > 1 ? segments.slice(0, -1).join('/') : identifier;
			return `ns${namespace}:s:${scope}`;
		}

		const numericNodeMatch = nodeId.match(/^ns=(\d+);i=(\d+)$/);
		if (numericNodeMatch) {
			return `ns${numericNodeMatch[1]}:i:${numericNodeMatch[2]}`;
		}

		return nodeId.replace(/\s+/g, '_');
	}

	/**
   * Derives the parent folder node ID from a string-addressed value variable.
   * e.g. "ns=2;s=Temperature/Device1/temperature" → "ns=2;s=Temperature/Device1"
   * Returns null for flat or non-string node IDs that have no resolvable parent.
   */
	private deriveParentNodeId(nodeId: string): string | null {
		const match = nodeId.match(/^(ns=\d+;s=)(.+)\/[^/]+$/);
		if (!match) return null;
		return `${match[1]}${match[2]}`;
	}


	/** Strips the `opc.tcp://` scheme, lowercases, and trims a trailing slash —
	 * shared by buildStableNodeDeviceId() (anomaly/metric device scoping) and
	 * computeGroupKey() (session-pooling grouping, GitHub issue #11), so the
	 * two features can't silently drift on what counts as "the same endpoint." */
	private normalizeEndpointKey(endpointUrl: string): string {
		return endpointUrl
			.trim()
			.replace(/^opc\.tcp:\/\//i, '')
			.toLowerCase()
			.replace(/\/+$/, '');
	}

	/**
	 * Identifies which shared-session group a configured device belongs to —
	 * devices with the same normalized endpointUrl AND the same auth settings
	 * share one OPCUADeviceClient/session instead of opening one per device.
	 * See GitHub issue #11. Devices on the same endpointUrl but with different
	 * security settings deliberately land in different groups (falls back to
	 * today's one-session-per-device behavior for that mismatched pair).
	 */
	private computeGroupKey(device: OPCUADeviceConfig): string {
		const c = device.connection;
		const authFingerprint = [c.securityPolicy ?? 'None', c.securityMode ?? 'None', c.username ?? ''].join('|');
		return `${this.normalizeEndpointKey(c.endpointUrl)}::${authFingerprint}`;
	}

	/** Every currently-configured, enabled device sharing `groupKey` — mirrors
	 * BaseProtocolAdapter.start()'s own `if (device.enabled)` gate so a disabled
	 * sibling's dataPoints never get pooled into an active group. */
	private getConfiguredGroupMembers(groupKey: string): OPCUADeviceConfig[] {
		const members: OPCUADeviceConfig[] = [];
		for (const config of this.devices.values()) {
			const d = config as OPCUADeviceConfig;
			if (d.enabled && this.computeGroupKey(d) === groupKey) {
				members.push(d);
			}
		}
		return members;
	}

	/**
	 * Builds the synthetic device passed into the existing (unchanged)
	 * doConnectDevice()/createSubscription() pipeline for a whole group: one
	 * connection (the primary/first-configured member's), one merged
	 * dataPoints array covering every member. `nodeIdToDevice` records each
	 * node's REAL owning device, for correct per-device attribution once a
	 * pooled subscription carries multiple distinct logical devices' nodes.
	 */
	private buildCompositeDevice(members: OPCUADeviceConfig[]): { device: OPCUADeviceConfig; nodeIdToDevice: Map<string, OPCUADeviceConfig> } {
		const primary = members[0];
		const nodeIdToDevice = new Map<string, OPCUADeviceConfig>();
		const mergedDataPoints: OPCUADataPoint[] = [];
		for (const m of members) {
			for (const dp of m.dataPoints) {
				mergedDataPoints.push(dp);
				nodeIdToDevice.set(dp.nodeId, m);
			}
		}

		// Reconcile a per-group policy for members that configure this
		// differently — minimum across the group, so no server ever receives
		// a subscription batch larger than any single member asked for.
		const configuredMax = members
			.map(m => m.connection.maxMonitoredItemsPerSubscription)
			.filter((v): v is number => typeof v === 'number' && v > 0);
		const reconciledMax = configuredMax.length ? Math.min(...configuredMax) : this.MAX_MONITORED_ITEMS_PER_SUBSCRIPTION;
		if (new Set(configuredMax).size > 1) {
			this.logger.warn(
				`OPC-UA group ${primary.connection.endpointUrl}: members configure different maxMonitoredItemsPerSubscription values (${configuredMax.join(', ')}); using minimum (${reconciledMax})`
			);
		}

		const device: OPCUADeviceConfig = {
			...primary,
			dataPoints: mergedDataPoints,
			connection: { ...primary.connection, maxMonitoredItemsPerSubscription: reconciledMax },
		};
		return { device, nodeIdToDevice };
	}

	private buildStableNodeDeviceId(device: OPCUADeviceConfig, dataPoint: OPCUADataPoint): string {
		const endpointKey = this.normalizeEndpointKey(device.connection.endpointUrl);

		// Prefer the data point's own device identity (device_uuid, then
		// device_name — see OPCUADataPointSchema) over deriving a scope from
		// the node ID's path structure. extractNodeScope() assumes node IDs
		// encode a device folder path (e.g. "ns=2;s=Building/AHU-1/hc_valve"),
		// which some servers do — but a flat addressing scheme (e.g.
		// "ns=2;s=tag/94", no folder hierarchy at all) makes every node's
		// derived scope identical regardless of which device it actually
		// belongs to, silently merging every device on the endpoint into one
		// bucket for anomaly buffering/scoring. device_uuid/device_name are
		// populated per-node at discovery time from the server's own folder
		// structure (see discovery.ts's folderDeviceName) and stay reliably
		// distinct per device even when the node ID itself gives no clue.
		const deviceScope = dataPoint.device_uuid || dataPoint.device_name;
		if (deviceScope) {
			return `opcua:${endpointKey}:${deviceScope.toLowerCase()}`;
		}

		const nodeScope = this.extractNodeScope(dataPoint.nodeId);
		return `opcua:${endpointKey}:${nodeScope}`;
	}

	/**
   * Creates a new OPC-UA adapter instance
   * 
   * @param devices - Array of OPC-UA device configurations
   * @param logger - Logger instance (optional, defaults to ConsoleLogger)
   */
	constructor(devices: OPCUADeviceConfig[], logger?: Logger) {
		super(devices as GenericDeviceConfig[], logger || new ConsoleLogger('debug'));
		this.diagnostics = new OpcuaStartupDiagnostics(this.logger);
	}
  
	/**
   * Classify node as metric or metadata using hierarchy of authority:
   * 
   * 1. Explicit semantic config (HIGHEST - user intent overrides everything)
   * 2. Well-known semantic prefixes (STRONG - serverinfo_*, deviceinfo_*, metadata_*)
   * 3. OPC UA metadata heuristics (WEAK - NodeClass, DataType)
   * 4. Data type (LAST RESORT - numeric = metric, non-numeric = metadata)
   * 
   * Why this hierarchy?
   * - Semantics cannot be inferred from data type alone
   * - firmware_version (UInt32) is metadata, not metric
   * - line1_speed_rpm (Int32) is metric, not metadata
   * - Only user knows semantic intent
   * 
   * @param nodeClass - OPC UA NodeClass value
   * @param dataTypeNodeId - OPC UA DataType NodeId
   * @param key - Node key/name for pattern matching
   * @param explicitSemantic - Explicit user-provided classification (highest authority)
   * @returns Node type classification
   */
	private classifyNodeByMetadata(
		nodeClass: any, 
		dataTypeNodeId: any, 
		key: string,
		explicitSemantic?: 'metric' | 'metadata'
	): 'metric' | 'metadata' | 'ignore' {
		// Only process Variable nodes (not Object, Method, etc.)
		// OPC UA NodeClass: Object=1, Variable=2, Method=4, ObjectType=8, VariableType=64
		if (nodeClass !== 2) { // NodeClass.Variable = 2
			return 'ignore';
		}

		// 1. EXPLICIT SEMANTIC CONFIG (highest authority - user intent)
		// User explicitly marked this node as metric or metadata
		// This overrides all heuristics - use it when semantics cannot be inferred
		if (explicitSemantic) {
			return explicitSemantic;
		}

		// 2. WELL-KNOWN SEMANTIC PREFIXES (strong hint)
		// serverinfo_*, deviceinfo_*, metadata_* are always metadata
		// This handles common patterns but can be overridden by explicit config (#1)
		if (key.startsWith('serverinfo_') || key.startsWith('deviceinfo_') || key.startsWith('metadata_')) {
			return 'metadata';
		}

		// 3. OPC UA METADATA HEURISTICS (weak hint - extract DataType from NodeId)
		// Extract numeric identifier from NodeId (handle both numeric and object forms)
		let dataType: number;
		if (typeof dataTypeNodeId === 'number') {
			dataType = dataTypeNodeId;
		} else if (dataTypeNodeId && typeof dataTypeNodeId === 'object') {
			// NodeId object - extract value/identifier
			dataType = dataTypeNodeId.value || dataTypeNodeId.identifier;
		} else {
			// Unknown format - default to metadata
			return 'metadata';
		}

		// 4. DATA TYPE (last resort - technical type, not semantic meaning)
		// Numeric data types = metrics (time-series telemetry)
		// Non-numeric = metadata (configuration, diagnostics, info)
		// OPC UA standard numeric types in namespace 0
		const numericDataTypes = [
			2,  // SByte
			3,  // Byte
			4,  // Int16
			5,  // UInt16
			6,  // Int32
			7,  // UInt32
			8,  // Int64
			9,  // UInt64
			10, // Float
			11, // Double
		];

		if (numericDataTypes.includes(dataType)) {
			return 'metric';
		}

		// Non-numeric = metadata (strings, booleans, etc.)
		return 'metadata';
	}

	// Well-known OPC UA ReferenceTypeId for "HasProperty" (ns=0;i=46 — stable
	// across the spec, Part 6). Used below to browse each node's standard
	// EngineeringUnits child property without pulling in node-opcua-nodeid just
	// for resolveNodeId("HasProperty").
	private static readonly HAS_PROPERTY_REF_ID = 'i=46';

	/**
	 * Batch-resolve the standard EngineeringUnits property (an EUInformation
	 * struct with a real unit symbol, e.g. "°C") for every data point missing a
	 * configured unit. Costs two round trips total regardless of node count
	 * (one translateBrowsePath + one read for the whole batch), matching the
	 * batching approach validateNodeIds already uses below — not one browse per
	 * node. Servers that don't expose EngineeringUnits for a given node (most
	 * boolean/string points) just get a not-found result for that entry and are
	 * left for validateNodeIds' existing Description-text fallback to try.
	 */
	private async readEngineeringUnits(
		session: ClientSession,
		dataPoints: OPCUADataPoint[],
		deviceName: string
	): Promise<Map<string, string>> {
		const units = new Map<string, string>();
		const candidates = dataPoints.filter((dp) => !dp.unit);
		if (candidates.length === 0) return units;

		try {
			const browsePaths = candidates.map((dp) => new BrowsePath({
				startingNode: dp.nodeId,
				relativePath: {
					elements: [{
						includeSubtypes: false,
						isInverse: false,
						referenceTypeId: OPCUAAdapter.HAS_PROPERTY_REF_ID,
						targetName: { namespaceIndex: 0, name: 'EngineeringUnits' },
					}],
				},
			}));

			const browsePathResults = await session.translateBrowsePath(browsePaths);

			const propertyNodeIds: string[] = [];
			const ownerNodeIds: string[] = [];
			browsePathResults.forEach((result: BrowsePathResult, i: number) => {
				if (result.statusCode.isGood() && result.targets && result.targets.length > 0) {
					propertyNodeIds.push(result.targets[0].targetId.toString());
					ownerNodeIds.push(candidates[i].nodeId);
				}
			});
			if (propertyNodeIds.length === 0) return units;

			const values = await session.read(
				propertyNodeIds.map((nodeId) => ({ nodeId, attributeId: AttributeIds.Value }))
			);

			values.forEach((result: DataValue, i: number) => {
				if (!result.statusCode.isGood()) return;
				const euInfo = result.value?.value as { displayName?: { text?: string } | string } | undefined;
				const displayName = euInfo?.displayName;
				const symbol = typeof displayName === 'string' ? displayName : displayName?.text;
				if (symbol) {
					units.set(ownerNodeIds[i], symbol);
				}
			});
		} catch (error) {
			this.logger.debug(`EngineeringUnits lookup failed for ${deviceName}, falling back to Description parsing`, {
				deviceName,
				error: error instanceof Error ? error.message : String(error)
			});
		}

		return units;
	}

	/**
   * Validate that NodeIDs exist and are accessible
   * Prevents runtime errors from misconfigured or missing nodes
   * Also auto-classifies nodes based on OPC UA metadata (NodeClass, DataType)
   *
   * @param session - Active OPC-UA session
   * @param dataPoints - Data points to validate
   * @param deviceName - Device name (for logging)
   * @returns Object with valid data points and list of invalid NodeIDs
   */
	private async validateNodeIds(
		session: ClientSession,
		dataPoints: OPCUADataPoint[],
		deviceName: string
	): Promise<{ valid: OPCUADataPoint[], invalid: string[] }> {
		const valid: OPCUADataPoint[] = [];
		const invalid: string[] = [];

		this.logger.debug(`Validating ${dataPoints.length} NodeIDs for ${deviceName}...`);

		// PERFORMANCE: Batch all reads into single request
		// Before: 4 RTTs per node (Value, NodeClass, DataType, Description)
		// After: 1 RTT for all nodes × all attributes
		// Impact: 1000 nodes = 4000 RTTs → 1 RTT (4000x faster!)
		const nodesToRead: ReadValueIdOptions[] = [];
    
		for (const dp of dataPoints) {
			nodesToRead.push(
				{ nodeId: dp.nodeId, attributeId: AttributeIds.Value },
				{ nodeId: dp.nodeId, attributeId: AttributeIds.NodeClass },
				{ nodeId: dp.nodeId, attributeId: AttributeIds.DataType },
				{ nodeId: dp.nodeId, attributeId: AttributeIds.Description }
			);
		}
    
		const validationStart = Date.now();
		const results = await session.read(nodesToRead);
		const validationTime = Date.now() - validationStart;
    
		this.logger.debug(`Batch validation completed in ${validationTime}ms`, {
			deviceName,
			nodeCount: dataPoints.length,
			readCount: nodesToRead.length,
			avgTimePerNode: Math.round(validationTime / dataPoints.length)
		});

		// Standard EngineeringUnits property is the authoritative unit source when
		// present (real unit symbol, e.g. "°C") — resolved for the whole batch in
		// two extra round trips, not one per node. Description-text parsing below
		// only runs for nodes this doesn't find anything for.
		const engineeringUnits = await this.readEngineeringUnits(session, dataPoints, deviceName);

		// Parse results (4 consecutive results per data point)
		for (let i = 0; i < dataPoints.length; i++) {
			const dp = dataPoints[i];
			const baseIdx = i * 4;
			const valueResult = results[baseIdx];
			const nodeClassResult = results[baseIdx + 1];
			const dataTypeResult = results[baseIdx + 2];
			const descriptionResult = results[baseIdx + 3];

			// Check if reads were successful
			if (!valueResult.statusCode.isGood()) {
				invalid.push(dp.nodeId);
				this.logger.warn(`NodeID validation failed: ${dp.nodeId} (${dp.name})`, {
					deviceName,
					statusCode: valueResult.statusCode.name,
					description: valueResult.statusCode.description
				});
				continue;
			}

			// Extract metadata
			const nodeClass = nodeClassResult.value?.value;
			const dataTypeNodeId = dataTypeResult.value?.value;

			// Auto-populate unit: prefer the standard EngineeringUnits property (real
			// unit symbol, resolved above); fall back to parsing Description text
			// only when a server doesn't expose EngineeringUnits for this node.
			if (!dp.unit && engineeringUnits.has(dp.nodeId)) {
				(dp as any).unit = engineeringUnits.get(dp.nodeId);
			} else if (!dp.unit && descriptionResult.statusCode.isGood()) {
				const description = descriptionResult.value?.value?.text || descriptionResult.value?.value;
				if (description && typeof description === 'string') {
					// Extract unit from description - supports both simple and composite units
					// Pattern matches: "in {unit}" or "{unit}" at end of string
					// Examples: "Temperature in °C", "Flow in L/min", "Vibration in mm/s"
					const inUnitMatch = description.match(/\bin\s+([^\s,]+(?:\/[^\s,]+)?)/i);
					if (inUnitMatch) {
						(dp as any).unit = inUnitMatch[1];
					}
				}
			}

			// Classify using hierarchy of authority: semantic > prefixes > OPC UA metadata > datatype
			const explicitSemantic = (dp as any).semantic; // User-provided semantic intent
			const classified = this.classifyNodeByMetadata(nodeClass, dataTypeNodeId, dp.name, explicitSemantic);

			// Skip nodes that should be ignored (non-Variable nodes)
			if (classified === 'ignore') {
				this.logger.debug(`Skipping non-Variable node: ${dp.nodeId} (${dp.name})`, {
					deviceName,
					nodeClass
				});
				continue;
			}

			// Set computed nodeType (result of classification)
			(dp as any).nodeType = classified;

			// Only include metrics in validated nodes (metadata excluded from polling/subscription)
			if (classified === 'metric') {
				valid.push(dp);
			}
		}

		// Log summary
		this.logger.debug(`NodeID validation complete: ${valid.length} metrics, ${invalid.length} invalid`, {
			deviceName,
			validNodes: valid.map(dp => dp.nodeId),
			invalidNodes: invalid
		});

		return { valid, invalid };
	}

	/**
   * Read metadata nodes once and emit on separate channel
   * Metadata is read on connect/reconnect, not part of time-series polling
   * 
   * @param session - Active OPC-UA session
   * @param dataPoints - All data points (will filter for metadata)
   * @param deviceName - Device name (for logging)
   */
	private async readMetadata(
		session: ClientSession,
		dataPoints: OPCUADataPoint[],
		deviceName: string
	): Promise<void> {
		// Filter to only metadata nodes
		const metadataNodes = dataPoints.filter(dp => 
			(dp).nodeType === 'metadata'
		);

		if (metadataNodes.length === 0) {
			this.logger.debug(`No metadata nodes to read for ${deviceName}`);
			return;
		}

		this.logger.debug(`Reading ${metadataNodes.length} metadata nodes for ${deviceName}...`);

		const timestamp = new Date().toISOString();
		const metadataRecords: any[] = [];

		for (const dp of metadataNodes) {
			try {
				const dataValue = await session.readVariableValue(dp.nodeId);

				if (dataValue.statusCode.isGood()) {
					metadataRecords.push({
						deviceName,
						key: dp.name,
						value: dataValue.value?.value,
						nodeId: dp.nodeId,
						updatedAt: timestamp,
					});
				} else {
					this.logger.warn(`Failed to read metadata: ${dp.name}`, {
						deviceName,
						nodeId: dp.nodeId,
						statusCode: dataValue.statusCode.name,
					});
				}
			} catch (error) {
				this.logger.error(`Error reading metadata: ${dp.name}`, {
					deviceName,
					nodeId: dp.nodeId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// Emit metadata on separate channel (not 'data')
		if (metadataRecords.length > 0) {
			this.emit('metadata', metadataRecords);
		}
	}

	/**
   * Create subscription for real-time data streaming
   * Sets up monitored items for all configured data points
   * Data changes will emit events instead of requiring polling
   * 
   * @param deviceName - Device name
   * @param device - Device configuration
   * @param sessionWrapper - Active session wrapper
   */
	private async createSubscription(
		deviceName: string,
		device: OPCUADeviceConfig,
		sessionWrapper: OPCUASession,
		nodeIdToDevice: Map<string, OPCUADeviceConfig>
	): Promise<void> {
		if (!sessionWrapper.session) {
			throw new Error(`No active session for device: ${deviceName}`);
		}

		const { session } = sessionWrapper;
		const { connection, dataPoints } = device;

		// Filter to only validated metric nodes (exclude metadata)
		const validDataPoints = dataPoints.filter(dp => 
			sessionWrapper.validatedNodes.has(dp.nodeId) && 
      (dp).nodeType === 'metric'
		);

		if (validDataPoints.length === 0) {
			this.logger.warn(`No valid NodeIDs to subscribe for ${deviceName}`);
			return;
		}

		// PERFORMANCE: Split into multiple subscriptions if node count exceeds limit
		// Many PLCs struggle with 200+ monitored items per subscription
		// Symptoms: missed publishes, queue overflows, silent throttling
		const maxItemsPerSub = connection.maxMonitoredItemsPerSubscription || this.MAX_MONITORED_ITEMS_PER_SUBSCRIPTION;
		const subscriptionCount = Math.ceil(validDataPoints.length / maxItemsPerSub);
    
		if (subscriptionCount > 1) {
			this.logger.debug(`Splitting ${validDataPoints.length} nodes into ${subscriptionCount} subscriptions`, {
				deviceName,
				maxItemsPerSub,
				reason: 'plc_load_distribution'
			});
		}

		sessionWrapper.subscriptions = [];

		// Create subscriptions (one or more depending on node count)
		for (let subIdx = 0; subIdx < subscriptionCount; subIdx++) {
			const startIdx = subIdx * maxItemsPerSub;
			const endIdx = Math.min(startIdx + maxItemsPerSub, validDataPoints.length);
			const batchDataPoints = validDataPoints.slice(startIdx, endIdx);

			// Create subscription
			const subscription = await session.createSubscription2({
				requestedPublishingInterval: connection.publishingInterval || 1000,
				requestedLifetimeCount: 100,
				requestedMaxKeepAliveCount: 10,
				maxNotificationsPerPublish: 100,
				publishingEnabled: true,
				priority: 10,
			});

			sessionWrapper.subscriptions.push(subscription);
      
			// Set legacy field for backwards compatibility (first subscription)
			if (subIdx === 0) {
				sessionWrapper.subscription = subscription;
			}

			this.logger.debug(`Created subscription ${subIdx + 1}/${subscriptionCount} for ${deviceName}`, {
				publishingInterval: connection.publishingInterval || 1000,
				samplingInterval: connection.samplingInterval || 500,
				itemCount: batchDataPoints.length,
				totalItems: validDataPoints.length,
			});

			// Create every monitored item for this subscription's batch in ONE network
			// round-trip via ClientMonitoredItemGroup, instead of one subscription.monitor()
			// call per node. The previous per-item loop meant one createMonitoredItems
			// request per node (e.g. 665 sequential round-trips for a 665-node device) —
			// this had never actually run against a real device before useSubscription
			// worked correctly, and turned out to stall the event loop badly once it did.
			// See node-opcua-client's ClientMonitoredItemToolbox._toolbox_monitor: it
			// builds one CreateMonitoredItemsRequest covering the whole array and maps
			// response.results[i] back to monitoredItems[i] in order — per-item status
			// codes are preserved exactly as before, just from one batched response.
			const parameters = {
				samplingInterval: connection.samplingInterval || 500,
				discardOldest: true,
				queueSize: connection.queueSize ?? 1,
			};

			const itemsToMonitor = batchDataPoints.map(dp => ({
				nodeId: dp.nodeId,
				attributeId: AttributeIds.Value,
			}));

			const group = ClientMonitoredItemGroup.create(subscription, itemsToMonitor, parameters, TimestampsToReturn.Both);

			try {
				await new Promise<void>((resolve, reject) => {
					group.once('initialized', () => resolve());
					group.once('err', (message: string) => reject(new Error(message)));
				});
			} catch (error) {
				this.logger.error(`Failed to create monitored item group for ${deviceName}: ${error}`, { deviceName, itemCount: batchDataPoints.length });
				for (const dp of batchDataPoints) {
					// TEMPORARY diagnostics — see diagnostics.ts.
					this.diagnostics.recordMonitorAttempt(deviceName, dp.nodeId, false, error instanceof Error ? error.message : String(error));
				}
				continue;
			}

			// One handler for the whole batch — index maps back to batchDataPoints
			// (ClientMonitoredItemGroup preserves the order itemsToMonitor was built in).
			//
			// A single OPC-UA PublishResponse can report many nodes changed at once —
			// node-opcua delivers that as one 'changed' event per node, all firing
			// synchronously back-to-back in the same tick. Emitting 'data' immediately
			// per node (as this used to, matching the pre-batching monitor() code)
			// meant up to one emit per node per publish cycle — hundreds/sec for a
			// large device — each cascading into its own IPC socket send, DB write,
			// etc. downstream. Buffer same-tick changes and flush once via
			// setImmediate instead: real-time streaming is unaffected (flush happens
			// as soon as the current synchronous burst of 'changed' events ends, not
			// on a fixed delay), but downstream consumers get one batch instead of N
			// individual events.
			let pendingDataPoints: DeviceDataPoint[] = [];
			const flushPendingDataPoints = () => {
				if (pendingDataPoints.length === 0) return;
				const batch = pendingDataPoints;
				pendingDataPoints = [];
				this.emit('data', batch);
			};

			group.on('changed', (_monitoredItem: unknown, dataValue: DataValue, index: number) => {
				const dp = batchDataPoints[index];

				// Resolve the REAL owning device for this node — when `device`
				// is a pooled composite spanning multiple configured devices
				// sharing one endpoint (see buildCompositeDevice(), GitHub
				// issue #11), `deviceName`/`device` above are the composite's
				// (primary member's), not necessarily this specific node's own
				// device. nodeIdToDevice always has an entry for every node in
				// this composite's dataPoints; falls back to the outer device
				// for the ordinary (ungrouped, or group-of-one) case.
				const owningDevice = nodeIdToDevice.get(dp.nodeId) ?? device;
				const owningDeviceName = owningDevice.name;

				// Hard gate: Never emit metadata nodes
				if (dp.nodeType !== 'metric') {
					this.logger.warn(`Blocked metadata node emission: ${dp.name}`, { deviceName: owningDeviceName });
					return;
				}

				const quality = this.determineQuality(dataValue.statusCode);
				const qualityCode = quality !== 'GOOD' ? this.extractQualityCode(dataValue.statusCode) : undefined;

				const dataPoint: DeviceDataPoint = {
					timestamp: new Date().toISOString(),
					deviceName: owningDeviceName,
					deviceId: this.buildStableNodeDeviceId(owningDevice, dp),
					metric: dp.name,
					value: dataValue.value?.value ?? null,
					unit: dp.unit || '',
					quality,
					...(qualityCode && { qualityCode }),  // Only include if quality != GOOD
					protocol: 'opcua',  // For enum namespacing
					nodeType: 'metric', // Always 'metric' at this point (metadata filtered)
					...(dp.device_uuid && { device_uuid: dp.device_uuid }),
					...((this.resolvedNodeDisplayNames.has(dp.nodeId) || this.resolvedDeviceNames.has(owningDeviceName)) && {
						resolvedDisplayName: this.resolvedNodeDisplayNames.get(dp.nodeId) ?? this.resolvedDeviceNames.get(owningDeviceName),
					}),
				};

				if (pendingDataPoints.length === 0) {
					setImmediate(flushPendingDataPoints);
				}
				pendingDataPoints.push(dataPoint);
			});

			// Per-item creation result + per-item ongoing error handling — same
			// granularity the previous one-monitor()-call-per-item loop had.
			group.monitoredItems.forEach((monitoredItem, index) => {
				const dp = batchDataPoints[index];

				// TEMPORARY diagnostics — see diagnostics.ts.
				this.diagnostics.recordMonitorAttempt(deviceName, dp.nodeId, true, monitoredItem.statusCode?.toString());

				monitoredItem.on('err', (errorMessage: string) => {
					this.logger.error(`Monitored item error for ${dp.name}: ${errorMessage}`, {
						deviceName,
						nodeId: dp.nodeId,
					});
				});

				sessionWrapper.monitoredItems.set(dp.nodeId, monitoredItem as ClientMonitoredItem);
			});

			// Handle subscription errors
			subscription.on('terminated', () => {
				this.logger.warn(`Subscription ${subIdx + 1} terminated for ${deviceName}`);
				// TEMPORARY diagnostics — see diagnostics.ts.
				this.diagnostics.recordSubscriptionTerminated(deviceName);
			});

			subscription.on('keepalive', () => {
				// keepalive: subscription is healthy, no action needed
			});
		}

		// TEMPORARY diagnostics — see diagnostics.ts. Reaching here means every
		// batch above completed without createSubscription2() itself throwing —
		// individual monitor() failures are already tracked per-item above.
		this.diagnostics.recordSubscriptionResult(deviceName, true, sessionWrapper.subscriptions.map(s => s.subscriptionId));
	}

	/**
   * Extract normalized quality code from OPC-UA status code
   * Maps OPC-UA status codes to standard quality codes for pipeline consistency
   * 
   * @param statusCode - OPC-UA status code or error message
   * @returns Normalized quality code string
   */
	protected extractQualityCode(statusCode: any): string {
		if (!statusCode) {
			return 'UNKNOWN_ERROR';
		}
    
		const statusName = statusCode.name || statusCode.toString();
    
		// Session/Connection errors
		if (statusName.includes('BadSessionClosed') || statusName.includes('BadSessionIdInvalid')) {
			return 'SESSION_CLOSED';
		}
		if (statusName.includes('BadSecureChannelClosed') || statusName.includes('BadSecureChannelIdInvalid')) {
			return 'SECURE_CHANNEL_CLOSED';
		}
		if (statusName.includes('BadConnectionClosed') || statusName.includes('BadConnectionRejected')) {
			return 'CONNECTION_REFUSED';
		}
		if (statusName.includes('BadCommunicationError')) {
			return 'COMMUNICATION_ERROR';
		}
		if (statusName.includes('BadServerHalted') || statusName.includes('BadServerNotConnected')) {
			return 'DEVICE_OFFLINE';
		}
    
		// Timeout errors
		if (statusName.includes('BadTimeout') || statusName.includes('BadRequestTimeout')) {
			return 'TIMEOUT';
		}
    
		// Node/Data errors
		if (statusName.includes('BadNodeIdUnknown') || statusName.includes('BadNodeIdInvalid')) {
			return 'INVALID_NODE_ID';
		}
		if (statusName.includes('BadAttributeIdInvalid')) {
			return 'INVALID_ATTRIBUTE';
		}
		if (statusName.includes('BadDataUnavailable') || statusName.includes('BadWaitingForInitialData')) {
			return 'DATA_UNAVAILABLE';
		}
    
		// Security/Authentication errors
		if (statusName.includes('BadIdentityTokenInvalid') || statusName.includes('BadIdentityTokenRejected')) {
			return 'AUTHENTICATION_FAILED';
		}
		if (statusName.includes('BadUserAccessDenied') || statusName.includes('BadNotReadable')) {
			return 'ACCESS_DENIED';
		}
		if (statusName.includes('BadCertificate')) {
			return 'CERTIFICATE_ERROR';
		}
    
		// Data quality errors
		if (statusName.includes('BadOutOfRange')) {
			return 'VALUE_OUT_OF_RANGE';
		}
		if (statusName.includes('BadTypeMismatch')) {
			return 'TYPE_MISMATCH';
		}
    
		// Generic errors
		if (statusName.includes('BadUnexpectedError') || statusName.includes('BadInternalError')) {
			return 'INTERNAL_ERROR';
		}
		if (statusName.includes('BadNotSupported')) {
			return 'NOT_SUPPORTED';
		}
    
		// Return raw status name if no mapping found
		return statusName;
	}
  
	/**
   * Determine overall quality level from OPC-UA status code
   * Maps to standard quality levels: GOOD, UNCERTAIN, BAD
   * 
   * @param statusCode - OPC-UA status code
   * @returns Quality level
   */
	private determineQuality(statusCode: any): 'GOOD' | 'UNCERTAIN' | 'BAD' {
		if (!statusCode) {
			return 'BAD';
		}
    
		// OPC-UA has built-in quality checks
		if (statusCode.isGood?.()) {
			return 'GOOD';
		}
    
		const statusName = statusCode.name || statusCode.toString();
    
		// UNCERTAIN: Data available but quality questionable
		const uncertainPatterns = [
			'Uncertain',
			'BadWaitingForInitialData',
			'BadDataUnavailable',
		];
    
		if (uncertainPatterns.some(pattern => statusName.includes(pattern))) {
			return 'UNCERTAIN';
		}
    
		// BAD: Data invalid or unavailable
		return 'BAD';
	}
  
	/**
   * Returns the protocol name
   * Required by BaseProtocolAdapter
   */
	protected getProtocolName(): string {
		return 'opcua';
	}

	/**
   * Validates OPC-UA device configuration
   * Checks for required fields and valid values
   * 
   * @param device - Device configuration to validate
   * @throws Error if configuration is invalid
   */
	protected validateDeviceConfig(device: OPCUADeviceConfig): void {
		const { connection, dataPoints } = device;

		// Validate endpoint URL
		if (!connection.endpointUrl) {
			throw new Error(`Device ${device.name}: endpointUrl is required`);
		}

		if (!connection.endpointUrl.startsWith('opc.tcp://')) {
			throw new Error(
				`Device ${device.name}: endpointUrl must start with 'opc.tcp://'`
			);
		}

		// Validate data points (if provided)
		// Empty dataPoints triggers auto-discovery mode
		if (dataPoints && dataPoints.length > 0) {
			for (const dp of dataPoints) {
				if (!dp.name) {
					throw new Error(`Device ${device.name}: data point name is required`);
				}
				if (!dp.nodeId) {
					throw new Error(
						`Device ${device.name}: nodeId is required for data point ${dp.name}`
					);
				}
			}
		}

		// Validate authentication
		if (connection.username && !connection.password) {
			this.logger.warn(
				`Device ${device.name}: username provided without password`
			);
		}

		if (connection.expectedServerThumbprint) {
			const normalizedThumbprint = connection.expectedServerThumbprint.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
			if (normalizedThumbprint.length !== 40) {
				throw new Error(
					`Device ${device.name}: expectedServerThumbprint must be a 40-character SHA-1 thumbprint`
				);
			}
		}
	}

	/**
   * Connects to an OPC-UA device
   * Runtime connection details are delegated to OPCUADeviceClient.
   * 
   * @param device - Device configuration
   * @returns OPCUASession object with client and session
   */
	protected async connectDevice(device: OPCUADeviceConfig): Promise<OPCUASession> {
		const groupKey = this.computeGroupKey(device);
		this.deviceGroupKey.set(device.name, groupKey);

		// A sibling device already resolved the shared session for this group —
		// BaseProtocolAdapter.start() calls connectDevice() once per configured
		// device, sequentially, so by the time later group members reach here
		// the first one has already committed a live session for the whole
		// group. Reuse it instead of opening a second connection to the same
		// physical server. See GitHub issue #11.
		const existingGroup = this.groups.get(groupKey);
		if (existingGroup && !existingGroup.tornDown) {
			existingGroup.memberDeviceNames.add(device.name);
			this.clients.set(device.name, existingGroup.client);
			this.sessions.set(device.name, existingGroup.session);
			return existingGroup.session;
		}

		// Coalesce concurrent callers targeting the same physical server+auth
		// (this adapter's own reconnect path vs base-class poll-failure retry —
		// see connectInFlight's declaration) onto the single in-flight attempt
		// instead of each independently building a full client/session/subscription
		// stack. Keyed by groupKey (not device.name) so this also coalesces two
		// DIFFERENT device names that share an endpoint — the group-scoped
		// extension of the original issue-#18 fix. See GitHub issue #11.
		const inFlight = this.connectInFlight.get(groupKey);
		if (inFlight) {
			return inFlight;
		}

		const attempt = this.connectGroup(groupKey).finally(() => {
			this.connectInFlight.delete(groupKey);
		});
		this.connectInFlight.set(groupKey, attempt);
		return attempt;
	}

	/**
	 * Connects once for every currently-configured, enabled device sharing
	 * `groupKey`: builds one composite device from their merged dataPoints,
	 * runs the existing (unchanged) doConnectDevice() against it, then
	 * registers the resulting client/session under every member's own
	 * device name. See GitHub issue #11.
	 */
	private async connectGroup(groupKey: string): Promise<OPCUASession> {
		const members = this.getConfiguredGroupMembers(groupKey);
		const { device: compositeDevice, nodeIdToDevice } = this.buildCompositeDevice(members);
		const sessionWrapper = await this.doConnectDevice(compositeDevice, nodeIdToDevice);
		const client = this.clients.get(compositeDevice.name)!;

		const group: OPCUAConnectionGroup = {
			key: groupKey,
			memberDeviceNames: new Set(members.map(m => m.name)),
			compositeDevice,
			nodeIdToDevice,
			client,
			session: sessionWrapper,
			tornDown: false,
		};
		this.groups.set(groupKey, group);

		if (members.length > 1) {
			this.logger.info(
				`OPC-UA endpoint ${compositeDevice.connection.endpointUrl} pools ${members.length} configured devices onto one session: ${members.map(m => m.name).join(', ')}. ` +
				`Note: any Alarms & Conditions events from this server will be attributed to '${compositeDevice.name}' (the group's primary device) — see GitHub issue #11.`
			);
		}

		for (const m of members) {
			this.clients.set(m.name, client);
			this.sessions.set(m.name, sessionWrapper);
			this.deviceGroupKey.set(m.name, groupKey);
		}

		return sessionWrapper;
	}

	/**
	 * Removes a group's tracking so the next connectDevice() call for it
	 * rebuilds a fresh session, WITHOUT gracefully disconnecting — the
	 * connection is already dead/closing when this is called (from
	 * attemptReconnect(), right before it reconnects). Does not touch
	 * connectInFlight: attemptReconnect()'s own subsequent connectDevice()
	 * call is what (re)populates it. See GitHub issue #11.
	 */
	private invalidateGroupForReconnect(groupKey: string): void {
		const group = this.groups.get(groupKey);
		if (!group) return;
		this.groups.delete(groupKey);
		for (const name of group.memberDeviceNames) {
			this.clients.delete(name);
			this.sessions.delete(name);
		}
	}

	private async doConnectDevice(device: OPCUADeviceConfig, nodeIdToDevice: Map<string, OPCUADeviceConfig>): Promise<OPCUASession> {
		// TEMPORARY diagnostics — see diagnostics.ts.
		this.diagnostics.recordConnectAttempt(device.name, device.connection.endpointUrl, device.connection.useSubscription);

		const runtimeClient = new OPCUADeviceClient(device, this.logger, {
			minRetryDelay: this.MIN_RETRY_DELAY,
			maxReadRetries: this.MAX_READ_RETRIES,
			readRetryDelayMs: this.READ_RETRY_DELAY,
		});

		// NOTE: this.clients/this.sessions are intentionally NOT populated, and
		// setupConnectionHandlers/setupSessionHandlers are intentionally NOT called,
		// until this method is about to return successfully (see the two `commitSession()`
		// call sites below). Registering those event handlers early used to mean a session
		// that later failed NodeID validation (thrown a few lines down) was abandoned by
		// this method but left with live 'close'/'session_closed' listeners still attached —
		// those listeners would independently call scheduleReconnect() on the orphaned
		// sessionWrapper, which is untracked anywhere else, so it could never be cancelled.
		// Every failed reconnect attempt leaked one more of these zombie reconnect loops,
		// which is why devices with stale NodeIDs were observed retrying every few
		// milliseconds instead of respecting MIN_RETRY_DELAY: dozens of independent orphaned
		// loops running concurrently, each individually backing off correctly.
		const commitSession = (sessionWrapper: OPCUASession) => {
			this.clients.set(device.name, runtimeClient);
			this.sessions.set(device.name, sessionWrapper);
			this.setupConnectionHandlers(device, sessionWrapper);
			this.setupSessionHandlers(device, sessionWrapper);
		};

		try {
			await runtimeClient.connect();
			const sessionWrapper = runtimeClient.getSessionWrapper();
			if (!sessionWrapper?.session) {
				throw new Error(`Failed to establish OPC-UA session for ${device.name}`);
			}

			const session = sessionWrapper.session;

			// TEMPORARY diagnostics — see diagnostics.ts.
			this.diagnostics.recordSessionEstablished(device.name, session.sessionId?.toString() ?? null);

			// Resolve human-readable display name for this device.
			// Only set when explicitly configured via metadata.displayName — do NOT read ns=0;i=2253
			// (the OPC-UA Server root object) because its DisplayName is always "Server" per the spec
			// and is unrelated to any device or device being polled.
			const configDisplayName = device.metadata?.displayName;
			if (configDisplayName?.trim()) {
				this.resolvedDeviceNames.set(device.name, configDisplayName.trim());
			}

			// No data points configured — trigger auto-browse via rediscovery rather than failing.
			// This self-heals endpoints that were added via discovery without validate:true.
			if (!device.dataPoints || device.dataPoints.length === 0) {
				const now = Date.now();
				const lastEmitted = this.lastRediscoveryNeeded.get(device.name) ?? 0;
				if (now - lastEmitted >= this.REDISCOVERY_COOLDOWN_MS) {
					this.lastRediscoveryNeeded.set(device.name, now);
					this.logger.warn(`OPC-UA device ${device.name} has no data points configured — triggering auto-browse`, {
						deviceName: device.name,
						endpointUrl: device.connection.endpointUrl,
					});
					this.emit('rediscovery-needed', {
						deviceName: device.name,
						protocol: 'opcua',
						endpointUrl: device.connection.endpointUrl,
						connection: device.connection,
					});
				}
				// Session is genuinely usable (connected, just nothing to poll yet) — commit it.
				commitSession(sessionWrapper);
				return sessionWrapper;
			}

			// Validate NodeIDs before creating subscription or reads
			const { valid: validDataPoints, invalid: invalidNodeIds } = await this.validateNodeIds(
				session,
				device.dataPoints,
				device.name
			);

			// Cache validated NodeIDs (only metrics)
			validDataPoints.forEach(dp => sessionWrapper.validatedNodes.add(dp.nodeId));

			// TEMPORARY diagnostics — see diagnostics.ts.
			this.diagnostics.recordValidatedNodes(device.name, validDataPoints.length);

			// Warn if some nodes are invalid
			if (invalidNodeIds.length > 0) {
				this.logger.warn(`Some NodeIDs are invalid and will be skipped`, {
					deviceName: device.name,
					invalidCount: invalidNodeIds.length,
					totalCount: device.dataPoints.length,
					invalidNodes: invalidNodeIds
				});
			}

			// Detect OPC-UA server profile change: if ≥80% of configured nodes fail, the server
			// likely switched to a different profile (e.g., OPC-UA simulator hot-reload).
			// Emit 'rediscovery-needed' so the agent can re-browse the server and update the DB.
			// Throttled per device to avoid flooding discovery when the server is restarting.
			const totalConfigured = device.dataPoints.length;
			if (totalConfigured > 0 && invalidNodeIds.length / totalConfigured >= 0.8) {
				const now = Date.now();
				const lastEmitted = this.lastRediscoveryNeeded.get(device.name) ?? 0;
				if (now - lastEmitted >= this.REDISCOVERY_COOLDOWN_MS) {
					this.lastRediscoveryNeeded.set(device.name, now);
					const failurePct = Math.round((invalidNodeIds.length / totalConfigured) * 100);
					this.logger.warn(
						`High NodeID failure rate (${failurePct}% of ${totalConfigured} nodes invalid) - OPC-UA server may have a different profile. Requesting rediscovery.`,
						{
							deviceName: device.name,
							endpointUrl: device.connection.endpointUrl,
							invalidCount: invalidNodeIds.length,
							totalCount: totalConfigured
						}
					);
					this.emit('rediscovery-needed', {
						deviceName: device.name,
						protocol: 'opcua',
						endpointUrl: device.connection.endpointUrl,
						connection: device.connection,
					});
				}
			}

			// Log classification summary
			const metadataCount = device.dataPoints.filter(dp => 
				(dp).nodeType === 'metadata'
			).length;
      
			this.logger.debug(`Node classification summary for ${device.name}`, {
				total: device.dataPoints.length,
				metrics: validDataPoints.length,
				metadata: metadataCount,
				invalid: invalidNodeIds.length
			});

			// If all metric nodes are invalid but we have metadata, that's ok (metadata-only device)
			if (validDataPoints.length === 0 && metadataCount === 0) {
				throw new Error(`All NodeIDs failed validation for device ${device.name}. Possibly no data points discovered for this device.`);
			}

			// Read metadata nodes once on connect (separate from time-series)
			await this.readMetadata(session, device.dataPoints, device.name);

			// Prefer the friendly device name already captured at discovery time
			// (discovery.ts's folderDeviceName — the browseName of the folder that
			// owns each node's DeviceUUID marker) — free, no network round trip,
			// and correct regardless of NodeId shape. Only fall back to the
			// live parent-DisplayName browse below (which relies on parsing a
			// path-style NodeId — see deriveParentNodeId) for nodes that don't
			// have one, e.g. servers discovered before this field existed, or
			// third-party servers this app doesn't control discovery for.
			for (const dp of validDataPoints) {
				if (dp.device_name?.trim()) {
					this.resolvedNodeDisplayNames.set(dp.nodeId, dp.device_name.trim());
				}
			}

			// Read per-node DisplayNames from parent device folder nodes.
			// Allows OPC-UA servers (e.g. simulator profiles with a "displayName" field) to
			// advertise human-readable names per device group. These override the raw endpoint
			// name when building the device_name in readings. Batched in a single read call.
			const dataPointsNeedingBrowseLookup = validDataPoints.filter(dp => !this.resolvedNodeDisplayNames.has(dp.nodeId));
			if (dataPointsNeedingBrowseLookup.length > 0) {
				const nodeToParent = new Map<string, string>();
				for (const dp of dataPointsNeedingBrowseLookup) {
					const parentId = this.deriveParentNodeId(dp.nodeId);
					if (parentId) nodeToParent.set(dp.nodeId, parentId);
				}
				if (nodeToParent.size > 0) {
					const uniqueParents = [...new Set(nodeToParent.values())];
					const parentToChildren = new Map<string, string[]>();
					for (const [nodeId, parentId] of nodeToParent) {
						if (!parentToChildren.has(parentId)) parentToChildren.set(parentId, []);
            parentToChildren.get(parentId)!.push(nodeId);
					}
					try {
						const readResults = await session.read(
							uniqueParents.map(parentId => ({ nodeId: parentId, attributeId: AttributeIds.DisplayName }))
						);
						readResults.forEach((result, i) => {
							const text = result?.value?.value?.text;
							if (text && typeof text === 'string' && text.trim()) {
								for (const nodeId of parentToChildren.get(uniqueParents[i]) ?? []) {
									this.resolvedNodeDisplayNames.set(nodeId, text.trim());
								}
								this.logger.debug(`Resolved per-node DisplayName for ${uniqueParents[i]}: "${text.trim()}"`);
							}
						});
					} catch {
						// Non-fatal: per-node names unavailable, falls back to endpoint name or device.name
					}
				}
			}

			// Create subscription if enabled (real-time streaming)
			if (device.connection.useSubscription && validDataPoints.length > 0) {
				try {
					await this.createSubscription(device.name, device, sessionWrapper, nodeIdToDevice);
					this.logger.debug(`Subscription mode enabled for ${device.name} - using real-time streaming`);
				} catch (error) {
					this.logger.error(`Failed to create subscription for ${device.name}: ${error}`);
					this.logger.warn(`Falling back to polling mode for ${device.name}`);
					// TEMPORARY diagnostics — see diagnostics.ts.
					this.diagnostics.recordSubscriptionResult(device.name, false, [], error instanceof Error ? error.message : String(error));
					this.diagnostics.recordPollingFallback(device.name);
				}
			}

			// Everything up to here can still throw (metadata reads, etc.) without leaking a
			// listener-carrying session — commit only now that initialization has fully succeeded.
			commitSession(sessionWrapper);
			// TEMPORARY diagnostics — see diagnostics.ts.
			this.diagnostics.logAggregateSnapshot(this.sessions);
			return sessionWrapper;
		} catch (error) {
			// Safe unconditionally: commitSession() above is the only place that attaches
			// 'close'/'session_closed' listeners, and it never ran on this path, so this
			// disconnect cannot trigger an independent, untracked reconnect loop.
			await runtimeClient.disconnect().catch(() => {});
			throw error;
		}
	}

	/**
   * Setup connection event handlers for automatic reconnection
   * Handles connection_lost, backoff, close, and abort events
   */
	private setupConnectionHandlers(device: OPCUADeviceConfig, sessionWrapper: OPCUASession): void {
		const { client } = sessionWrapper;
    
		// Connection lost - server unavailable or network issue
		client.on('connection_lost', () => {
			this.logger.warn(`Connection lost to OPC-UA device: ${device.name}`);
			this.emit('device-disconnected', device.name);
			this.scheduleReconnect(device, sessionWrapper, 'connection_lost');
		});
    
		// Backoff event - client is retrying internally
		client.on('backoff', (retry: number, delay: number) => {
			this.logger.warn(`OPC-UA client backoff for ${device.name}`, {
				retry,
				delayMs: delay,
				reason: 'internal_retry'
			});
		});
    
		// Close event - client connection closed
		client.on('close', () => {
			if (!sessionWrapper.reconnecting) {
				this.logger.warn(`OPC-UA client closed for ${device.name}`);
				this.scheduleReconnect(device, sessionWrapper, 'close');
			}
		});
    
		// Abort event - connection attempt failed
		client.on('abort', () => {
			this.logger.error(`OPC-UA connection aborted for ${device.name}`);
			this.scheduleReconnect(device, sessionWrapper, 'abort');
		});
    
		// Keep-alive failure - session timeout
		client.on('keepalive_failure', () => {
			this.logger.warn(`Keep-alive failure for ${device.name}`);
			this.scheduleReconnect(device, sessionWrapper, 'keepalive_failure');
		});
	}
  
	/**
   * Setup session event handlers for keep-alive monitoring
   * Detects when server silently closes session or keep-alive fails
   */
	private setupSessionHandlers(device: OPCUADeviceConfig, sessionWrapper: OPCUASession): void {
		const { session } = sessionWrapper;
    
		if (!session) {
			return;
		}
    
		// Session closed by server - session is now invalid
		session.on('session_closed', () => {
			this.logger.warn(`OPC-UA session closed by server for ${device.name}`, {
				reason: 'session_closed_event',
				note: 'Session invalidated by server'
			});
			this.scheduleReconnect(device, sessionWrapper, 'session_closed');
		});
    
		// Keep-alive success - session is healthy
		session.on('keepalive', () => {
			this.logger.debug(`Keep-alive successful for ${device.name}`);
			// Session is healthy, no action needed
		});
    
		// Keep-alive failure - session may be dead
		session.on('keepalive_failure', () => {
			this.logger.error(`Session keep-alive failure for ${device.name}`, {
				reason: 'keepalive_failure_event',
				note: 'Session may be invalid, reconnecting'
			});
			this.scheduleReconnect(device, sessionWrapper, 'session_keepalive_failure');
		});
	}
  
	/**
   * Schedule reconnection with exponential backoff
   */
	private scheduleReconnect(device: OPCUADeviceConfig, sessionWrapper: OPCUASession, reason: string): void {
		// Skip if already reconnecting
		if (sessionWrapper.reconnecting) {
			return;
		}
    
		sessionWrapper.reconnecting = true;
		sessionWrapper.consecutiveFailures = Math.min(
			sessionWrapper.consecutiveFailures + 1,
			this.MAX_RETRY_ATTEMPTS
		);
    
		// Calculate exponential backoff delay
		let delay = Math.min(
			sessionWrapper.currentRetryDelay,
			this.MAX_RETRY_DELAY
		);
    
		// PERFORMANCE: Add random jitter (0-500ms) to prevent thundering herd
		// When 50+ devices reconnect simultaneously:
		// - CPU spikes from validation/subscription bursts
		// - Downstream event-storm pressure
		// - Network congestion
		// Jitter staggers reconnects to smooth out load
		const jitter = Math.random() * 500;
		delay += jitter;
    
		this.logger.debug(`Scheduling reconnect for ${device.name}`, {
			reason,
			baseDelayMs: sessionWrapper.currentRetryDelay,
			jitterMs: Math.round(jitter),
			totalDelayMs: Math.round(delay),
			consecutiveFailures: sessionWrapper.consecutiveFailures,
			maxRetryDelay: this.MAX_RETRY_DELAY
		});
    
		// Clear existing timer if any
		if (sessionWrapper.reconnectTimer) {
			clearTimeout(sessionWrapper.reconnectTimer);
		}
    
		// Schedule reconnection attempt
		sessionWrapper.reconnectTimer = setTimeout(async () => {
			await this.attemptReconnect(device, sessionWrapper);
		}, delay);
    
		// Increase delay for next attempt (exponential backoff)
		sessionWrapper.currentRetryDelay = Math.min(
			sessionWrapper.currentRetryDelay * 2,
			this.MAX_RETRY_DELAY
		);
	}
  
	/**
   * Attempt to reconnect to OPC-UA device
   */
	private async attemptReconnect(device: OPCUADeviceConfig, sessionWrapper: OPCUASession): Promise<void> {
		this.logger.debug(`Attempting reconnect to OPC-UA device: ${device.name}`, {
			attempt: sessionWrapper.consecutiveFailures,
			maxAttempts: this.MAX_RETRY_ATTEMPTS
		});
    
		try {
			// Clean up old client/session if they exist
			const runtimeClient = this.clients.get(device.name);
			if (runtimeClient) {
				await runtimeClient.cleanup(false);
			} else {
				await this.cleanupSession(sessionWrapper, false);
			}

			// Invalidate the whole shared-session group (not just this device
			// name) so the connectDevice() call below rebuilds a genuinely fresh
			// session for every member — without this, connectDevice()'s own
			// "a live group already exists" fast path would mistake this now-dead
			// group entry for a still-live one and return the stale session
			// without ever reconnecting. See GitHub issue #11.
			const groupKey = this.deviceGroupKey.get(device.name);
			if (groupKey) {
				this.invalidateGroupForReconnect(groupKey);
			}

			// Create new connection. connectDevice() commits the fresh client/session
			// into this.clients/this.sessions itself (see commitSession() inside it) —
			// `sessionWrapper` here (the wrapper whose event triggered this reconnect)
			// is superseded and intentionally left untouched from this point on.
			//
			// This used to copy the new client/session/subscription onto `sessionWrapper`
			// and reset its `reconnecting` flag back to false. But OPCUADeviceClient.cleanup()
			// never removes event listeners from the old client/session, so those listeners
			// (closures still bound to this now-orphaned wrapper) stayed live. Resetting
			// `reconnecting` re-armed them: any later event on the dead client/session — e.g.
			// node-opcua's own internal connectionStrategy retry — would pass the
			// `if (sessionWrapper.reconnecting) return` guard and schedule an independent
			// reconnect timer that disconnectDevice()/stop() could never find or cancel
			// (the maps only reference the current wrapper). Leaving `reconnecting` at
			// true permanently retires this wrapper instead. See GitHub issue #18.
			await this.connectDevice(device);

			this.logger.debug(`Reconnected successfully to ${device.name}`);
			this.emit('device-connected', device.name, device.dataPoints);
      
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Reconnection failed for ${device.name}: ${errorMessage}`);
			this.emit('device-error', device.name, error as Error);
      
			// Check if we've exceeded max attempts
			if (sessionWrapper.consecutiveFailures >= this.MAX_RETRY_ATTEMPTS) {
				this.logger.error(`Max reconnection attempts reached for ${device.name}`, {
					maxAttempts: this.MAX_RETRY_ATTEMPTS,
					note: 'Will retry at max delay interval'
				});
			}
      
			// Schedule next retry
			sessionWrapper.reconnecting = false; // Allow scheduleReconnect to run
			this.scheduleReconnect(device, sessionWrapper, 'reconnect_failed');
		}
	}
  
	/**
   * Clean up session and client without removing from sessions map
   */
	private async cleanupSession(sessionWrapper: OPCUASession, clearTimer: boolean = true): Promise<void> {
		// Clear reconnect timer
		if (clearTimer && sessionWrapper.reconnectTimer) {
			clearTimeout(sessionWrapper.reconnectTimer);
			sessionWrapper.reconnectTimer = undefined;
		}
    
		try {
			// Clear validated nodes cache
			sessionWrapper.validatedNodes.clear();
      
			// Clear monitored items
			sessionWrapper.monitoredItems.clear();
      
			// Close all subscriptions
			for (const subscription of sessionWrapper.subscriptions) {
				try {
					await subscription.terminate();
				} catch (_error) {
					// Ignore individual subscription errors
				}
			}
			sessionWrapper.subscriptions = [];
      
			// Close legacy subscription field
			if (sessionWrapper.subscription) {
				try {
					await sessionWrapper.subscription.terminate();
				} catch (_error) {
					// Ignore
				}
				sessionWrapper.subscription = null;
			}
      
			// Close session
			if (sessionWrapper.session) {
				await sessionWrapper.session.close();
				sessionWrapper.session = null;
			}
      
			// Disconnect client
			if (sessionWrapper.client) {
				await sessionWrapper.client.disconnect();
			}
		} catch (error) {
			// Ignore cleanup errors
			this.logger.debug(`Error during session cleanup: ${error}`);
		}
	}

	/**
   * Disconnects from an OPC-UA device
   * Closes session and client connection
   * 
   * @param deviceName - Name of device to disconnect
   */
	protected async disconnectDevice(deviceName: string): Promise<void> {
		const groupKey = this.deviceGroupKey.get(deviceName);
		const group = groupKey ? this.groups.get(groupKey) : undefined;

		if (!group) {
			// Never connected, or already fully torn down — nothing to do.
			// Defensively clears any stray per-device-only entries too.
			this.clients.delete(deviceName);
			this.sessions.delete(deviceName);
			this.deviceGroupKey.delete(deviceName);
			return;
		}

		this.logger.debug(`Disconnecting OPC-UA device: ${deviceName}`);

		// Synchronous removal — no `await` before this point — so N parallel
		// disconnectDevice() calls for siblings in the SAME group (BaseProtocolAdapter's
		// stop() disconnects every device via Promise.all, not sequentially) can't
		// interleave on this check: each call's Set.delete()+size-check runs to
		// completion before the event loop can hand control to another call's
		// continuation. See GitHub issue #11.
		group.memberDeviceNames.delete(deviceName);
		this.clients.delete(deviceName);
		this.sessions.delete(deviceName);
		this.deviceGroupKey.delete(deviceName);
		this.resolvedDeviceNames.delete(deviceName);
		// Clean up per-node display names for this device's own data points —
		// safe even with a shared session, since this only clears this device's
		// own cache entries, not anything belonging to sibling group members.
		const deviceConfig = this.devices.get(deviceName) as OPCUADeviceConfig | undefined;
		if (deviceConfig) {
			for (const dp of deviceConfig.dataPoints) {
				this.resolvedNodeDisplayNames.delete(dp.nodeId);
			}
		}

		if (group.memberDeviceNames.size > 0) {
			// Siblings still active on this shared session — leave it up.
			this.logger.debug(`OPC-UA device ${deviceName} left shared session group (${group.memberDeviceNames.size} member(s) remain)`);
			return;
		}

		await this.teardownGroup(group);
	}

	/**
	 * Actually tears down a shared session — only once every member device has
	 * disconnected. Guarded by `tornDown` so concurrent last-member disconnects
	 * (or a disconnect racing a reconnect's own invalidateGroupForReconnect())
	 * can't double-terminate the same underlying client/session.
	 * See GitHub issue #11.
	 */
	private async teardownGroup(group: OPCUAConnectionGroup): Promise<void> {
		if (group.tornDown) {
			return;
		}
		group.tornDown = true;
		this.groups.delete(group.key);

		// Stop reconnection attempts. `reconnecting=true` is what blocks
		// scheduleReconnect() (see its guard at the top) — setting it to `false`
		// here (as this used to) does the opposite of "stop": the close/session_closed
		// events that client.disconnect() below emits during its own graceful
		// teardown would then pass the guard and schedule a new reconnect timer
		// while shutdown is in progress. See GitHub issue #18.
		group.session.reconnecting = true;

		try {
			await group.client.disconnect();
			this.logger.debug(`Disconnected shared OPC-UA session for group: ${group.key}`);
		} catch (error) {
			this.logger.error(`Error disconnecting OPC-UA group ${group.key}: ${error}`);
		}
	}

	/**
   * Reads data from an OPC-UA device
   * Reads all configured data points and converts to deviceDataPoint format
   * 
   * @param deviceName - Name of device to read
   * @param device - Device configuration
   * @returns Array of device data points
   */
	protected async readDeviceData(
		deviceName: string,
		device: OPCUADeviceConfig
	): Promise<DeviceDataPoint[]> {
		const runtimeClient = this.clients.get(deviceName);
		if (!runtimeClient) {
			throw new Error(`No OPC-UA runtime client for device: ${deviceName}`);
		}

		const sessionWrapper = this.sessions.get(deviceName);
		if (!sessionWrapper?.session) {
			throw new Error(`No active session for device: ${deviceName}`);
		}

		// If subscription is active, data comes via events - skip polling
		if (sessionWrapper.subscription && device.connection.useSubscription) {
			this.logger.debug(`Subscription active for ${deviceName} - skipping poll`);
			// Keep runtime health fresh in subscription mode. Without this, lastSeen and
			// communicationQuality stay stale even when monitored item updates are flowing.
			this.recordPollResult(deviceName, true, 0, 0);
			return [];
		}

		const { dataPoints } = device;

		// Filter to only validated metric nodes (exclude metadata)
		const validDataPoints = dataPoints.filter(dp => 
			sessionWrapper.validatedNodes.has(dp.nodeId) && 
      (dp).nodeType === 'metric'
		);

		if (validDataPoints.length === 0) {
			this.logger.warn(`No valid NodeIDs to read for ${deviceName}`);
			return [];
		}

		// Build read request for validated data points only
		const nodesToRead: ReadValueIdOptions[] = validDataPoints.map((dp) => ({
			nodeId: dp.nodeId,
			attributeId: AttributeIds.Value,
		}));

		const readStartedAt = Date.now();

		// Read all nodes with automatic retry for transient errors
		const dataValues: DataValue[] = await runtimeClient.read(nodesToRead);

		// Convert to deviceDataPoint format
		const results: DeviceDataPoint[] = [];
		const timestamp = new Date().toISOString();
		let goodValueCount = 0;

		for (let i = 0; i < validDataPoints.length; i++) {
			const dp = validDataPoints[i];
			const dataValue = dataValues[i];

			// Hard gate: Never process metadata nodes
			if ((dp).nodeType !== 'metric') {
				this.logger.warn(`Blocked metadata node read: ${dp.name}`, { deviceName });
				continue;
			}

			// Check if read was successful
			if (!dataValue.statusCode.isGood()) {
				const quality = this.determineQuality(dataValue.statusCode);
				const qualityCode = this.extractQualityCode(dataValue.statusCode);
        
				this.logger.warn(
					`Failed to read ${dp.name} from ${deviceName}: ${dataValue.statusCode.description}`,
					{
						quality,
						qualityCode,
						statusCode: dataValue.statusCode.name
					}
				);
        
				results.push({
					timestamp,
					deviceName,
					deviceId: this.buildStableNodeDeviceId(device, dp),
					metric: dp.name,
					value: null,
					unit: dp.unit || '',
					quality,
					qualityCode,
					nodeType: 'metric',
					...(dp.device_uuid && { device_uuid: dp.device_uuid }),
					...((this.resolvedNodeDisplayNames.has(dp.nodeId) || this.resolvedDeviceNames.has(deviceName)) && {
						resolvedDisplayName: this.resolvedNodeDisplayNames.get(dp.nodeId) ?? this.resolvedDeviceNames.get(deviceName),
					}),
				});
				continue;
			}

			// Extract and convert value
			let value = dataValue.value.value;

			// Apply scaling and offset if configured
			if (typeof value === 'number') {
				if (dp.scalingFactor) {
					value = value * dp.scalingFactor;
				}
				if (dp.offset) {
					value = value + dp.offset;
				}
			}

			results.push({
				timestamp,
				deviceName,
				deviceId: this.buildStableNodeDeviceId(device, dp),
				metric: dp.name,
				value,
				unit: dp.unit || '',
				quality: 'GOOD' as const,
				nodeType: 'metric',
				...(dp.device_uuid && { device_uuid: dp.device_uuid }),
				...((this.resolvedNodeDisplayNames.has(dp.nodeId) || this.resolvedDeviceNames.has(deviceName)) && {
					resolvedDisplayName: this.resolvedNodeDisplayNames.get(dp.nodeId) ?? this.resolvedDeviceNames.get(deviceName),
				}),
			});

			goodValueCount++;
		}

		// Mark poll success so endpoint health reports lastSeen/connected/quality correctly.
		this.recordPollResult(deviceName, goodValueCount > 0, Date.now() - readStartedAt, goodValueCount);

		return results;
	}

	/**
   * Override start to store sessions in map
   */
	public async start(): Promise<void> {
		await super.start();
	}

	/**
   * Override stop to clean up sessions
   */
	public async stop(): Promise<void> {
		await super.stop();
		this.clients.clear();
		this.sessions.clear();
	}

	/**
	 * Finds the logical device — e.g. "AHU-1" — that owns `logicalName`,
	 * scoped to just that logical device's own data points. Many logical
	 * devices can live inside ONE configured/connected endpoint (see
	 * buildCompositeDevice(); DeviceModel.syncFromEndpoint() groups the exact
	 * same way for the admin UI's Devices grid), so a raw `this.devices.get()`
	 * lookup by endpoint/config name alone can never find "AHU-1" — it isn't
	 * a configured endpoint name, only a device_uuid/device_name TAG on
	 * individual data points. Matches case-insensitively against either
	 * `device_name` (the friendly display name) or `device_uuid` (the
	 * identifier column in the Devices grid). Returns the OWNING endpoint's
	 * config (for client/session lookup) plus ONLY that logical device's own
	 * data points (never the whole endpoint's merged array) — this is what
	 * prevents a same-named tag on a DIFFERENT logical device from being
	 * silently written instead. See GitHub issue #4.
	 */
	private findDeviceByLogicalName(logicalName: string): { device: OPCUADeviceConfig; dataPoints: OPCUADataPoint[] } | undefined {
		const needle = logicalName.trim().toLowerCase();
		if (!needle || !this.devices) return undefined;

		for (const config of this.devices.values()) {
			const device = config as OPCUADeviceConfig;
			const matching = device.dataPoints.filter((dp) =>
				(dp.device_name && dp.device_name.trim().toLowerCase() === needle) ||
				(dp.device_uuid && dp.device_uuid.trim().toLowerCase() === needle)
			);
			if (matching.length > 0) {
				return { device, dataPoints: matching };
			}
		}
		return undefined;
	}

	/**
	 * Does this adapter recognize `name` as a device — either a configured
	 * endpoint/connection name, or a logical per-tag device name (see
	 * findDeviceByLogicalName())? Used by write-dispatcher.ts to resolve
	 * device ownership for commands before dispatching a write.
	 */
	public ownsDeviceName(name: string): boolean {
		return (this.devices?.has(name) ?? false) || this.findDeviceByLogicalName(name) !== undefined;
	}

	/**
	 * Write a value to an OPC-UA node for a given device.
	 * `deviceName` may be a configured endpoint/connection name, or a logical
	 * per-tag device name like "AHU-1" (see findDeviceByLogicalName()).
	 * `target` can be either a data point name or a full nodeId.
	 */
	public async writeNode(
		deviceName: string,
		target: string,
		value: number | boolean | string,
		logicalIdentifier?: string
	): Promise<void> {
		let device = this.devices.get(deviceName) as OPCUADeviceConfig | undefined;
		let scopedDataPoints: OPCUADataPoint[] | undefined;

		// Precise path: the caller (write-dispatcher.ts) already resolved the
		// exact owning endpoint AND the specific logical device's raw
		// device_uuid via the `devices` table — scope directly to it, no
		// name-matching ambiguity possible, even if two DIFFERENT logical
		// devices on this same endpoint share a display name. See GitHub
		// issue #4 follow-up.
		if (device && logicalIdentifier) {
			const needle = logicalIdentifier.trim().toLowerCase();
			scopedDataPoints = device.dataPoints.filter((dp) => (dp.device_uuid ?? '').trim().toLowerCase() === needle);
			if (scopedDataPoints.length === 0) {
				throw new Error(`Logical device not found on ${deviceName}: ${logicalIdentifier}`);
			}
		}

		if (!device) {
			const logical = this.findDeviceByLogicalName(deviceName);
			if (logical) {
				device = logical.device;
				scopedDataPoints = logical.dataPoints;
			}
		}

		if (!device) {
			throw new Error(`Device not found: ${deviceName}`);
		}

		// Client/session are keyed by the owning endpoint's OWN configured
		// name (device.name) — never the logical name passed in, which isn't
		// a key in these maps at all.
		const runtimeClient = this.clients.get(device.name);
		if (!runtimeClient?.isConnected()) {
			throw new Error(`Device ${deviceName} is not connected`);
		}

		// `target` matches the metric `name` (lowercased, prefix-truncated at
		// the first `_` per discovery.ts), the raw nodeId, or the node's own
		// unmodified `browseName` as reported by the server (e.g.
		// "SpaceTemp_device1") — command producers shouldn't need to know
		// discovery's internal name-shortening convention to write to a point
		// they can see published or displayed.
		const candidatePoints = scopedDataPoints ?? device.dataPoints;
		const dataPoint = candidatePoints.find((dp) => dp.name === target || dp.nodeId === target || dp.browseName === target);
		if (!dataPoint) {
			throw new Error(`Node not found on device ${deviceName}: ${target}`);
		}

		if (!dataPoint.writable) {
			throw new Error(`Node is not writable: ${dataPoint.name} (${dataPoint.nodeId})`);
		}

		await runtimeClient.write(dataPoint.nodeId, value);
	}
}
