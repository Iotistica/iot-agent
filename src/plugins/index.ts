/**
 * Protocol adapter manager.
 */

import { EventEmitter } from "events";
import { type AgentLogger } from "../logging/agent-logger.js";
import { ModbusAdapter } from "./modbus/adapter.js";
import { type ModbusAdapterConfig, normalizeModbusRegisters } from "./modbus/types.js";
import { MqttAdapter } from "./mqtt/adapter.js";
import { type MqttAdapterConfig } from "./mqtt/types.js";
import { SocketServer } from "../core/socket-server.js";
import {
	type DeviceDataPoint,
	type ExternalPluginConfig,
	type IProtocolAdapter,
	type ProtocolAdapterStarter,
	type SocketOutput,
} from "./types.js";
import { PluginLoader } from "./plugin-loader.js";
import { EndpointOutputModel } from "../db/models/endpoint-outputs.model.js";
import { deviceNameSuffixFor, toDeviceUuid } from "../db/models/device.model.js";
import { EndpointModel } from "../db/models/endpoint.model.js";
import { DeviceModel } from "../db/models/device.model.js";
import { encodeIfUuid } from "../mqtt/codec.js";

// Type-only import.
import type { OPCUAAdapterConfig } from "./opcua/types.js";
import { OPCUAConnectionSchema } from "./opcua/types.js";
import { BACnetAdapter } from "./bacnet/adapter.js";
import { type BACnetAdapterConfig } from "./bacnet/types.js";

export interface AdapterConfig {
	modbus?: { enabled: boolean; config?: ModbusAdapterConfig };
	can?: { enabled: boolean };
	opcua?: { enabled: boolean; config?: OPCUAAdapterConfig };
	snmp?: { enabled: boolean };
	mqtt?: { enabled: boolean; config?: MqttAdapterConfig };
	bacnet?: { enabled: boolean; config?: BACnetAdapterConfig };
	plugins?: ExternalPluginConfig[];
}

/**
 * Groups a connection's configured data points by which logical device each
 * one actually belongs to, for declaring device schemas to schema drift.
 *
 * One "device" in adapter/config terms can be a single connection spanning
 * many logical devices — e.g. OPC-UA: one server connection whose
 * dataPoints cover every AHU/BMS/Boiler/etc., each data point carrying its
 * own `device_name` for the folder it actually belongs to (see
 * OPCUADataPointSchema.device_name). Declaring the whole flat list under the
 * connection's own name (`fallbackDeviceName`) would land every logical
 * device's fields in one bucket that doesn't correspond to anything schema
 * drift actually tracks — each data point's own device_name must be used
 * when present. Falls back to `fallbackDeviceName` for data points with no
 * device_name of their own — true single-device sources (most Modbus,
 * per-device BACnet), where the connection name already is the device.
 */
export function groupFieldNamesByOwningDevice(
	fallbackDeviceName: string,
	dataPoints: unknown[],
	onConflict?: (owner: string, keptUuid: string, ignoredUuid: string) => void,
): Map<string, { fields: string[]; deviceUuid?: string }> {
	const fieldsByDevice = new Map<string, { fields: string[]; deviceUuid?: string }>();

	for (const dp of dataPoints) {
		if (!dp || typeof dp !== "object") continue;
		const fieldName = (dp as { name?: unknown }).name;
		if (typeof fieldName !== "string" || fieldName.length === 0) continue;

		const ownerRaw = (dp as { device_name?: unknown }).device_name;
		const owner = typeof ownerRaw === "string" && ownerRaw.length > 0 ? ownerRaw : fallbackDeviceName;
		const deviceUuidRaw = (dp as { device_uuid?: unknown }).device_uuid;
		const deviceUuid = typeof deviceUuidRaw === "string" && deviceUuidRaw.length > 0 ? deviceUuidRaw : undefined;

		const existing = fieldsByDevice.get(owner);
		if (existing) {
			existing.fields.push(fieldName);
			if (!existing.deviceUuid && deviceUuid) {
				existing.deviceUuid = deviceUuid;
			} else if (existing.deviceUuid && deviceUuid && existing.deviceUuid !== deviceUuid) {
				// Contradictory source data: two data points claim the same
				// owning device name but report different device_uuid tags —
				// should be impossible for well-formed discovery output (one
				// DeviceUUID marker per device folder), so this is reported
				// rather than silently resolved either way. First-seen wins
				// deterministically; the conflict itself is never swallowed.
				onConflict?.(owner, existing.deviceUuid, deviceUuid);
			}
		} else {
			fieldsByDevice.set(owner, { fields: [fieldName], deviceUuid });
		}
	}

	return fieldsByDevice;
}

/**
 * Resolves the same enriched display deviceName a reading would get, given
 * only the raw identity fields (no full DeviceDataPoint needed) — shared by
 * AdapterManager's live-telemetry enrichment (enrichWithEndpointUuid) and its
 * schema-declaration path (the device-connected handler), so both land in
 * the same downstream device bucket for the same physical device. A
 * standalone, exported function (not a class method) for the same reason
 * groupFieldNamesByOwningDevice is above it: this is the core identity logic
 * and needs to be directly unit-testable.
 *
 * Returns undefined only when there's neither a source-provided device
 * identity (sourceDeviceUuid) nor an endpoint UUID on file for this device
 * name — matching enrichWithEndpointUuid's "leave unchanged" behavior for
 * that case.
 */
export function resolveEnrichedDeviceName(
	deviceName: string,
	resolvedDisplayName: string | undefined,
	sourceDeviceUuid: string | undefined,
	endpointUuidByName: Map<string, string>,
): { deviceName: string; endpoint_uuid?: string; device_uuid: string } | undefined {
	const endpointUuid = endpointUuidByName.get(deviceName);

	// endpointUuidByName is keyed by the shared connection's own name (e.g.
	// "opcua"), never by an individual logical device's name (e.g.
	// "Meter-1") — so for a protocol where many physical devices share one
	// connection/endpoint row, this lookup always misses even when the
	// reading itself carries a perfectly good source-provided device
	// identity (sourceDeviceUuid). Only bail out when NEITHER is available
	// — endpoint-map availability must not gate source-provided identity.
	if (!endpointUuid && !sourceDeviceUuid) {
		return undefined;
	}

	// Prefer source-provided device_uuid, canonicalized through the same
	// conversion DeviceModel.syncFromEndpoint() uses for the `devices`
	// table's own uuid column (toDeviceUuid: passes real UUIDs through
	// unchanged, derives a stable uuidv5 hash from a non-UUID vendor tag) —
	// so a reading's device_uuid always agrees with that table's uuid for
	// the same physical device. Falls back to the endpoint's own UUID only
	// when the reading has no device-level identity of its own.
	//
	// endpoint_uuid stays best-effort here (present only when
	// endpointUuidByName has an entry for this deviceName — always true for
	// BACnet/Modbus, never true for a multi-device OPC-UA connection).
	// That's a known, documented gap, not correct final semantics:
	// device_uuid (the specific device) and endpoint_uuid (the connection it
	// is reachable through) are two different identities, and for OPC-UA
	// both are knowable in principle — the connection's own UUID already
	// exists in EndpointModel, it's just not resolvable from this
	// function's current inputs (only the logical device's name, not the
	// connection's). Properly resolving endpoint_uuid independently of this
	// device-name-keyed map is a follow-up, not something to treat as
	// already solved here.
	const device_uuid = sourceDeviceUuid ? toDeviceUuid(sourceDeviceUuid) : endpointUuid!;

	// Build a stable display name suffix with device UUID. deviceNameSuffixFor()
	// (src/db/models/device.model.ts) truncates real UUIDs to 8 hex chars for
	// readability but keeps non-UUID human-readable identifiers (e.g. the
	// OPC UA simulator's "lighting-f10") in full, since truncating those
	// collides whenever multiple devices share a common prefix — except when
	// that non-UUID identifier is itself just the display name restated
	// (e.g. device_uuid "vav-f9c" against display name "VAV-F9-C"), in which
	// case it adds no disambiguating information and is dropped instead of
	// producing "VAV-F9-C-vavf9c". Must use the same helper as device.model.ts's
	// device Name — a mismatch would make it impossible to correlate UI device
	// rows with their own telemetry.
	const displayBase = (resolvedDisplayName || deviceName).replace(/^(?:iotistica_){2,}/i, "iotistica_");
	const uuidSuffix = deviceNameSuffixFor(displayBase, device_uuid);
	const finalDeviceName =
		uuidSuffix.length > 0 ? `${displayBase}-${uuidSuffix}` : displayBase;

	return { deviceName: finalDeviceName, endpoint_uuid: endpointUuid, device_uuid };
}

export class AdapterManager extends EventEmitter {
	private adapters: Map<string, IProtocolAdapter> = new Map();
	private socketServers: Map<string, SocketServer> = new Map();
	private adapterStarters: Map<string, ProtocolAdapterStarter> = new Map();
	// groupName -> protocol, so reloadAdapterGroup() can find every running group
	// (single-instance and multi-instance) that belongs to one protocol without
	// touching adapters for other protocols.
	private groupProtocol: Map<string, string> = new Map();
	private protocolEnabledOverrides: Map<string, boolean> = new Map();
	// Shared endpoint UUID lookup for MQTT hot-reloads.
	private mqttEndpointUuidByName: Map<string, string> = new Map();
	// Throttles lastSeenAt DB writes per device name — see wireAdapterEvents's
	// "data" handler. A protocol that emits one 'data' event per changed value
	// (OPC-UA subscriptions) rather than one batched event per poll (BACnet,
	// Modbus) can fire hundreds of these in the same second; each write is a
	// synchronous SQLite call (EndpointModel/DeviceModel's updateLastSeenBy*
	// are `async` in name only — no real async I/O underneath), so without
	// this throttle a busy subscription can spend most of a second doing
	// redundant writes of the same timestamp to the same row.
	private lastSeenAtUpdated: Map<string, number> = new Map();
	private readonly LAST_SEEN_THROTTLE_MS = 5000;
	private config: AdapterConfig;
	private deviceUuid: string;
	private running = false;
	private pluginsLoaded = false;
	private readonly pluginLoader: PluginLoader;
	private readonly logger: {
		info(m: string): void;
		warn(m: string): void;
		error(m: string, ...a: any[]): void;
		debug(m: string, ...a: any[]): void;
	};

	private enrichWithEndpointUuid(
		dataPoints: DeviceDataPoint[],
		endpointUuidByName: Map<string, string>,
	): DeviceDataPoint[] {
		// Deliberately NOT also gated on endpointUuidByName.size === 0: a
		// reading can carry its own source-provided device identity
		// (point.device_uuid) even when the connection-level map is empty —
		// resolveEnrichedDeviceName() is the single authority on whether
		// there's enough identity to enrich a reading. Gating here too would
		// silently disable that source-provided identity, which is exactly
		// the bug this file was just fixed to stop doing.
		if (dataPoints.length === 0) {
			return dataPoints;
		}

		return dataPoints.map((point) => {
			const resolved = resolveEnrichedDeviceName(
				point.deviceName,
				point.resolvedDisplayName,
				point.device_uuid,
				endpointUuidByName,
			);
			if (!resolved) {
				return point;
			}

			return {
				...point,
				deviceName: resolved.deviceName,
				endpoint_uuid: resolved.endpoint_uuid,
				device_uuid: resolved.device_uuid,
			};
		});
	}

	/** Build a device-name to endpoint-UUID map. */
	private buildUuidMap(devices: any[]): Map<string, string> {
		const map = new Map<string, string>();
		for (const device of devices) {
			const endpointUuid =
				(typeof device.uuid === "string" && device.uuid.trim()) ||
				(typeof device.metadata?.uuid === "string" &&
					device.metadata.uuid.trim()) ||
				(typeof device.metadata?.device_uuid === "string" &&
					device.metadata.device_uuid.trim());
			if (endpointUuid && typeof device.name === "string") {
				map.set(device.name, endpointUuid);
			}
		}
		return map;
	}

	/** Load output config and start a protocol socket server. */
	private async createSocketServer(protocol: string): Promise<SocketServer> {
		const dbOutput = await EndpointOutputModel.getOutput(protocol);
		if (!dbOutput)
			throw new Error(`${protocol} output configuration not found in database`);
		const outputConfig: SocketOutput = {
			socketPath: dbOutput.socket_path,
			dataFormat: dbOutput.data_format as "json" | "csv",
			delimiter: dbOutput.delimiter,
			includeTimestamp: dbOutput.include_timestamp,
			includeDeviceName: dbOutput.include_device_name,
		};
		const socket = new SocketServer(outputConfig, this.logger);
		await socket.start();
		this.socketServers.set(protocol, socket);
		return socket;
	}

	/** Wire standard adapter events. */
	private wireAdapterEvents(
		protocol: string,
		adapter: IProtocolAdapter,
		socket: SocketServer,
		uuidMap: Map<string, string>,
	): void {
		const label = protocol.toUpperCase();
		adapter.on("started", () => this.logger.info(`${label} adapter started`));
		adapter.on("data", (dps: DeviceDataPoint[]) => {
			socket.sendData(this.enrichWithEndpointUuid(dps, uuidMap), protocol);
			// Stamp lastSeenAt for both endpoint and device tables, throttled per
			// device name (see LAST_SEEN_THROTTLE_MS above) — health freshness
			// doesn't need sub-second resolution, and each write is a synchronous
			// SQLite call that a high-frequency emitter (e.g. an OPC-UA
			// subscription firing once per changed node) could otherwise repeat
			// hundreds of times a second for no benefit beyond the first write.
			const names = [...new Set(dps.map((dp) => dp.deviceName).filter(Boolean))];
			const now = Date.now();
			for (const name of names) {
				const lastUpdated = this.lastSeenAtUpdated.get(name) ?? 0;
				if (now - lastUpdated < this.LAST_SEEN_THROTTLE_MS) {
					continue;
				}
				this.lastSeenAtUpdated.set(name, now);
				EndpointModel.updateLastSeenByName(name).catch(() => {});
				DeviceModel.updateLastSeenByEndpointName(name).catch(() => {});
			}
		});
		adapter.on("device-connected", (name: string, dataPoints?: unknown[]) => {
			this.logger.info(`${label} device connected: ${name}`);

			// TEMPORARY diagnostic — see issue #17 follow-up investigation.
			this.logger.debug(`[SCHEMA_DECLARE_DIAG] name=${name} isArray=${Array.isArray(dataPoints)} length=${Array.isArray(dataPoints) ? dataPoints.length : 'n/a'} sample=${Array.isArray(dataPoints) ? JSON.stringify(dataPoints.slice(0, 2)) : 'n/a'}`);

			// Declare each configured field's owning device's full field list to
			// schema drift — ground truth for "does this field exist," independent
			// of how often its value happens to change (fixes fields that report
			// rarely or never under COV/subscription protocols: intermittent fault
			// points, manual alarm bits nobody has toggled since the last restart —
			// see SchemaDriftDetector.declareDeviceSchema in the Pro package).
			//
			// One connection ("device" in adapter/config terms) can span many
			// logical devices — e.g. OPC-UA: a single server connection whose
			// dataPoints cover every AHU/BMS/Boiler/etc., each data point carrying
			// its own device_name for the folder it actually belongs to. Group by
			// that (falling back to the connection's own name when a data point
			// doesn't specify one — true single-device sources) instead of
			// declaring the whole flat list under the connection's name, which
			// would land every logical device's fields in one wrong bucket.
			if (Array.isArray(dataPoints) && dataPoints.length > 0) {
				const fieldsByDevice = groupFieldNamesByOwningDevice(name, dataPoints, (owner, keptUuid, ignoredUuid) => {
					this.logger.warn(
						`Conflicting device_uuid tags for owning device "${owner}": keeping "${keptUuid}", ignoring "${ignoredUuid}"`,
					);
				});

				for (const [ownerDeviceName, { fields, deviceUuid }] of fieldsByDevice) {
					// Same source-provided identity telemetry uses (see
					// resolveEnrichedDeviceName/enrichWithEndpointUuid above) — schema
					// declarations must land in the same downstream device bucket as
					// the reading data they describe, not a bucket derived from the
					// connection-level map alone.
					const resolved = resolveEnrichedDeviceName(ownerDeviceName, undefined, deviceUuid, uuidMap);
					socket.sendControl(
						{ __control: "device-schema", protocol, deviceName: resolved?.deviceName ?? ownerDeviceName, fields },
						protocol,
					);
				}
			}
		});
		adapter.on("device-disconnected", (name: string) =>
			this.logger.warn(`${label} device disconnected: ${name}`),
		);
		adapter.on("device-error", (name: string, err: Error | string) =>
			this.logger.error(
				`${label} device error [${name}]: ${err instanceof Error ? err.message : err}`,
			),
		);
		// Generic for every protocol built on BaseProtocolAdapter — each adapter's own
		// emit always carries its own canonical `protocol` field (never the group-name
		// `protocol` param this function was called with, which can differ from the real
		// protocol string when grouped), so this needs no per-protocol special-casing.
		adapter.on(
			"rediscovery-needed",
			(data: { deviceName: string; protocol?: string; endpointUrl?: string }) => {
				this.logger.warn(
					`${label} adapter requesting rediscovery for ${data.deviceName}` +
						(data.endpointUrl ? ` (endpointUrl: ${data.endpointUrl})` : ""),
				);
				this.emit("rediscovery-needed", data);
			},
		);
	}

	constructor(
		config: AdapterConfig,
		agentLogger: AgentLogger,
		deviceUuid: string,
	) {
		super();
		this.config = config;
		this.deviceUuid = deviceUuid;
		this.logger = {
			info: (m) => agentLogger.infoSync(m, { component: "Adapters" }),
			warn: (m) => agentLogger.warnSync(m, { component: "Adapters" }),
			error: (m, ...a) =>
				agentLogger.errorSync(m, a[0] instanceof Error ? a[0] : undefined, {
					component: "Adapters",
				}),
			debug: (m, ...a) => {
				if (process.env.PROTOCOL_ADAPTERS_DEBUG === "true")
					agentLogger.debugSync(m, { component: "Adapters", args: a });
			},
		};
		this.pluginLoader = new PluginLoader(agentLogger);
		this.registerBuiltInProtocolStarters();
	}

	private registerBuiltInProtocolStarters(): void {
		this.registerProtocolStarter("modbus", () => this.startModbusAdapter());
		this.registerProtocolStarter("opcua", () => this.startOPCUAAdapter());
		this.registerProtocolStarter("mqtt", () => this.startMQTTAdapter());
		this.registerProtocolStarter("bacnet", () => this.startBACnetAdapter());
	}

	private isProtocolEnabled(protocol: string): boolean {
		switch (protocol) {
			case "modbus":
				return Boolean(this.config.modbus?.enabled);
			case "opcua":
				return Boolean(this.config.opcua?.enabled);
			case "mqtt":
				return Boolean(this.config.mqtt?.enabled);
			case "bacnet":
				return Boolean(this.config.bacnet?.enabled);
			case "can":
				return Boolean(this.config.can?.enabled);
			case "snmp":
				return Boolean(this.config.snmp?.enabled);
			default:
				if (this.protocolEnabledOverrides.has(protocol)) {
					return Boolean(this.protocolEnabledOverrides.get(protocol));
				}
				return this.adapterStarters.has(protocol);
		}
	}

	public registerProtocolStarter(
		protocol: string,
		starter: ProtocolAdapterStarter,
		enabled: boolean = true,
	): void {
		const normalizedProtocol = protocol.toLowerCase();
		this.adapterStarters.set(normalizedProtocol, starter);
		this.protocolEnabledOverrides.set(normalizedProtocol, enabled);
	}

	public async attachAdapter(
		groupName: string,
		adapter: IProtocolAdapter,
		uuidMap: Map<string, string> = new Map(),
	): Promise<void> {
		const normalizedGroup = groupName.toLowerCase();
		// Extract protocol from groupName if it contains a dash (e.g., "warehouse-modbus" -> "modbus")
		const protocol = normalizedGroup.includes('-') 
			? normalizedGroup.split('-').pop()?.toLowerCase() || normalizedGroup
			: normalizedGroup;
		
		const socket = await this.createSocketServer(protocol);
		this.adapters.set(normalizedGroup, adapter);
		this.groupProtocol.set(normalizedGroup, protocol);
		this.wireAdapterEvents(normalizedGroup, adapter, socket, uuidMap);
		await adapter.start();
	}

	public buildEndpointUuidMap(devices: any[]): Map<string, string> {
		return this.buildUuidMap(devices);
	}

	/** Determine effective group name: use explicit groupName or default to protocol. */
	private getEffectiveGroupName(protocol: string, groupName?: string): string {
		if (groupName?.trim()) {
			return groupName.toLowerCase();
		}
		return protocol.toLowerCase();
	}

	private async ensureExternalPluginStartersRegistered(): Promise<void> {
		if (this.pluginsLoaded) {
			return;
		}

		await this.pluginLoader.registerFromConfig(this, this.config.plugins);
		this.pluginsLoaded = true;
	}

	/** Start all enabled protocol adapters, supporting multi-instance groups. */
	async start(): Promise<void> {
		if (this.running) return;

		await this.ensureExternalPluginStartersRegistered();

		// Load endpoints from DB and group by (protocol, groupName)
		const allEndpoints = await EndpointModel.getAll();
		const groupsByProtocol = new Map<string, Map<string, any[]>>();
		
		for (const endpoint of allEndpoints) {
			if (!groupsByProtocol.has(endpoint.protocol)) {
				groupsByProtocol.set(endpoint.protocol, new Map());
			}
			const groupName = this.getEffectiveGroupName(endpoint.protocol, endpoint.groupName);
			const protocolGroups = groupsByProtocol.get(endpoint.protocol)!;
			if (!protocolGroups.has(groupName)) {
				protocolGroups.set(groupName, []);
			}
			protocolGroups.get(groupName)!.push(endpoint);
		}

		// Start adapters for each (protocol, groupName) combination
		const builtInOrder = ["modbus", "opcua", "mqtt", "bacnet", "can", "snmp"];
		const customOrder = [...this.adapterStarters.keys()].filter(
			(protocol) => !builtInOrder.includes(protocol),
		);
		const startOrder = [...builtInOrder, ...customOrder];
		
		for (const protocol of startOrder) {
			if (!this.isProtocolEnabled(protocol)) {
				continue;
			}

			const starter = this.adapterStarters.get(protocol);
			if (!starter) {
				this.logger.warn(`${protocol.toUpperCase()} adapter not yet implemented`);
				continue;
			}

			// If endpoints exist for this protocol, start them per group
			const protocolGroups = groupsByProtocol.get(protocol);
			if (protocolGroups && protocolGroups.size > 0) {
				for (const [groupName, endpoints] of protocolGroups) {
					if (endpoints.length > 0) {
						await this.startAdapterGroup(protocol, groupName, endpoints);
					}
				}
			} else if (this.config[protocol as keyof AdapterConfig] && 
						(this.config[protocol as keyof AdapterConfig] as any)?.config) {
				// Fall back to config-based startup if no DB endpoints
				await starter();
			}
		}

		this.running = true;
		this.emit("started");
	}

	/** Start adapter for a specific (protocol, groupName) combination. */
	private async startAdapterGroup(
		protocol: string,
		groupName: string,
		endpoints: any[],
	): Promise<void> {
		try {
			this.logger.info(`Starting ${protocol.toUpperCase()} adapter group: ${groupName}`);
			
			switch (protocol.toLowerCase()) {
				case 'modbus':
					await this.startModbusAdapterGroup(groupName, endpoints);
					break;
				case 'opcua':
					await this.startOPCUAAdapterGroup(groupName, endpoints);
					break;
				case 'bacnet':
					await this.startBACnetAdapterGroup(groupName, endpoints);
					break;
				case 'mqtt':
					await this.startMQTTAdapterGroup(groupName, endpoints);
					break;
				default:
					this.logger.warn(`No group handler for protocol: ${protocol}`);
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start ${protocol.toUpperCase()} adapter group ${groupName}: ${errorMessage}`);
			// Non-fatal: one broken adapter group must not prevent other adapters or health reporting from working.
		}
	}

	/** Stop all running adapters and socket servers. */
	async stop(): Promise<void> {
		if (!this.running) return;
		for (const [, adapter] of this.adapters) {
			if (adapter && typeof adapter.stop === "function") await adapter.stop();
		}
		this.adapters.clear();
		this.groupProtocol.clear();
		for (const [, server] of this.socketServers) await server.stop();
		this.socketServers.clear();
		this.running = false;
		this.emit("stopped");
	}

	isRunning(): boolean {
		return this.running;
	}

	/** Start Modbus adapter. */
	private async startModbusAdapter(): Promise<void> {
		try {
			let modbusConfig: ModbusAdapterConfig;

			if (this.config.modbus?.config) {
				modbusConfig = this.config.modbus.config;
			} else {
				const dbDevices = await EndpointModel.getEnabled("modbus");
				modbusConfig = {
					devices: dbDevices.map(
						(d) =>
							({
								uuid: d.uuid,
								name: d.name,
								enabled: d.enabled,
								slaveId: d.connection.slaveId || 1,
								connection: d.connection as any,
								pollInterval: d.poll_interval,
								registers: normalizeModbusRegisters(d.data_points || []),
							}) as any,
					),
					logging: { level: "info", enableConsole: false, enableFile: false },
				};
			}

			const uuidMap = this.buildUuidMap(modbusConfig.devices);
			const socket = await this.createSocketServer("modbus");
			const adapter = new ModbusAdapter(modbusConfig, this.logger);
			this.adapters.set("modbus", adapter);
			this.groupProtocol.set("modbus", "modbus");
			(adapter as any)._socketServer = socket;
			this.wireAdapterEvents("modbus", adapter, socket, uuidMap);
			await adapter.start();
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start Modbus adapter: ${errorMessage}`);
			throw error;
		}
	}

	/** Start Modbus adapter group for a specific groupName. */
	private async startModbusAdapterGroup(groupName: string, endpoints: any[]): Promise<void> {
		try {
			const modbusConfig: ModbusAdapterConfig = {
				devices: endpoints.map(
					(d) =>
						({
							uuid: d.uuid,
							name: d.name,
							enabled: d.enabled,
							slaveId: d.connection.slaveId || 1,
							connection: d.connection,
							pollInterval: d.poll_interval,
							registers: normalizeModbusRegisters(d.data_points || []),
						}) as any,
				),
				logging: { level: "info", enableConsole: false, enableFile: false },
			};

			const uuidMap = this.buildUuidMap(modbusConfig.devices);
			const socket = await this.createSocketServer("modbus");
			const adapter = new ModbusAdapter(modbusConfig, this.logger);
			this.adapters.set(groupName, adapter);
			this.groupProtocol.set(groupName, "modbus");
			(adapter as any)._socketServer = socket;
			this.wireAdapterEvents(groupName, adapter, socket, uuidMap);
			await adapter.start();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start Modbus adapter group ${groupName}: ${errorMessage}`);
			throw error;
		}
	}
	/**
	 * Applies OPCUAConnectionSchema (with its Zod defaults — useSubscription,
	 * samplingInterval, publishingInterval, maxMonitoredItemsPerSubscription,
	 * queueSize, etc.) to a raw connection object loaded from the DB.
	 *
	 * Without this, `connection: d.connection` was used completely as-is: any
	 * field missing from the stored JSON (e.g. an endpoint saved before
	 * useSubscription existed) came through as `undefined`, not even the
	 * schema's own documented default — `if (device.connection.useSubscription
	 * && ...)` treats undefined exactly like false, so subscriptions were
	 * silently never attempted for such devices, no error or warning anywhere.
	 *
	 * Uses safeParse + a raw fallback rather than parse(), so one endpoint
	 * with a genuinely malformed connection (e.g. an unparseable endpointUrl)
	 * degrades to today's behavior for that device instead of throwing and
	 * aborting the whole adapter's device list.
	 */
	private normalizeOpcuaConnection(deviceName: string, rawConnection: unknown): any {
		const result = OPCUAConnectionSchema.safeParse(rawConnection);
		if (result.success) {
			return result.data;
		}
		this.logger.warn(
			`OPC-UA device ${deviceName}: connection config failed schema validation, using raw config as-is (${result.error.message})`,
		);
		return rawConnection;
	}

	private async startOPCUAAdapter(): Promise<void> {
		try {
			let opcuaDevices: any[];

			if (this.config.opcua?.config) {
				opcuaDevices = this.config.opcua.config.devices;
			} else {
				const dbDevices = await EndpointModel.getEnabled("opcua");
				opcuaDevices = dbDevices.map((d) => ({
					uuid: d.uuid,
					name: d.name,
					protocol: "opcua",
					enabled: d.enabled,
					connection: this.normalizeOpcuaConnection(d.name, d.connection),
					pollInterval: d.poll_interval,
					dataPoints: (d.data_points || []).map((dp: any) => ({
						...dp,
						dataType: dp.dataType || "number",
						scalingFactor: dp.scalingFactor || dp.scale || 1,
						offset: dp.offset || 0,
					})),
					metadata: d.metadata || {},
				}));
			}

			const uuidMap = this.buildUuidMap(opcuaDevices);
			const socket = await this.createSocketServer("opcua");
			const { OPCUAAdapter } = await import("./opcua/adapter.js");
			const adapter = new OPCUAAdapter(opcuaDevices, this.logger);
			this.adapters.set("opcua", adapter);
			this.groupProtocol.set("opcua", "opcua");
			this.wireAdapterEvents("opcua", adapter, socket, uuidMap);
			await adapter.start();
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start OPC-UA adapter: ${errorMessage}`);
			throw error;
		}
	}

	/** Start OPC UA adapter group for a specific groupName. */
	private async startOPCUAAdapterGroup(groupName: string, endpoints: any[]): Promise<void> {
		try {
			const opcuaDevices = endpoints.map((d) => ({
				uuid: d.uuid,
				name: d.name,
				enabled: d.enabled,
				connection: this.normalizeOpcuaConnection(d.name, d.connection),
				pollInterval: d.poll_interval,
				dataPoints: (d.data_points || []).map((dp: any) => ({
					...dp,
					dataType: dp.dataType || "number",
					scalingFactor: dp.scalingFactor || dp.scale || 1,
					offset: dp.offset || 0,
				})),
				metadata: d.metadata || {},
			})) as any as OPCUAAdapterConfig['devices'];

			const uuidMap = this.buildUuidMap(endpoints);
			const socket = await this.createSocketServer("opcua");
			const { OPCUAAdapter } = await import("./opcua/adapter.js");
			const adapter = new OPCUAAdapter(opcuaDevices, this.logger);
			this.adapters.set(groupName, adapter);
			this.groupProtocol.set(groupName, "opcua");
			this.wireAdapterEvents(groupName, adapter, socket, uuidMap);
			await adapter.start();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start OPC-UA adapter group ${groupName}: ${errorMessage}`);
			throw error;
		}
	}

	/** Start MQTT adapter, or hot-reload devices if already running. */
	private async startMQTTAdapter(): Promise<void> {
		try {
			let mqttConfig: MqttAdapterConfig;

			if (this.config.mqtt?.config) {
				mqttConfig = this.config.mqtt.config;
			} else {
				const dbDevices = await EndpointModel.getEnabled("mqtt");
				const brokerUrl = process.env.MQTT_BROKER_URL;
				if (!brokerUrl)
					throw new Error(
						"MQTT_BROKER_URL is required for MQTT adapter startup",
					);
				let brokerHost: string;
				let brokerPort: number;
				try {
					const url = new URL(brokerUrl);
					brokerHost = url.hostname;
					brokerPort = parseInt(url.port) || 1883;
				} catch (error) {
					throw new Error(
						`Failed to parse MQTT broker URL '${brokerUrl}': ${error}`,
					);
				}
				mqttConfig = {
					broker: {
						host: brokerHost,
						port: brokerPort,
						username: process.env.MQTT_USERNAME,
						password: process.env.MQTT_PASSWORD,
					},
					qos: 1,
					reconnect: {
						period: 1000,
						maxAttempts: 10,
						strategy: "fixed",
						maxPeriod: 1000,
						jitterRatio: 0,
					},
					devices: dbDevices.map((d) => ({
						uuid: d.uuid,
						name: d.name,
						enabled: d.enabled,
						topic: d.connection.topic
							? `${d.connection.topic}/#`
							: encodeIfUuid(d.name),
						qos: d.connection.qos || 1,
						dataType: d.connection.dataType || "float32",
						unit: d.connection.unit,
						precision: Number.isFinite((d.connection as any).precision)
							? Number((d.connection as any).precision)
							: undefined,
						metric: d.connection.metric,
						deviceId: d.connection.deviceId,
						timestampField: d.connection.timestampField,
						metrics: Array.isArray((d.connection as any).metrics)
							? (d.connection as any).metrics.map((metric: any) => ({
								field: metric.field,
								metric: metric.metric,
								unit: metric.unit,
								type: metric.type,
								precision: Number.isFinite(metric.precision)
									? Number(metric.precision)
									: undefined,
							}))
							: undefined,
						autoMetrics: Boolean((d.connection as any).autoMetrics),
						defaultUnits:
							(d.connection as any).defaultUnits &&
							typeof (d.connection as any).defaultUnits === "object"
								? Object.entries((d.connection as any).defaultUnits).reduce<
										Record<string, string>
									>((acc, [key, value]) => {
										if (
											typeof key === "string" &&
											key.trim() &&
											typeof value === "string" &&
											value.trim()
										)
											acc[key] = value;
										return acc;
									}, {})
								: undefined,
						defaultPrecisions:
							(d.connection as any).defaultPrecisions &&
							typeof (d.connection as any).defaultPrecisions === "object"
								? Object.entries(
									(d.connection as any).defaultPrecisions,
								).reduce<Record<string, number>>((acc, [key, value]) => {
									if (
										typeof key === "string" &&
											key.trim() &&
											Number.isFinite(value)
									)
										acc[key] = Number(value);
									return acc;
								}, {})
								: undefined,
						allowArrayMetrics: Boolean((d.connection as any).allowArrayMetrics),
					})),
					logging: { level: "info", enableConsole: false, enableFile: false },
				};
			}

			// Rebuild class-level UUID map in place for hot-reload event handlers.
			const newMap = this.buildUuidMap(mqttConfig.devices);
			this.mqttEndpointUuidByName.clear();
			newMap.forEach((v, k) => this.mqttEndpointUuidByName.set(k, v));

			// Hot-update subscriptions without reconnecting.
			const existingAdapter = this.adapters.get("mqtt") as
				| MqttAdapter
				| undefined;
			if (existingAdapter) {
				this.logger.info(
					"MQTT adapter already running — applying hot device update",
				);
				await existingAdapter.updateDevices(mqttConfig.devices);
				return;
			}

			const socket = await this.createSocketServer("mqtt");
			const adapter = new MqttAdapter(
				mqttConfig,
				this.logger,
				this.deviceUuid,
			);
			this.adapters.set("mqtt", adapter);
			this.groupProtocol.set("mqtt", "mqtt");
			// Use class map so handlers always see latest UUID mappings.
			this.wireAdapterEvents(
				"mqtt",
				adapter,
				socket,
				this.mqttEndpointUuidByName,
			);
			await adapter.start();
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start MQTT adapter: ${errorMessage}`);
			throw error;
		}
	}

	/** Start MQTT adapter group for a specific groupName. */
	private async startMQTTAdapterGroup(groupName: string, endpoints: any[]): Promise<void> {
		try {
			const brokerUrl = process.env.MQTT_BROKER_URL;
			if (!brokerUrl)
				throw new Error("MQTT_BROKER_URL is required for MQTT adapter startup");

			let brokerHost: string;
			let brokerPort: number;
			try {
				const url = new URL(brokerUrl);
				brokerHost = url.hostname;
				brokerPort = parseInt(url.port) || 1883;
			} catch (error) {
				throw new Error(`Failed to parse MQTT broker URL '${brokerUrl}': ${error}`);
			}

			const mqttConfig: MqttAdapterConfig = {
				broker: {
					host: brokerHost,
					port: brokerPort,
					username: process.env.MQTT_USERNAME,
					password: process.env.MQTT_PASSWORD,
				},
				qos: 1,
				reconnect: {
					period: 1000,
					maxAttempts: 10,
					strategy: "fixed",
					maxPeriod: 1000,
					jitterRatio: 0,
				},
				devices: endpoints.map((d) => ({
					name: d.name,
					enabled: d.enabled,
					topic: d.connection.topic || "#",
					qos: (d.connection.qos || 1) as 0 | 1 | 2,
					dataType: d.connection.dataType || "json",
					metric: d.connection.metric || d.name,
				})),
			};

			const uuidMap = this.buildUuidMap(endpoints);
			const socket = await this.createSocketServer("mqtt");
			const adapter = new MqttAdapter(mqttConfig, this.logger, this.deviceUuid);
			this.adapters.set(groupName, adapter);
			this.groupProtocol.set(groupName, "mqtt");
			(adapter as any)._socketServer = socket;
			this.wireAdapterEvents(groupName, adapter, socket, uuidMap);
			await adapter.start();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start MQTT adapter group ${groupName}: ${errorMessage}`);
			throw error;
		}
	}

	/** Hot-reload MQTT adapter devices without disconnecting. */
	async reloadMQTTAdapter(): Promise<void> {
		if (this.config.mqtt?.enabled) {
			await this.startMQTTAdapter();
		}
	}

	/**
	 * Stop and restart only the adapter group(s) for one protocol, leaving every
	 * other protocol's adapters running untouched. Used when reconciliation only
	 * changed endpoints of a single protocol (e.g. a poll_interval edit), so a
	 * config edit on one OPC-UA device doesn't disconnect/reconnect BACnet, Modbus,
	 * etc. Falls back to doing nothing if the protocol has no starter registered —
	 * callers should use _fullReload() instead when that's a possibility.
	 */
	async reloadAdapterGroup(protocol: string): Promise<void> {
		const normalizedProtocol = protocol.toLowerCase();

		// MQTT already supports in-place hot device updates without reconnecting
		// (startMQTTAdapter()'s existingAdapter.updateDevices() path, for the
		// default single-instance groupName) — reuse it instead of tearing the
		// client down like every other protocol below.
		if (normalizedProtocol === "mqtt") {
			(this.config as any).mqtt = { enabled: true };
			await this.startMQTTAdapter();
			return;
		}

		// Stop and remove every currently-running group belonging to this protocol
		// (covers both the single-instance default groupName===protocol case and
		// custom multi-instance group names).
		for (const [groupName, groupProtocol] of [...this.groupProtocol]) {
			if (groupProtocol !== normalizedProtocol) continue;
			const adapter = this.adapters.get(groupName);
			if (adapter && typeof adapter.stop === "function") {
				await adapter.stop();
			}
			this.adapters.delete(groupName);
			this.groupProtocol.delete(groupName);
		}

		const oldSocket = this.socketServers.get(normalizedProtocol);
		if (oldSocket) {
			await oldSocket.stop();
			this.socketServers.delete(normalizedProtocol);
		}

		const starter = this.adapterStarters.get(normalizedProtocol);
		if (!starter) return;

		// Determine live enabled-ness from the DB rather than the AdapterManager's
		// static `this.config[protocol].enabled` flag, which was only computed once
		// at construction time (initProtocolAdapters()) and goes stale — a protocol
		// with zero enabled endpoints at boot but some enabled later would otherwise
		// never start here.
		const allEndpoints = await EndpointModel.getAll();
		const groups = new Map<string, any[]>();
		for (const endpoint of allEndpoints) {
			if (endpoint.protocol !== normalizedProtocol) continue;
			const groupName = this.getEffectiveGroupName(endpoint.protocol, endpoint.groupName);
			if (!groups.has(groupName)) groups.set(groupName, []);
			groups.get(groupName)!.push(endpoint);
		}

		if (groups.size > 0) {
			(this.config as any)[normalizedProtocol] = { enabled: true };
			for (const [groupName, endpoints] of groups) {
				if (endpoints.length > 0) {
					await this.startAdapterGroup(normalizedProtocol, groupName, endpoints);
				}
			}
		} else if (
			this.config[normalizedProtocol as keyof AdapterConfig] &&
			(this.config[normalizedProtocol as keyof AdapterConfig] as any)?.config
		) {
			await starter();
		} else {
			(this.config as any)[normalizedProtocol] = { enabled: false };
		}
	}

	/** Get endpoint health across configured devices and running adapters. */
	async getAllDeviceStatuses(): Promise<Record<string, any>> {
		const health: Record<string, any> = {};

		this.logger.debug(
			`getAllDeviceStatuses called - adapters.size: ${this.adapters.size}, keys: [${Array.from(this.adapters.keys()).join(", ")}]`,
		);

		// Load all configured and discovered devices from the database.
		try {
			const allDevices = await EndpointModel.getAll();
			const stalenessThresholdMs = 24 * 60 * 60 * 1000; // 24 hours

			this.logger.debug(`Found ${allDevices.length} devices in database`);

			// Build baseline health from database state.
			for (const device of allDevices) {
				// Determine online/offline from lastSeenAt.
				const lastSeen = device.lastSeenAt ? new Date(device.lastSeenAt) : null;
				const now = Date.now();
				const isOnline =
					lastSeen && now - lastSeen.getTime() < stalenessThresholdMs;

				// SQLite stores booleans as 0/1.
				const isEnabled = Boolean(device.enabled);

				health[device.name] = {
					protocol: device.protocol,
					status: !isEnabled ? "disabled" : isOnline ? "online" : "offline",
					connected: isEnabled && isOnline,
					lastPoll: null,
					lastSeen: lastSeen?.toISOString() || null,
					errorCount: 0,
					lastError: null,
					responseTimeMs: null,
					pollSuccessRate: isEnabled && isOnline ? 1.0 : 0,
					registersUpdated: 0,
					communicationQuality: !isEnabled
						? ("disabled" as const)
						: isOnline
							? ("good" as const)
							: ("offline" as const),
				};
			}

			// Overlay runtime adapter status when available.
			for (const [protocol, adapter] of this.adapters) {
				if (adapter && typeof adapter.getDeviceStatuses === "function") {
					try {
						const statuses = adapter.getDeviceStatuses();

						this.logger.debug(
							`Adapter ${protocol} returned ${statuses?.length || 0} device statuses`,
						);

						// Update health with runtime data from adapter
						if (Array.isArray(statuses)) {
							for (const device of statuses) {
								if (health[device.deviceName]) {
									// Derive effective runtime status from fresh timestamps.
									const now = Date.now();
									const runtimeLastSeenMs = device.lastSeen
										? new Date(device.lastSeen).getTime()
										: null;
									const runtimeLastPollMs = device.lastPoll
										? new Date(device.lastPoll).getTime()
										: null;
									const hasFreshRuntimeSignal = Boolean(
										(runtimeLastSeenMs &&
											now - runtimeLastSeenMs < stalenessThresholdMs) ||
											(runtimeLastPollMs &&
												now - runtimeLastPollMs < stalenessThresholdMs),
									);

									const isEnabled =
										health[device.deviceName].status !== "disabled";
									const explicitlyOffline =
										device.communicationQuality === "offline";
									// Derive connectivity from activity, not adapter connected flag.
									const runtimeOnline = Boolean(
										hasFreshRuntimeSignal && !explicitlyOffline,
									);
									const effectiveStatus = !isEnabled
										? "disabled"
										: runtimeOnline
											? "online"
											: health[device.deviceName].status;

									health[device.deviceName] = {
										protocol,
										status: effectiveStatus,
										connected: isEnabled && runtimeOnline,
										lastPoll: device.lastPoll?.toISOString() || null,
										lastSeen: device.lastSeen?.toISOString() || null,
										errorCount: device.errorCount,
										lastError: device.lastError,
										responseTimeMs: device.responseTimeMs,
										pollSuccessRate: device.pollSuccessRate,
										registersUpdated: device.registersUpdated,
										communicationQuality: device.communicationQuality,
									};
								}
							}
						}
					} catch (error) {
						this.logger.warn(
							`Failed to get device statuses from ${protocol} adapter: ${error}`,
						);
					}
				}
			}
		} catch (error) {
			this.logger.error(`Failed to get devices from database: ${error}`);
		}

		return health;
	}

	/** Start BACnet adapter. */
	private async startBACnetAdapter(): Promise<void> {
		try {
			let bacnetConfig: BACnetAdapterConfig;

			if (this.config.bacnet?.config) {
				bacnetConfig = this.config.bacnet.config;
			} else {
				const dbDevices = await EndpointModel.getEnabled("bacnet");
				if (dbDevices.length === 0) {
					this.logger.info(
						"BACnet ADAPTER: No BACnet devices in database - skipping adapter start",
					);
					return;
				}
				this.logger.info(
					`BACnet ADAPTER: Found ${dbDevices.length} BACnet devices in database`,
				);
				bacnetConfig = {
					enabled: true,
					port: (this.config.bacnet as any)?.port || 47809,
					devices: dbDevices.map((d) => ({
						uuid: d.uuid,
						name: d.name,
						enabled: d.enabled,
						ipAddress: d.connection.ipAddress || d.connection.host,
						port: d.connection.port || 47808,
						deviceInstance: d.connection.deviceInstance || 0,
						pollIntervalMs: d.poll_interval || 5000,
						maxConcurrentReads: d.connection.maxConcurrentReads || 5,
						connectionTimeoutMs: d.connection.connectionTimeoutMs || 5000,
						retryAttempts: d.connection.retryAttempts || 3,
						retryDelayMs: d.connection.retryDelayMs || 1000,
						objects: (d.data_points || [])
							.filter((obj: any) => [
								'analog-input', 'analog-output', 'analog-value',
								'binary-input', 'binary-output', 'binary-value',
								'multi-state-input', 'multi-state-output', 'multi-state-value',
							].includes(obj.objectType))
							.map((obj: any) => ({
								name: obj.name,
								objectType: obj.objectType,
								objectInstance: obj.objectInstance,
								propertyId: obj.propertyId || 85,
								unit: obj.unit || obj.units || "",
								pollIntervalMs: obj.pollIntervalMs || 5000,
								enabled: obj.enabled !== false,
								writable: obj.writable === true,
								writeDataType: obj.writeDataType,
								writePriority: obj.writePriority || 8,
							})),
					})),
					globalPollIntervalMs:
						(this.config.bacnet as any)?.globalPollIntervalMs || 5000,
					maxConcurrentDevices:
						(this.config.bacnet as any)?.maxConcurrentDevices || 10,
				};
			}

			const uuidMap = this.buildUuidMap(bacnetConfig.devices);
			const socket = await this.createSocketServer("bacnet");
			const adapter = new BACnetAdapter(bacnetConfig, this.logger);
			this.adapters.set("bacnet", adapter);
			this.groupProtocol.set("bacnet", "bacnet");
			this.wireAdapterEvents("bacnet", adapter, socket, uuidMap);
			await adapter.start();
			this.logger.info(
				`BACnet adapter started with ${bacnetConfig.devices.length} device(s)`,
			);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start BACnet adapter: ${errorMessage}`);
			throw error;
		}
	}

	/** Start BACnet adapter group for a specific groupName. */
	private async startBACnetAdapterGroup(groupName: string, endpoints: any[]): Promise<void> {
		try {
			const bacnetConfig = {
				enabled: true,
				port: (this.config.bacnet as any)?.port || 47809,
				globalPollIntervalMs: (this.config.bacnet as any)?.globalPollIntervalMs || 5000,
				devices: endpoints.map((d) => ({
					name: d.name,
					ipAddress: d.connection.ipAddress || d.connection.host,
					port: d.connection.port || 47808,
					deviceInstance: d.connection.deviceId || d.connection.deviceInstance || 0,
					enabled: d.enabled,
					objects: (d.data_points || [])
						.filter((dp: any) => [
							'analog-input', 'analog-output', 'analog-value',
							'binary-input', 'binary-output', 'binary-value',
							'multi-state-input', 'multi-state-output', 'multi-state-value',
						].includes(dp.objectType))
						.map((dp: any) => ({
							name: dp.name || dp.objectName,
							// Carried through separately from `name` above so
							// BACnetDeviceClient.write() can match a command's pointName
							// against the device's own raw, human-visible object name too
							// (e.g. "AHU-1.SF-Run") — without this, dp.name's fallback into
							// this same field meant the raw name was never actually
							// reachable at runtime, only the sanitized identifier.
							objectName: dp.objectName,
							objectType: dp.objectType,
							objectInstance: dp.objectInstance,
							propertyId: dp.propertyId || 85,
							unit: dp.unit || dp.units || '',
							pollIntervalMs: dp.pollIntervalMs || 5000,
							enabled: dp.enabled !== false,
							writable: dp.writable === true,
							writeDataType: dp.writeDataType,
							writePriority: dp.writePriority || 8,
						})),
					pollIntervalMs: d.poll_interval || 5000,
					maxConcurrentReads: d.connection.maxConcurrentReads || 5,
					connectionTimeoutMs: d.connection.timeout || 5000,
					retryAttempts: d.connection.retryCount || 3,
					retryDelayMs: d.connection.retryDelayMs || 1000,
				})),
				maxConcurrentDevices: (this.config.bacnet as any)?.maxConcurrentDevices || 10,
			};

			const uuidMap = this.buildUuidMap(endpoints);
			const socket = await this.createSocketServer("bacnet");
			const adapter = new BACnetAdapter(bacnetConfig, this.logger);
			this.adapters.set(groupName, adapter);
			this.groupProtocol.set(groupName, "bacnet");
			this.wireAdapterEvents(groupName, adapter, socket, uuidMap);
			await adapter.start();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start BACnet adapter group ${groupName}: ${errorMessage}`);
			throw error;
		}
	}

	/** Get adapter by groupName (group-based lookup). */
	getAdapterGroup(groupName: string): IProtocolAdapter | undefined {
		return this.adapters.get(groupName.toLowerCase());
	}

	/** Get adapter by protocol (backward compatible - returns first adapter for protocol). */
	getAdapter(protocol: string): IProtocolAdapter | undefined {
		const normalized = protocol.toLowerCase();
		// First, try direct protocol name (backward compatibility)
		if (this.adapters.has(normalized)) {
			return this.adapters.get(normalized);
		}
		// If not found, search for any adapter whose groupName ends with the protocol
		for (const [groupName, adapter] of this.adapters) {
			if (groupName.endsWith(`-${normalized}`) || groupName === normalized) {
				return adapter;
			}
		}
		return undefined;
	}

	/** Get all running adapters. */
	getAllAdapters(): Map<string, IProtocolAdapter> {
		return new Map(this.adapters);
	}
}
