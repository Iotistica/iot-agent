import { EventEmitter } from 'events';
import { getHeapStatistics } from 'v8';
import { agentTopic } from '../../mqtt/topics.js';
import type { Protocol } from '../../plugins/protocol.js';
import type { DeviceConfig, DriftOptions, MqttConnection, Logger, DeviceStats, IPublishClient, IPublishPlugin } from './types.js';
import { DeviceState, normalizeTarget } from './types.js';
import { AnomalyFeed } from '../anomaly/feed.js';
import { AnomalyEnricher } from '../anomaly/enrich.js';
import { PayloadCompressor } from './compress.js';
import type { CompressorOptions, CompressionInfo } from './compress.js';
import { compressionToOpts } from './compress.js';
import { MessageBatcher } from './batch.js';
import { SocketConnection } from './socket.js';
import { PublishStats } from './stats.js';
import { HeartbeatManager } from './heartbeat.js';
import { createHash } from 'crypto';
import { loadSchemaDrift } from '../../pro/loader.js';
import { SchemaDriftModel } from '../../db/models/schema-drift.model.js';
import { SchemaDriftRuleModel } from '../../db/models/schema-drift-rule.model.js';
import type { AnomalyEventPayload } from '../../db/models/anomaly-event.model.js';
import type { DictionaryManager } from '../../mqtt/dictionary.js';
import type { PublishDestinationInfo, PublishBatchItem } from './types.js';
import { MlDatasetModel, PublishDestinationsModel, PublishSubscriptionsModel } from '../../db/models/index.js';
import type { MlDatasetRecord, PublisherRecord, PublishSubscriptionRecord, PublishSubscriptionRoute } from '../../db/models/index.js';
import { activityMonitor } from './activity-monitor.js';
import { cleanDriftFieldName, prettifyDriftDeviceId, cleanProtocolPipeName, stripFieldDevicePrefix } from '../../db/models/drift-labels.js';
import { buildCompactIssueCodes } from '../../quality/index.js';
import type { DataQuality } from '../../quality/index.js';
import type { PointIdentity } from '../../point-name/index.js';

const DESTINATION_HEALTH_INTERVAL_MS = 60_000;
const RECONNECT_FORCE_AFTER_MS = 10 * 60_000;

// Adaptive batch safety limits (calculated once at module load)
const MAX_BATCH_MESSAGES = 10000;
const MAX_BATCH_BYTES = (() => {
	const heapLimit = getHeapStatistics().heap_size_limit;
	return Math.min(10 * 1024 * 1024, Math.floor(heapLimit * 0.05));
})();

// A single publish batch (one MessageBatcher flush) only carries whichever
// readings happened to arrive before the flush fired — for a multi-device
// pipe (e.g. one BACnet endpoint fanning in dozens of devices) that's a
// rotating slice of the fleet, not a full schema snapshot. Accumulate across
// this window before feeding SchemaDriftDetector so each check sees close to
// the full field set instead of flagging most of every batch as "new".
const DRIFT_OBSERVE_WINDOW_MS = 15000;
const DRIFT_ACCUMULATOR_MAX_MESSAGES = 5000;

// Mirrors the Pro package's own DriftAlertEvent shape structurally (schema
// drift detection is a Pro feature — see pro/loader.ts's loadSchemaDrift()) —
// defined locally rather than imported so this file has no compile-time
// dependency on the Pro package being installed. Community builds still type-
// check cleanly even without @iotistica/agent-pro present.
type DriftAlertEvent = {
	endpointName: string;
	device?: string;
	driftType: 'new-field' | 'missing-field' | 'type-drift' | 'rename-candidate';
	severity: 'warning' | 'critical';
	fieldName?: string;
	expectedType?: string;
	observedTypes?: string[];
	renameCandidateFrom?: string;
	renameCandidateTo?: string;
	renameSimilarity?: number;
};

type PayloadFormat = 'custom' | 'tags' | 'ecp' | 'ml';

type PublishPayload = Record<string, unknown>;

interface ProtocolMessage extends Record<string, unknown> {
	readings?: ProtocolMessage[];
}

interface TagPayload {
	// Standardized (see timescaledb.ts): `name` is the normalized point name when
	// available, falling back to the raw protocol identifier when normalization
	// hasn't resolved one. The raw identifier is never lost — always also carried
	// as `rawName`.
	name: string;
	rawName?: string;
	value?: unknown;
	error?: unknown;
	type?: 1 | 2 | 3 | 4;
	unit?: string;
	rawUnit?: string;
	dqStatus?: string;
	dqUnitConfidence?: number;
	dqIssueCodes?: string[];
	// Never named `pointId` — provisionalPointId is rename-sensitive, not durable
	// identity (see src/point-name/types.ts's PointIdentity doc comment).
	provisionalPointId?: string;
	// Anomaly enrichment — same fields as MlFeaturePayload below, previously
	// 'ml'-format-only. Included here too so a 'tags'/'ecp' subscription (the
	// common case) doesn't have to switch to 'ml' format just to see anomaly
	// scores. Only present when anomaly detection is bound and this specific
	// reading was actually scored — see readAnomalyFields().
	anomaly_score?: number;
	anomaly_threshold?: number;
	baseline_samples?: number;
	detection_methods?: string[];
	trend?: string;
	trend_strength?: number;
	predicted_next?: number;
	forecast_confidence?: number;
	device_state?: unknown;
	state_duration_seconds?: number;
}

type MlDtype = 'bool' | 'int' | 'float' | 'string' | 'error';

interface MlFeaturePayload {
	name: string;
	rawName?: string;
	value: unknown;
	dtype: MlDtype;
	quality: 'GOOD' | 'BAD';
	error?: unknown;
	anomaly_score?: number;
	anomaly_threshold?: number;
	baseline_samples?: number;
	detection_methods?: string[];
	trend?: string;
	trend_strength?: number;
	predicted_next?: number;
	forecast_confidence?: number;
	device_state?: unknown;
	state_duration_seconds?: number;
	unit?: string;
	rawUnit?: string;
	dqStatus?: string;
	dqUnitConfidence?: number;
	dqIssueCodes?: string[];
	provisionalPointId?: string;
}

interface RuntimeSnapshot {
	state: DeviceState;
	addr: string;
	enabled: boolean;
	healthy: boolean;
	lastError: string | null;
	lastErrorTime: Date | null;
	messagesReceived: number;
	messagesPublished: number;
	bytesReceived: number;
	bytesPublished: number;
	reconnectAttempts: number;
	lastPublishTime?: Date;
	lastHeartbeatTime?: Date;
	lastConnectedTime?: Date;
}

interface HostBinding {
	subscription: PublishSubscriptionRecord;
	publisher: PublisherRecord;
	plugin: IPublishPlugin;
	datasetPointKeys?: Set<string>;
	datasetSamplingIntervalMs?: number;
	datasetConfig?: MlDatasetRecord;
}

interface AccumulatedFeature {
	feature: MlFeaturePayload;
	sourceName: string;
	observedAt: number;
}

export interface DatasetAccumulatorEntry {
	features: Map<string, AccumulatedFeature>;
	lastKnownValues: Map<string, AccumulatedFeature>;
	lastFlushedAt: number;
	binding: HostBinding;
	destinationTopic: string;
	flushing: boolean;
	perProtocolKeys: Map<string, Set<string>>;
	allExpectedPointKeys: Set<string>;
	samplingIntervalMs: number;
	datasetConfig: MlDatasetRecord;
	endpointName: string;
}

export class PublishManager extends EventEmitter {
	// eslint-disable-next-line @typescript-eslint/consistent-type-imports
	private messageBufferModel?: typeof import('../../db/models/buffer.model.js').MessageBufferModel;
	// eslint-disable-next-line @typescript-eslint/consistent-type-imports
	private messageBufferModelPromise?: Promise<typeof import('../../db/models/buffer.model.js').MessageBufferModel>;
	private readonly batcher: MessageBatcher;
	private readonly connection: SocketConnection;
	private readonly compressor: PayloadCompressor;
	private readonly stats: PublishStats;
	private readonly feed: AnomalyFeed;
	private readonly enricher: AnomalyEnricher;
	// Schema drift is a Pro feature — loaded asynchronously post-construction
	// (see initSchemaDrift()) since the dynamic import can't complete inside a
	// synchronous constructor. Undefined until it resolves, and stays undefined
	// forever in a Community build where the Pro package isn't installed.
	private schemaDriftDetector?: any;
	private driftAccumulator: ProtocolMessage[] = [];
	private driftWindowStartedAt = Date.now();
	private heartbeat?: HeartbeatManager;
	private bufferTimer: NodeJS.Timeout | null = null;
	private needStop = false;
	private publishing = false;
	private connectionHandlersAttached = false;
	private liveDataInterceptor?: (messages: ProtocolMessage[], endpointName: string) => Promise<ProtocolMessage[]> | ProtocolMessage[];
	private bindings: HostBinding[] = [];
	// Keyed by destination id; each entry also carries a snapshot of the destination
	// fields the plugin was built from, so loadBindings() (called on every reload,
	// including ones triggered by unrelated endpoint churn) can tell "this destination
	// is unchanged, reuse its plugin" apart from "this destination's config actually
	// changed, rebuild it" — see loadBindings() for why this distinction matters.
	private pluginByDestinationId: Map<number, { plugin: IPublishPlugin; snapshot: string }> = new Map();
	// Serializes concurrent reloadBindings() calls so only one runs at a time.
	// Without this, two rapid admin-UI actions can create zombie plugins that escape
	// the stop-before-start guard and produce a duplicate-clientId kick cycle.
	private reloadQueue: Promise<void> = Promise.resolve();
	// Per-(subscription, point) timestamp of the last ADMISSION decision for the optional
	// "Publish interval" throttle (route_json.minIntervalMs) — reactive, drop-only semantics.
	// Deliberately named/documented around "admission", not "delivery": this records when a
	// point was last let through into a binding's outgoing payload, not confirmed successful
	// delivery to the destination. There is no clean, granular-enough success signal to tie this
	// to instead — collectRouteEntries()'s caller settles success/failure per PLUGIN CALL (which
	// can bundle several bindings/subscriptions together), tolerates partial failure as an
	// overall "Published" outcome, and is bypassed entirely on the offline-queue path — so the
	// interval this throttle enforces is "time between admission attempts", not a delivery SLA.
	// Mirrors SocketServer's ClientSubscription.lastSentAt/applyRoutingRules()
	// (src/core/socket-server.ts) but scoped per point instead of per whole client, and wired
	// into the real PublishManager delivery path — SocketServer's own minIntervalMs enforcement
	// is for its unrelated local-IPC tee and never reflects what's stored in
	// publish_subscriptions.route_json. Keyed by `${subscriptionId}:${sourceName}:${metric}` so
	// (a) two bindings with different/no throttle settings never collide and (b) two devices
	// reporting a same-named metric don't collide.
	private lastAllowedAtByPoint = new Map<string, number>();
	private sharedDatasetAccumulators: Map<number, DatasetAccumulatorEntry> | null = null;
	private destinationHealthTimer: NodeJS.Timeout | null = null;
	private disconnectedSince = new Map<IPublishPlugin, number>();

	private readonly onConnected = (): void => {
		if (this.needStop) return;
		this.stats.recordConnected();
		if (this.config.bufferTimeMs > 0) this.startBufferTimer();
		this.emit('connected');
	};

	private readonly onData = (buf: Buffer): void => {
		if (this.needStop) return;
		this.stats.data.bytesReceived += buf.length;
		this.batcher.appendData(buf);
	};

	private readonly onConnectionError = (err: Error): void => {
		if (this.needStop) return;
		this.stats.recordError(err.message);
		this.emit('error', err);
	};

	private readonly onDisconnected = (): void => {
		if (this.needStop) return;
		if (this.batcher.messageCount > 0) {
			this.publishBatch().catch((err) => {
				this.logger?.error('Failed to publish batch on disconnect', err);
			});
		}
		this.emit('disconnected');
	};

	private readonly onReconnecting = (): void => {
		if (this.needStop) return;
		this.stats.data.reconnectAttempts++;
	};

	constructor(
    private readonly config: DeviceConfig,
    private readonly mqttConnection: MqttConnection,
    private readonly protocol: Protocol,
    private readonly endpointName: string,
    private readonly defaultClient: IPublishClient,
		private readonly buildPlugin: (publisher: PublisherRecord, client: IPublishClient, logger?: Logger, endpointName?: string) => IPublishPlugin,
    private readonly logger: Logger | undefined,
    private readonly deviceUuid: string,
	private dictionaryManager?: DictionaryManager,
    private useMsgpackPoc = false,
    private useKeyCompactionPoc = false,
    private useDeflatePoc = false,
    private anomalyService?: any,
	private readonly payloadFormat: PayloadFormat = 'custom',
    private maintenanceEnergyService?: any,
	) {
		super();

		this.batcher = new MessageBatcher(config, MAX_BATCH_MESSAGES, MAX_BATCH_BYTES, logger);
		this.connection = new SocketConnection(config, logger);
		this.compressor = new PayloadCompressor(
			{ useMsgpack: useMsgpackPoc, useKeyCompaction: useKeyCompactionPoc, useDeflate: useDeflatePoc },
			mqttConnection, dictionaryManager,  protocol,
		);
		this.stats = new PublishStats();
		this.feed = new AnomalyFeed(() => this.anomalyService, deviceUuid, protocol, logger, () => this.maintenanceEnergyService);
		this.enricher = new AnomalyEnricher(() => this.anomalyService, deviceUuid, protocol, logger);
		this.initSchemaDrift().catch((error) => {
			this.logger?.warn(`Schema drift init failed for endpoint '${this.endpointName}', continuing without it`, error);
		});

		this.batcher.on('flush', () => { this.publishBatch(); });
		this.batcher.on('message-added', () => { this.stats.data.messagesReceived++; });
		this.batcher.on('device-schema', (payload: any) => {
			// TEMPORARY diagnostic — see issue #17 follow-up investigation.
			this.logger?.debug(`[SCHEMA_DECLARE_DIAG] manager received device-schema for endpoint '${this.endpointName}': deviceName=${payload?.deviceName} fieldCount=${Array.isArray(payload?.fields) ? payload.fields.length : 'n/a'} detectorReady=${!!this.schemaDriftDetector}`);
			// If schemaDriftDetector hasn't resolved yet (initSchemaDrift() is
			// async), this declaration is silently dropped — same cold-start
			// tolerance as any other message that arrives before it's ready.
			// The adapter re-declares on every reconnect, so it isn't lost for
			// good, just until the next one.
			if (typeof payload?.deviceName !== 'string' || !Array.isArray(payload?.fields)) {
				this.logger?.debug(`[SCHEMA_DECLARE_DIAG] manager dropped malformed device-schema payload for endpoint '${this.endpointName}'`);
				return;
			}
			try {
				this.schemaDriftDetector?.declareDeviceSchema(payload.deviceName, payload.fields);
			} catch (err) {
				this.logger?.warn(`Failed to declare device schema for endpoint '${this.endpointName}'`, err);
			}
		});
	}

	/** Schema drift is Pro-only — resolves to a no-op (schemaDriftDetector stays undefined) on Community builds. */
	private async initSchemaDrift(): Promise<void> {
		const pro = await loadSchemaDrift();
		if (!pro) {
			this.logger?.debug(`Schema drift detection skipped for endpoint '${this.endpointName}' — requires Iotistica Pro`);
			return;
		}

		this.schemaDriftDetector = new pro.SchemaDriftDetector(
			this.config.name || 'unknown',
			this.logger,
			this.config.driftOptions ?? undefined,
			SchemaDriftModel,
		);

		this.schemaDriftDetector.setRules?.(SchemaDriftRuleModel.getAll());

		// setIncidentCorrelator() may already have been called before this resolved
		// (it's async, called from the constructor) — re-apply now that there's
		// finally a detector instance to wire it into.
		if (this.incidentCorrelator) {
			this.schemaDriftDetector.setDriftAlertHandler((event: DriftAlertEvent) => this.handleDriftAlert(event));
		}
	}

	/**
	 * Applies a new drift_options config to the already-running detector,
	 * without requiring an agent restart. Safe to call at any time: the Pro
	 * package's SchemaDriftDetector has no dispose/cleanup method and no
	 * timers/open handles (verified against its source) — discarding the old
	 * instance and constructing a fresh one via initSchemaDrift() just works,
	 * and its constructor synchronously reloads any already-learned baseline
	 * from SchemaDriftModel, so a live reconfigure doesn't reset warmup.
	 */
	public async reconfigureSchemaDrift(driftOptions: DriftOptions | undefined): Promise<void> {
		this.config.driftOptions = driftOptions;
		await this.initSchemaDrift();
	}

	public reloadDriftRules(): void {
		this.schemaDriftDetector?.setRules?.(SchemaDriftRuleModel.getAll());
	}

	public setAnomalyService(service?: any): void {
		this.anomalyService = service;
	}

	public setMaintenanceEnergyService(service?: any): void {
		this.maintenanceEnergyService = service;
	}

	private incidentCorrelator?: { processEvent: (payload: AnomalyEventPayload) => void };

	/**
	 * Wires (or clears) the shared incident correlator — the same one anomaly
	 * events feed into — so critical schema drift (missing-field, type-drift)
	 * shows up in Events/Incidents/Alerts alongside anomalies instead of only
	 * ever being visible in raw logs. Independent of anomaly detection/Pro
	 * licensing for the correlator itself (it runs regardless) — but schema
	 * drift alerts obviously only ever fire if the Pro drift detector loaded.
	 */
	public setIncidentCorrelator(correlator?: { processEvent: (payload: AnomalyEventPayload) => void }): void {
		this.incidentCorrelator = correlator;
		this.schemaDriftDetector?.setDriftAlertHandler(
			correlator ? (event: DriftAlertEvent) => this.handleDriftAlert(event) : undefined,
		);
	}

	/** No-op if schema drift isn't loaded (Community build, or Pro not yet initialized). */
	public clearSchemaDriftBaseline(): void {
		this.schemaDriftDetector?.clearBaselines();
	}

	private handleDriftAlert(event: DriftAlertEvent): void {
		if (!this.incidentCorrelator) return;

		const deviceLabel = event.device ?? this.config.name ?? this.protocol;
		// rename-candidate has no single fieldName — it's a from/to pair — so
		// fall back to the "to" field for the metric label and fingerprint.
		const rawField = event.fieldName ?? event.renameCandidateTo ?? 'unknown';
		const severity = event.severity;

		// Stable per (endpoint, device, drift type, field) so repeated occurrences
		// of the SAME problem escalate one incident instead of creating a new one
		// every time — mirrors how anomaly events fingerprint by metric+device.
		// Hashed on the raw (uncleaned) values so this stays stable regardless of
		// display formatting changes.
		const fingerprint = createHash('sha256')
			.update(`schema-drift:${event.endpointName}:${deviceLabel}:${event.driftType}:${rawField}`)
			.digest('hex')
			.slice(0, 32);

		const metric = stripFieldDevicePrefix(cleanDriftFieldName(rawField), deviceLabel);

		this.incidentCorrelator.processEvent({
			metric,
			fingerprint,
			timestamp_ms: Date.now(),
			// Drift isn't a statistical measurement — these have no natural anomaly
			// equivalent, so they're fixed sentinels representing "confirmed, not
			// estimated" rather than a real observed value/score/confidence.
			observed_value: 0,
			anomaly_score: 1,
			confidence: 1,
			severity,
			consecutive_count: 1,
			device_name: prettifyDriftDeviceId(deviceLabel),
			device_type: this.protocol,
			device_uuid: this.deviceUuid,
			kind: 'schema-drift',
			drift_type: event.driftType,
			drift_field: metric,
			drift_endpoint: cleanProtocolPipeName(event.endpointName),
		});
	}

	public setLiveDataInterceptor(interceptor?: (messages: ProtocolMessage[], endpointName: string) => Promise<ProtocolMessage[]> | ProtocolMessage[]): void {
		this.liveDataInterceptor = interceptor;
	}

	public setSharedDatasetAccumulators(map: Map<number, DatasetAccumulatorEntry>): void {
		this.sharedDatasetAccumulators = map;
	}

	async start(): Promise<void> {
		const name = this.config.name || 'unknown';
		if (!this.config.enabled) {
			this.logger?.info(`Endpoint '${name}' is disabled`);
			return;
		}
		this.logger?.info(`Starting endpoint '${name}'`);
		this.needStop = false;

		this.bindings = this.loadBindings();
		if (this.bindings.length === 0) {
			if (this.defaultClient.isConnected()) {
				this.logger?.warn('No publisher bindings found; using default Iotistica');
				this.bindings = this.createDefaultIotisticaBinding();
			} else {
				this.logger?.info('No publisher bindings found; waiting for bindings to be configured');
			}
		}

		this.initializeDatasetAccumulators();

		// Try to start plugins and fall back to default if all fail
		const startedPlugins = new Set<IPublishPlugin>();
		const failures: Array<{ plugin: IPublishPlugin; error: Error }> = [];

		for (const binding of this.bindings) {
			if (startedPlugins.has(binding.plugin)) {
				continue; // Already started this plugin instance
			}

			this.logger?.info(`Starting publish plugin`, {
				publisher: binding.publisher.name,
				type: binding.publisher.type,
			});

			try {
				await binding.plugin.start();
				startedPlugins.add(binding.plugin);
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				this.logger?.error(`Failed to start publish plugin`, error, {
					publisher: binding.publisher.name,
					type: binding.publisher.type,
				});
				failures.push({ plugin: binding.plugin, error });
				startedPlugins.add(binding.plugin); // Track as attempted
			}
		}

		// If all plugins failed and we have non-default bindings, fall back to Iotistica only when cloud is connected
		if (failures.length === startedPlugins.size && failures.length > 0 && this.bindings.some((b) => b.publisher.id !== -1)) {
			if (this.defaultClient.isConnected()) {
				this.logger?.warn(`All publish plugins failed to start; falling back to default Iotistica`, {
					failedPluginCount: failures.length,
					errors: failures.map((f) => f.error.message),
				});
				this.bindings = this.createDefaultIotisticaBinding();
				this.logger?.info(`Starting default Iotistica publish plugin`);
				try {
					await this.bindings[0].plugin.start();
				} catch (err) {
					this.logger?.error('Failed to start default Iotistica publisher', err);
					throw new Error(`All publish plugins failed and fallback also failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			} else {
				this.logger?.warn(`All publish plugins failed to start; cloud not connected, clearing bindings`, {
					failedPluginCount: failures.length,
					errors: failures.map((f) => f.error.message),
				});
				this.bindings = [];
			}
		}

		this.attachConnectionHandlers();

		if (this.config.mqttHeartbeatTopic) {
			this.heartbeat = new HeartbeatManager(this.config, this.mqttConnection, this.deviceUuid, this.logger);
			this.heartbeat.start(
				() => this.connection.state,
				() => this.getStats(),
			);
		}

		this.clearBufferTimer();
		if (this.config.bufferTimeMs > 0) this.startBufferTimer();
		this.startDestinationHealthMonitor();
		this.connection.connect();
	}

	async stop(): Promise<void> {
		const name = this.config.name || 'unknown';
		this.logger?.info(`Stopping endpoint '${name}'`);
		this.needStop = true;

		this.heartbeat?.stop();
		this.clearBufferTimer();
		this.stopDestinationHealthMonitor();
		this.detachConnectionHandlers();
		this.connection.disconnect();

		if (this.batcher.messageCount > 0) await this.publishBatch();

		for (const plugin of this.getUniquePlugins()) {
			await plugin.stop();
		}

		this.bindings = [];
		this.pluginByDestinationId.clear();
		if (this.sharedDatasetAccumulators) {
			for (const entry of this.sharedDatasetAccumulators.values()) {
				entry.perProtocolKeys.delete(this.protocol);
				entry.allExpectedPointKeys.clear();
				for (const keys of entry.perProtocolKeys.values()) {
					for (const key of keys) entry.allExpectedPointKeys.add(key);
				}
			}
			for (const [id, entry] of this.sharedDatasetAccumulators) {
				if (entry.perProtocolKeys.size === 0) this.sharedDatasetAccumulators.delete(id);
			}
		}
	}

	async reloadBindings(): Promise<void> {
		// Chain onto the existing reload so concurrent calls (e.g. two rapid admin-UI
		// subscription creates) execute sequentially and never interleave plugin
		// stop/start operations — the root cause of the duplicate-clientId kick cycle.
		this.reloadQueue = this.reloadQueue.then(() => this._doReloadBindings());
		return this.reloadQueue;
	}

	private async _doReloadBindings(): Promise<void> {
		if (this.needStop) return;

		const oldPlugins = this.getUniquePlugins();
		const newBindings = this.loadBindings();

		if (newBindings.length === 0 && this.defaultClient.isConnected()) {
			newBindings.push(...this.createDefaultIotisticaBinding());
		}

		this.bindings = newBindings;
		// Drop lastAllowedAtByPoint entries for subscriptions that no longer exist, so a
		// deleted/edited subscription's throttle state doesn't linger forever. Runs only on
		// reload (admin-UI config changes), already infrequent.
		const liveSubscriptionIds = new Set(newBindings.map((b) => String(b.subscription.id ?? 'none')));
		for (const key of this.lastAllowedAtByPoint.keys()) {
			const subscriptionId = key.slice(0, key.indexOf(':'));
			if (!liveSubscriptionIds.has(subscriptionId)) this.lastAllowedAtByPoint.delete(key);
		}
		const newPlugins = this.getUniquePlugins();

		// Stop removed plugins BEFORE starting new ones so that external MQTT clients
		// sharing the same clientId do not briefly coexist — the broker would kick the
		// old client when the new one connects, and the old client's 5-second reconnect
		// timer would then kick the new client back in an infinite cycle.
		for (const plugin of oldPlugins) {
			if (!newPlugins.includes(plugin)) {
				await plugin.stop().catch((err) => {
					this.logger?.error('Failed to stop old plugin during binding reload', err);
				});
			}
		}

		for (const plugin of newPlugins) {
			if (!oldPlugins.includes(plugin)) {
				try {
					await plugin.start();
				} catch (err) {
					this.logger?.error('Failed to start plugin during binding reload', err);
				}
			}
		}

		this.initializeDatasetAccumulators();
		this.logger?.info('Reloaded publish bindings', { bindingCount: this.bindings.length });
	}

	private initializeDatasetAccumulators(): void {
		const accumulators = this.sharedDatasetAccumulators;
		if (!accumulators) return;

		for (const entry of accumulators.values()) {
			entry.perProtocolKeys.delete(this.protocol);
			entry.allExpectedPointKeys.clear();
			for (const keys of entry.perProtocolKeys.values()) {
				for (const key of keys) entry.allExpectedPointKeys.add(key);
			}
		}
		for (const [id, entry] of accumulators) {
			if (entry.perProtocolKeys.size === 0) accumulators.delete(id);
		}

		for (const binding of this.bindings) {
			if (!binding.datasetPointKeys || binding.subscription.id === undefined) continue;
			if (!binding.datasetConfig) continue;
			const subId = binding.subscription.id;

			const entry = accumulators.get(subId);
			if (entry) {
				entry.perProtocolKeys.set(this.protocol, binding.datasetPointKeys);
				entry.allExpectedPointKeys.clear();
				for (const keys of entry.perProtocolKeys.values()) {
					for (const key of keys) entry.allExpectedPointKeys.add(key);
				}
				entry.binding = binding;
				entry.datasetConfig = binding.datasetConfig;
				entry.samplingIntervalMs = binding.datasetSamplingIntervalMs ?? 60_000;
			} else {
				const allKeys = new Set(binding.datasetPointKeys);
				accumulators.set(subId, {
					features: new Map(),
					lastKnownValues: new Map(),
					lastFlushedAt: Date.now(),
					binding,
					destinationTopic: '',
					flushing: false,
					perProtocolKeys: new Map([[this.protocol, binding.datasetPointKeys]]),
					allExpectedPointKeys: allKeys,
					samplingIntervalMs: binding.datasetSamplingIntervalMs ?? 60_000,
					datasetConfig: binding.datasetConfig,
					endpointName: this.endpointName,
				});
			}
		}
	}

	getStats(): DeviceStats {
		return { ...this.stats.data };
	}

	getState(): DeviceState {
		return this.connection.state;
	}

	/**
   * Inject a simulated protocol message directly into the same publish pipeline.
   * This reuses batching, anomaly enrichment, compression, and MQTT publish paths.
   */
	public injectSimulationMessage(message: ProtocolMessage): void {
		if (this.needStop) {
			return;
		}

		try {
			const raw = JSON.stringify(message) + this.config.eomDelimiter;
			this.batcher.appendData(Buffer.from(raw, 'utf8'));
		} catch (error) {
			this.logger?.error(`Failed to inject simulation message for endpoint '${this.config.name || 'unknown'}'`, error);
		}
	}

	getRuntimeSnapshot(staleThresholdMs = 60000): RuntimeSnapshot {
		const stats = this.getStats();
		const state = this.getState();
		const hasRecentData = stats.lastPublishTime &&
      (Date.now() - stats.lastPublishTime.getTime()) < staleThresholdMs;
		const healthy = state === DeviceState.CONNECTED && (hasRecentData || stats.messagesReceived === 0);

		return {
			state,
			addr: this.config.addr,
			enabled: this.config.enabled !== false,
			healthy,
			lastError: stats.lastError || null,
			lastErrorTime: stats.lastErrorTime || null,
			...stats,
		};
	}

	updateInterval(intervalMs: number): void {
		if (intervalMs < 1000) throw new Error(`Invalid interval: minimum 1000ms`);
		this.config.publishInterval = intervalMs;
		this.logger?.info(`Updated interval for '${this.config.name || 'unknown'}': ${intervalMs}ms`);
	}

	// --------------------------------------------------------------------------

	private async publishBatch(): Promise<void> {
		if (this.needStop) return;
		if (this.batcher.messageCount === 0) return;
		if (this.publishing) return;

		// No destinations or subscriptions configured — discard the batch silently.
		// Buffering without a destination wastes disk and misleads the operator.
		// Once bindings are added, reloadBindings() will repopulate this.bindings
		// and subsequent batches will flow normally.
		if (this.bindings.length === 0) {
			this.batcher.reset();
			return;
		}

		this.publishing = true;
		try {

			const name = this.config.name || 'unknown';
			let topic: string;
			try {
				topic = agentTopic(this.deviceUuid, 'endpoints', this.config.mqttTopic);
			} catch {
				topic = `local/${this.deviceUuid}/${this.config.mqttTopic || 'data'}`;
			}
			const messageCount = this.batcher.messageCount;
			const batchBytes = this.batcher.totalBytes;
			let messages = [...this.batcher.messages] as ProtocolMessage[];

			if (this.liveDataInterceptor) {
				try {
					const intercepted = await this.liveDataInterceptor(messages, name);
					if (Array.isArray(intercepted)) {
						messages = intercepted;
					}
				} catch (err) {
					this.logger?.warn(`Live data interceptor failed for endpoint '${name}', continuing with original payload`, err);
				}
			}

			// Feed the Dashboard's rolling "Good Quality %" tile — once per individual
			// reading in this batch, before any per-destination fan-out or per-metric
			// dedup happen further down in collectRouteEntries(). See ActivityMonitor.
			// recordQualitySample()'s doc comment for why this can't reuse record().
			for (const reading of this.collectTagRecords(messages)) {
				activityMonitor.recordQualitySample(typeof reading?.quality === 'string' ? reading.quality : undefined);
			}

			const driftMessages =this.projectMessagesForSchemaDrift(messages);

			this.driftAccumulator.push(...driftMessages);

			if (this.driftAccumulator.length > DRIFT_ACCUMULATOR_MAX_MESSAGES) {
				this.driftAccumulator = this.driftAccumulator.slice(-DRIFT_ACCUMULATOR_MAX_MESSAGES);
			}
			const nowMs = Date.now();
			if (nowMs - this.driftWindowStartedAt >= DRIFT_OBSERVE_WINDOW_MS) {
				try {
					this.schemaDriftDetector?.observe(this.driftAccumulator);
				} catch (err) {
					this.logger?.warn(`Schema drift detector failed for endpoint '${name}', continuing with original payload`, err);
				}
				this.driftAccumulator = [];
				this.driftWindowStartedAt = nowMs;
			}

			const enriched = this.processAnomaly(messages, name);
			if (this.needStop) return;

			const { data, baselineSize, msgId } = this.buildPayload(name, enriched, this.payloadFormat);
			if (this.needStop) return;

			const hasExternalBindings = this.bindings.some((b) => b.publisher.type !== 'iotistica');
			if (!this.isConnected() && !hasExternalBindings) {
				await this.publishOffline(topic, data, msgId, messageCount);
				return;
			}

			await this.publishOnline(topic, data, msgId, baselineSize, messageCount, batchBytes, enriched, name);
		} finally {
			this.publishing = false;
		}
	}

	private processAnomaly(messages: ProtocolMessage[], endpointName: string): ProtocolMessage[] {
		if (!this.anomalyService) {
			this.logger?.debug('Skipping endpoint anomaly processing: no anomaly service bound', {
				endpointName,
				messageCount: messages.length,
			});
			return messages;
		}

		this.logger?.debug('Dispatching endpoint batch to anomaly feed', {
			endpointName,
			messageCount: messages.length,
		});
		this.feed.processBatch(messages, endpointName);
		return this.enricher.enrich(messages, endpointName) as ProtocolMessage[];
	}

	private buildPayload(endpointName: string, messages: ProtocolMessage[], payloadFormat: PayloadFormat, filterBadQuality = false, datasetConfig?: MlDatasetRecord): {
    data: PublishPayload;
    msgId: string;
    baselineSize: number;
  } {
		const msgId = this.mqttConnection.getMessageIdGenerator?.()?.generate()
			?? `${this.deviceUuid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

		if (payloadFormat === 'custom') {
			const timestampIso = new Date().toISOString();
			const data = {
				timestamp: timestampIso,
				protocol: this.protocol,
				messages,
				msgId,
			};
			const baselineSize = Buffer.byteLength(JSON.stringify(data), 'utf8');
			return { data, msgId, baselineSize };
		}

		if (payloadFormat === 'ml') {
			const externalGroupName = this.normalizeExternalGroupName(endpointName);
			const tagRecords = this.collectTagRecords(messages);
			const externalNodeName = this.resolveExternalNodeName(externalGroupName, messages, tagRecords);
			const timestampMs = Date.now();
			// Unlike ECP's snapshot semantics, training data keeps every sample in the
			// batch — no dedup by name — since each reading is a separate observation.
			const features = tagRecords.map((message, index) => this.mapMlFeaturePayload(message, index));

			const data: Record<string, unknown> = {
				timestamp: timestampMs,
				node: externalNodeName,
				group: externalGroupName,
				schema: datasetConfig ? 'iotistica.ml.v2' : 'iotistica.ml.v1',
				features,
			};

			if (datasetConfig) {
				data.dataset = {
					id: datasetConfig.id,
					name: datasetConfig.name,
					windowSecs: datasetConfig.window_secs,
					missingValues: datasetConfig.missing_values,
					normalization: datasetConfig.normalization,
					excludeBadQuality: !!datasetConfig.exclude_bad_quality,
					removeOutliers: !!datasetConfig.remove_outliers,
					outlierMethod: datasetConfig.outlier_method,
					outputFormat: datasetConfig.output_format,
				};
			}

			const baselineSize = Buffer.byteLength(JSON.stringify(data), 'utf8');
			return { data, msgId, baselineSize };
		}

		const externalGroupName = this.normalizeExternalGroupName(endpointName);
		const tagRecords = this.collectTagRecords(messages);
		const externalNodeName = this.resolveExternalNodeName(externalGroupName, messages, tagRecords);
		const timestampMs = Date.now();
		const allTags = tagRecords
			.map((message, index) => this.mapTagPayload(message, index, payloadFormat, filterBadQuality))
			.filter((tag): tag is TagPayload => tag !== null);
		// ECP is a snapshot format (single batch timestamp, one entry per tag).
		// Deduplicate by name keeping the last (most recent) value so a multi-poll
		// batch doesn't repeat the same metric N times.
		const tags = payloadFormat === 'ecp'
			? [...new Map(allTags.map((t) => [t.name, t])).values()]
			: allTags;

		const data = {
			timestamp: timestampMs,
			node: externalNodeName,
			group: externalGroupName,
			tags,
		};

		const baselineSize = Buffer.byteLength(JSON.stringify(data), 'utf8');
		return { data, msgId, baselineSize };
	}

	private buildAccumulatedMlPayload(
		endpointName: string,
		snapshot: Map<string, AccumulatedFeature>,
		datasetConfig: MlDatasetRecord,
		configuredPointKeys: Set<string>,
		lastKnownValues: Map<string, AccumulatedFeature>,
	): { data: PublishPayload; msgId: string; baselineSize: number } | null {
		const msgId = this.mqttConnection.getMessageIdGenerator?.()?.generate()
			?? `${this.deviceUuid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

		const missingPolicy = datasetConfig.missing_values || 'keep_null';
		const externalGroupName = datasetConfig.name || this.normalizeExternalGroupName(endpointName);
		const features: Record<string, unknown>[] = [];
		const sourceNameSet = new Set<string>();

		for (const pointKey of configuredPointKeys) {
			let parsed: [string, string];
			try { parsed = JSON.parse(pointKey); } catch { continue; }
			const [sourceName, metric] = parsed;
			sourceNameSet.add(sourceName);

			const accumulated = snapshot.get(pointKey);
			if (accumulated) {
				const feat: Record<string, unknown> = { ...accumulated.feature, sourceName: accumulated.sourceName, observedAt: accumulated.observedAt };
				features.push(feat);
			} else if (missingPolicy === 'skip_missing') {
				// omit entirely
			} else if (missingPolicy === 'forward_fill') {
				const lastKnown = lastKnownValues.get(pointKey);
				if (lastKnown) {
					features.push({ ...lastKnown.feature, sourceName: lastKnown.sourceName, status: 'forwarded', observedAt: lastKnown.observedAt });
				} else {
					features.push({ name: metric, sourceName, value: null, status: 'missing', observedAt: null });
				}
			} else {
				features.push({ name: metric, sourceName, value: null, status: 'missing', observedAt: null });
			}
		}

		const collectedFeatures = snapshot.size;
		const expectedFeatures = configuredPointKeys.size;

		if (collectedFeatures === 0) {
			return null;
		}

		if (missingPolicy === 'drop_incomplete' && collectedFeatures < expectedFeatures) {
			return null;
		}

		const data: Record<string, unknown> = {
			timestamp: Date.now(),
			node: datasetConfig.name,
			group: externalGroupName,
			schema: 'iotistica.ml.v2',
			sources: [...sourceNameSet].sort(),
			features,
			dataset: {
				id: datasetConfig.id,
				name: datasetConfig.name,
				expectedFeatures,
				collectedFeatures,
				missingFeatures: expectedFeatures - collectedFeatures,
				complete: collectedFeatures === expectedFeatures,
				samplingIntervalSecs: datasetConfig.sampling_interval_secs,
				windowSecs: datasetConfig.window_secs,
				missingValues: datasetConfig.missing_values,
				normalization: datasetConfig.normalization,
				excludeBadQuality: !!datasetConfig.exclude_bad_quality,
				removeOutliers: !!datasetConfig.remove_outliers,
				outlierMethod: datasetConfig.outlier_method,
				outputFormat: datasetConfig.output_format,
			},
		};

		const baselineSize = Buffer.byteLength(JSON.stringify(data), 'utf8');
		return { data, msgId, baselineSize };
	}

	private async flushDatasetAccumulatorEntry(
		entry: DatasetAccumulatorEntry,
		binding: HostBinding,
		destinationTopic: string,
		endpointName: string,
		sourceTopic: string,
		batchesByPlugin?: Map<IPublishPlugin, PublishBatchItem[]>,
	): Promise<void> {
		if (entry.flushing) return;
		entry.flushing = true;

		const snapshot = entry.features;
		entry.features = new Map();

		for (const [key, feat] of snapshot) {
			entry.lastKnownValues.set(key, feat);
		}

		try {
			if (entry.allExpectedPointKeys.size === 0 || !entry.datasetConfig) return;

			const result = this.buildAccumulatedMlPayload(
				entry.endpointName || endpointName,
				snapshot,
				entry.datasetConfig,
				entry.allExpectedPointKeys,
				entry.lastKnownValues,
			);

			if (!result) {
				this.logger?.debug('Dataset flush suppressed (empty or incomplete)', {
					component: 'PublishManager',
					protocol: this.protocol,
					subscriptionId: binding.subscription.id,
					datasetId: entry.datasetConfig?.id,
					collectedFeatures: snapshot.size,
					expectedFeatures: entry.allExpectedPointKeys.size,
				});
				return;
			}

			const { data, baselineSize } = result;

			const subscriptionCompression = binding.subscription.compression ?? null;
			const overrideOpts = subscriptionCompression ? compressionToOpts(subscriptionCompression) : undefined;
			const { payload } = await this.compressor.compress(data, baselineSize, this.stats.data.messagesPublished, overrideOpts);

			const item: PublishBatchItem = {
				topic: sourceTopic,
				payload,
				options: { qos: 1, destinationTopic },
			};

			if (batchesByPlugin) {
				const items = batchesByPlugin.get(binding.plugin) || [];
				items.push(item);
				batchesByPlugin.set(binding.plugin, items);
			} else {
				await binding.plugin.publishBatch([item]);
			}

			this.logger?.debug('Flushed dataset accumulator', {
				component: 'PublishManager',
				protocol: this.protocol,
				endpoint: this.endpointName,
				subscriptionId: binding.subscription.id,
				datasetId: entry.datasetConfig?.id,
				collectedFeatures: snapshot.size,
				expectedFeatures: entry.allExpectedPointKeys.size,
			});
		} catch (err) {
			this.logger?.error('Failed to flush dataset accumulator', err instanceof Error ? err : new Error(String(err)), {
				component: 'PublishManager',
				protocol: this.protocol,
				endpoint: this.endpointName,
				subscriptionId: binding.subscription.id,
				datasetId: entry.datasetConfig?.id,
			});
		} finally {
			entry.lastFlushedAt = Date.now();
			entry.flushing = false;
		}
	}

	private flushPendingDatasetAccumulators(): void {
		if (this.needStop) return;
		if (!this.sharedDatasetAccumulators) return;
		let sourceTopic: string;
		try {
			sourceTopic = agentTopic(this.deviceUuid, 'endpoints', this.config.mqttTopic);
		} catch {
			sourceTopic = `local/${this.deviceUuid}/${this.config.mqttTopic || 'data'}`;
		}
		const now = Date.now();
		for (const entry of this.sharedDatasetAccumulators.values()) {
			if (now - entry.lastFlushedAt < entry.samplingIntervalMs) continue;
			if (entry.flushing) continue;
			let { destinationTopic } = entry;
			if (!destinationTopic) {
				const resolved = this.resolveDestinationTopic(entry.binding, sourceTopic);
				if (resolved === null) continue;
				destinationTopic = resolved;
				entry.destinationTopic = resolved;
			}
			this.flushDatasetAccumulatorEntry(
				entry,
				entry.binding,
				destinationTopic,
				entry.endpointName || this.endpointName,
				sourceTopic,
			).catch((err) => {
				this.logger?.error('Dataset accumulator flush failed', err instanceof Error ? err : new Error(String(err)));
			});
		}
	}

	private collectTagRecords(messages: ProtocolMessage[]): ProtocolMessage[] {
		const tagRecords: ProtocolMessage[] = [];
		for (const message of messages) {
			if (Array.isArray(message.readings)) {
				tagRecords.push(...message.readings);
				continue;
			}

			tagRecords.push(message);
		}

		return tagRecords;
	}

	/** Flat unit fields for outbound tag/ml payloads — reads the interceptor-attached
	 *  unitValue struct when present (see src/normalization/interceptor.ts), falling
	 *  back to the plain .unit field for messages that never passed through it. */
	private readNormalizedUnit(message: ProtocolMessage): { unit?: string; rawUnit?: string } {
		const unitValue = message.unitValue as { unit?: string; rawUnit?: string } | undefined;
		const unit = unitValue?.unit ?? (typeof message.unit === 'string' ? message.unit : undefined);
		const rawUnit = unitValue?.rawUnit;
		return { ...(unit && { unit }), ...(rawUnit && { rawUnit }) };
	}

	/** Compact quality projection for tag/ml payloads — reads message.dataQuality (see src/quality/interceptor.ts)
	 *  when present. Never carries checks{}/ruleId/protocolCode/issue messages/rulesVersion/engineVersion —
	 *  those stay 'custom'-format-only. */
	private readQualityFields(message: ProtocolMessage): { dqStatus?: string; dqUnitConfidence?: number; dqIssueCodes?: string[] } {
		const dataQuality = message.dataQuality as DataQuality | undefined;
		if (!dataQuality) return {};
		const dqUnitConfidence = dataQuality.checks.unit?.confidence;
		const dqIssueCodes = buildCompactIssueCodes(dataQuality.checks);
		return {
			...(dataQuality.status && { dqStatus: dataQuality.status }),
			...(dqUnitConfidence !== undefined && { dqUnitConfidence }),
			...(dqIssueCodes && { dqIssueCodes }),
		};
	}

	/** Compact anomaly-enrichment projection for tag/ml payloads — reads whatever
	 *  AnomalyEnricher.enrich() attached directly onto the message (see processAnomaly()).
	 *  Only present when anomaly detection is bound AND this specific reading was
	 *  actually scored — never fabricated for a reading that wasn't. Shared by
	 *  mapTagPayload() ('tags'/'ecp') and attachMlEnrichment() ('ml') so both formats
	 *  carry the identical field set instead of two independently-maintained copies. */
	private readAnomalyFields(message: ProtocolMessage): {
		anomaly_score?: number;
		anomaly_threshold?: number;
		baseline_samples?: number;
		detection_methods?: string[];
		trend?: string;
		trend_strength?: number;
		predicted_next?: number;
		forecast_confidence?: number;
		device_state?: unknown;
		state_duration_seconds?: number;
	} {
		return {
			...(typeof message.anomaly_score === 'number' && { anomaly_score: message.anomaly_score }),
			...(typeof message.anomaly_threshold === 'number' && { anomaly_threshold: message.anomaly_threshold }),
			...(typeof message.baseline_samples === 'number' && { baseline_samples: message.baseline_samples }),
			...(Array.isArray(message.detection_methods) && { detection_methods: message.detection_methods as string[] }),
			...(typeof message.trend === 'string' && { trend: message.trend }),
			...(typeof message.trend_strength === 'number' && { trend_strength: message.trend_strength }),
			...(typeof message.predicted_next === 'number' && { predicted_next: message.predicted_next }),
			...(typeof message.forecast_confidence === 'number' && { forecast_confidence: message.forecast_confidence }),
			...(message.device_state !== undefined && { device_state: message.device_state }),
			...(typeof message.state_duration_seconds === 'number' && { state_duration_seconds: message.state_duration_seconds }),
		};
	}

	/** Compact point-identity projection for the Live View activity-monitor path (see the
	 *  activityMonitor.record() call site below) — reads message.pointIdentity (see
	 *  src/point-name/interceptor.ts) when present. Unlike tag/ml payloads (mapTagPayload()/
	 *  attachMlEnrichment()), Live View's own `metric`/`lastMetric` deliberately stays raw
	 *  with normalizedName as a separate additive field, so both are kept here. Never carries
	 *  rawName/sourceAddress/rulesVersion/provenance — those stay 'custom'-format-only. Field
	 *  is provisionalPointId, never pointId — see src/point-name/types.ts's PointIdentity doc
	 *  comment on why. */
	private readPointIdentity(message: ProtocolMessage): { provisionalPointId?: string; normalizedName?: string } {
		const pointIdentity = message.pointIdentity as PointIdentity | undefined;
		if (!pointIdentity) return {};
		return {
			...(pointIdentity.provisionalPointId && { provisionalPointId: pointIdentity.provisionalPointId }),
			...(pointIdentity.normalizedName && { normalizedName: pointIdentity.normalizedName }),
		};
	}

	private mapTagPayload(message: ProtocolMessage, index: number, payloadFormat: Exclude<PayloadFormat, 'custom'>, filterBadQuality = false): TagPayload | null {
		const rawName = this.readRawPointName(message, index);
		const pointIdentity = message.pointIdentity as PointIdentity | undefined;
		// Standardized primary identifier (see timescaledb.ts): normalized point name
		// when available, falling back to the raw protocol identifier otherwise. Never
		// loses the raw value — always also carried as `rawName`.
		const name = pointIdentity?.normalizedName ?? rawName;
		const provisionalPointId = pointIdentity?.provisionalPointId;

		const unitFields = this.readNormalizedUnit(message);
		const qualityFields = this.readQualityFields(message);
		const anomalyFields = this.readAnomalyFields(message);

		const quality = typeof message.quality === 'string' ? message.quality.toUpperCase() : undefined;
		const hasError = message.error !== undefined
			|| message.errorCode !== undefined
			|| quality === 'BAD'
			|| message.qualityCode !== undefined;

		if (hasError) {
			// Only drop bad-quality readings when the subscription explicitly restricts quality.
			// An empty qualities filter means "no restriction" — publish errors as error tags.
			if (payloadFormat === 'ecp' && filterBadQuality) {
				return null;
			}

			return {
				name,
				rawName,
				error: message.error ?? message.errorCode ?? message.qualityCode ?? 'READ_ERROR',
				...unitFields,
				...qualityFields,
				...anomalyFields,
				...(provisionalPointId && { provisionalPointId }),
			};
		}

		const value = message.value ?? message.rawValue ?? null;
		if (payloadFormat === 'ecp') {
			if (value === null || value === undefined) {
				return null;
			}

			return {
				name,
				rawName,
				value,
				type: this.inferEcpType(value),
				...unitFields,
				...qualityFields,
				...anomalyFields,
				...(provisionalPointId && { provisionalPointId }),
			};
		}

		return { name, rawName, value, ...unitFields, ...qualityFields, ...anomalyFields, ...(provisionalPointId && { provisionalPointId }) };
	}

	private mapMlFeaturePayload(message: ProtocolMessage, index: number): MlFeaturePayload {
		const rawName = this.readRawPointName(message, index);
		const pointIdentity = message.pointIdentity as PointIdentity | undefined;
		const name = pointIdentity?.normalizedName ?? rawName;

		const quality = typeof message.quality === 'string' ? message.quality.toUpperCase() : undefined;
		const hasError = message.error !== undefined
			|| message.errorCode !== undefined
			|| quality === 'BAD'
			|| message.qualityCode !== undefined;

		if (hasError) {
			const feature: MlFeaturePayload = {
				name,
				rawName,
				value: null,
				dtype: 'error',
				quality: 'BAD',
				error: message.error ?? message.errorCode ?? message.qualityCode ?? 'READ_ERROR',
			};
			this.attachMlEnrichment(feature, message);
			return feature;
		}

		const rawValue = message.value ?? message.rawValue;
		if (rawValue === null || rawValue === undefined) {
			const feature: MlFeaturePayload = {
				name,
				rawName,
				value: null,
				dtype: 'error',
				quality: 'BAD',
				error: 'NO_VALUE',
			};
			this.attachMlEnrichment(feature, message);
			return feature;
		}

		const feature: MlFeaturePayload = {
			name,
			rawName,
			value: rawValue,
			dtype: this.inferMlDtype(rawValue),
			quality: 'GOOD',
		};
		this.attachMlEnrichment(feature, message);
		return feature;
	}

	private readRawPointName(message: ProtocolMessage, index: number): string {
		return String(
			message.rawPointName
		?? message.rawObjectName
		?? message.metric
		?? message.metric_name
		?? message.nodeName
		?? message.name
		?? message.tag
		?? message.id
		?? `tag_${index}`
		);
	}

	private attachMlEnrichment(feature: MlFeaturePayload, message: ProtocolMessage): void {
		Object.assign(feature, this.readAnomalyFields(message));
		Object.assign(feature, this.readNormalizedUnit(message));
		Object.assign(feature, this.readQualityFields(message));
		const provisionalPointId = (message.pointIdentity as PointIdentity | undefined)?.provisionalPointId;
		if (provisionalPointId) feature.provisionalPointId = provisionalPointId;
	}

	private inferMlDtype(value: unknown): MlDtype {
		if (typeof value === 'boolean') {
			return 'bool';
		}

		if (typeof value === 'number') {
			return Number.isInteger(value) ? 'int' : 'float';
		}

		return 'string';
	}

	private resolvePayloadFormatForBinding(binding: HostBinding): PayloadFormat {
		const candidate = String(binding.subscription.payload_format || '').toLowerCase();
		if (candidate === 'custom' || candidate === 'tags' || candidate === 'ecp' || candidate === 'ml') {
			return candidate;
		}

		return this.payloadFormat;
	}

	private async getCompressedPayloadForFormat(
		payloadFormat: PayloadFormat,
		cacheKey: string,
		endpointName: string,
		messages: ProtocolMessage[],
		compressedPayloadCache: Map<string, string | Buffer>,
		compressionInfoCache: Map<string, CompressionInfo>,
		overrideOpts?: CompressorOptions,
		filterBadQuality = false,
		datasetConfig?: MlDatasetRecord,
	): Promise<{ payload: string | Buffer; info?: CompressionInfo }> {
		const cachedPayload = compressedPayloadCache.get(cacheKey);
		if (cachedPayload !== undefined) {
			// Same cacheKey -> identical compression inputs -> the cached info is
			// still accurate, not stale, for whichever binding hits this branch.
			return { payload: cachedPayload, info: compressionInfoCache.get(cacheKey) };
		}

		const { data, baselineSize } = this.buildPayload(endpointName, messages, payloadFormat, filterBadQuality, datasetConfig);
		const { payload, info } = await this.compressor.compress(data, baselineSize, this.stats.data.messagesPublished, overrideOpts);
		compressedPayloadCache.set(cacheKey, payload);
		compressionInfoCache.set(cacheKey, info);
		return { payload, info };
	}

	private normalizeExternalGroupName(endpointName: string): string {
		return endpointName.replace(/(?:^|[-_\s])pipe$/i, '').replace(/[-_\s]+$/g, '');
	}

	private resolveExternalNodeName(
		externalGroupName: string,
		messages: ProtocolMessage[],
		tagRecords: ProtocolMessage[],
	): string {
		const candidates = [
			...messages,
			...tagRecords,
		];

		for (const candidate of candidates) {
			const resolved = this.readExternalNodeCandidate(candidate);
			if (resolved) {
				return this.normalizeExternalGroupName(resolved);
			}
		}

		return externalGroupName;
	}

	private readExternalNodeCandidate(message: ProtocolMessage): string | null {
		const value = message.deviceName
			?? message.device_name
			?? message.resolvedDisplayName
			?? message.resolved_display_name
			?? message.sourceDeviceName
			?? message.source_device_name
			?? null;

		if (typeof value !== 'string') {
			return null;
		}

		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}

	private resolveRecordMetric(record: ProtocolMessage): string {
		return String(
			record?.metric ?? record?.metric_name ?? record?.nodeName ?? record?.name ?? record?.tag ?? record?.id ?? '—',
		);
	}

	/**
	 * "Publish interval" (route_json.minIntervalMs) enforcement for ONE destination binding.
	 * Reactive, drop-only, per-point throttle — mirrors SocketServer's ClientSubscription
	 * .lastSentAt/applyRoutingRules(), but scoped per (subscription, device, metric) instead of
	 * per whole client. No pending-value cache or scheduled flush: a throttled point is simply
	 * omitted from THIS tick's payload for THIS binding; next time it arrives after the interval
	 * elapses, whatever is current at that moment is admitted — never backfilled or caught up.
	 *
	 * "Admitted"/lastAllowedAtByPoint, not "sent"/"delivered": this gates what's INCLUDED in the
	 * outgoing payload, not confirmed successful delivery — see lastAllowedAtByPoint's doc
	 * comment for why no clean, granular-enough success signal exists to tie this to instead.
	 *
	 * Non-mutating: `messages` and any nested `.readings` are never written in place — the same
	 * objects are shared with every other binding in this tick's collectRouteEntries() loop and
	 * were already handed off earlier (anomaly/quality processing, activityMonitor tracking).
	 */
	private filterMessagesForPublishInterval(
		messages: ProtocolMessage[],
		records: ProtocolMessage[],
		subscriptionId: number | null,
		endpointName: string,
		minIntervalMs: number,
	): ProtocolMessage[] {
		const now = Date.now();
		const allowed = new Set<ProtocolMessage>();

		for (const record of records) {
			const sourceName = this.readExternalNodeCandidate(record) ?? endpointName;
			const metric = this.resolveRecordMetric(record);
			const key = `${subscriptionId ?? 'none'}:${sourceName}:${metric}`;
			const lastAllowedAt = this.lastAllowedAtByPoint.get(key) ?? 0;
			if (lastAllowedAt > 0 && now - lastAllowedAt < minIntervalMs) {
				continue; // too soon since this point was last admitted for THIS subscription — drop
			}
			this.lastAllowedAtByPoint.set(key, now);
			allowed.add(record);
		}

		if (allowed.size === records.length) {
			return messages; // nothing throttled this tick — identical to the unthrottled path
		}

		// Rebuild preserving the original nested shape (rather than returning a flattened leaf
		// array) — buildPayload()'s 'custom' format embeds `messages` verbatim, including each
		// wrapper's .readings[]; flattening here would silently change that wire shape for any
		// 'custom'-format subscription the moment a Publish Interval is set. 'tags'/'ecp'/'ml'
		// are unaffected either way since buildPayload() re-flattens via collectTagRecords()
		// internally, which is idempotent on an already-flat array.
		const rebuilt: ProtocolMessage[] = [];
		for (const message of messages) {
			if (Array.isArray(message.readings)) {
				const keptReadings = message.readings.filter((reading) => allowed.has(reading));
				if (keptReadings.length === 0) continue;
				rebuilt.push(
					keptReadings.length === message.readings.length ? message : { ...message, readings: keptReadings },
				);
				continue;
			}
			if (allowed.has(message)) rebuilt.push(message);
		}
		return rebuilt;
	}

	private rebuildMessagesFromAllowed(messages: ProtocolMessage[], allowed: Set<ProtocolMessage>): ProtocolMessage[] {
		const rebuilt: ProtocolMessage[] = [];
		for (const message of messages) {
			if (Array.isArray(message.readings)) {
				const keptReadings = message.readings.filter((reading) => allowed.has(reading));
				if (keptReadings.length === 0) continue;
				rebuilt.push(
					keptReadings.length === message.readings.length ? message : { ...message, readings: keptReadings },
				);
				continue;
			}
			if (allowed.has(message)) rebuilt.push(message);
		}
		return rebuilt;
	}

	private inferEcpType(value: unknown): 1 | 2 | 3 | 4 {
		if (typeof value === 'boolean') {
			return 1;
		}

		if (typeof value === 'number') {
			if (Number.isInteger(value)) {
				return 2;
			}
			return 3;
		}

		return 4;
	}

	private async persistQueuedBatch(
		topic: string,
		data: PublishPayload,
		msgId: string,
	): Promise<number> {
		const MessageBufferModel = await this.getMessageBufferModel();
		const jsonPayload = JSON.stringify(data);

		return MessageBufferModel.enqueue({
			endpoint_name: this.config.name || 'unknown',
			topic,
			qos: 1,
			payload: jsonPayload,
			msg_id: msgId,
			payload_bytes: Buffer.byteLength(jsonPayload, 'utf8'),
		});
	}

	private async persistClaimedBatch(
		topic: string,
		data: PublishPayload,
		msgId: string,
	): Promise<{ id: number; lockId: string }> {
		const MessageBufferModel = await this.getMessageBufferModel();
		const jsonPayload = JSON.stringify(data);
		const lockId = `inline-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

		const id = MessageBufferModel.enqueueClaimed(
			{
				endpoint_name: this.config.name || 'unknown',
				topic,
				qos: 1,
				payload: jsonPayload,
				msg_id: msgId,
				payload_bytes: Buffer.byteLength(jsonPayload, 'utf8'),
			},
			lockId,
		);

		return { id, lockId };
	}

	private async publishOnline(
		topic: string,
		data: PublishPayload,
		msgId: string,
		baselineSize: number,
		messageCount: number,
		batchBytes: number,
		enriched: ProtocolMessage[],
		endpointName: string,
	): Promise<void> {
		if (this.needStop) return;
		let bufferedRecordId: number | undefined;
		let publishConfirmed = false;
		const destinationContext = this.getPublishDestinationLogContext(topic);

		try {
			const claimed = await this.persistClaimedBatch(topic, data, msgId);
			bufferedRecordId = claimed.id;
			if (this.needStop) {
				const MessageBufferModel = await this.getMessageBufferModel();
				MessageBufferModel.markRetryFailed(claimed.id, 'Publish interrupted during shutdown');
				this.batcher.reset();
				return;
			}

			const { payload, info } = await this.compressor.compress(data, baselineSize, this.stats.data.messagesPublished);
			if (this.needStop) {
				const MessageBufferModel = await this.getMessageBufferModel();
				MessageBufferModel.markRetryFailed(claimed.id, 'Publish interrupted during shutdown');
				this.batcher.reset();
				return;
			}

			const compressedPayloadCache = new Map<string, string | Buffer>();
			const compressionInfoCache = new Map<string, CompressionInfo>();
			compressedPayloadCache.set(`${this.payloadFormat}::global::fq=false`, payload);
			compressionInfoCache.set(`${this.payloadFormat}::global::fq=false`, info);
			await this.routePublishBatch(topic, compressedPayloadCache, compressionInfoCache, endpointName, enriched);
			publishConfirmed = true;

			// This point is only reached after routePublishBatch() has already delivered
			// the batch to the destination plugin without throwing — always "Published",
			// never "Buffered". mqttConnection here is the agent's own shared default
			// connection (unrelated to the destination plugin's own client), so its
			// publish mode describes a different link entirely and must not be used to
			// relabel this destination's delivery outcome. Surface it as separate
			// diagnostic context instead, only when actually degraded.
			const cloudLinkMode = this.mqttConnection.getPublishMode?.();
			const MessageBufferModel = await this.getMessageBufferModel();
			MessageBufferModel.deleteByIds([claimed.id]);
			this.stats.recordPublish(messageCount, batchBytes);
			this.stats.logPublishSuccess(messageCount, batchBytes, info, endpointName, this.logger, {
				...destinationContext,
				...(cloudLinkMode && cloudLinkMode !== 'direct' ? { cloudLinkMode } : {}),
			});
			this.batcher.reset();
		} catch (err) {
			this.logger?.error(`Failed to publish batch from endpoint '${endpointName}'`, err, destinationContext);
			await this.handlePublishFailure(endpointName, err, bufferedRecordId, publishConfirmed, topic, data, msgId, messageCount);
		}
	}

	private async handlePublishFailure(
		endpointName: string,
		err: unknown,
		bufferedRecordId: number | undefined,
		publishConfirmed: boolean,
		topic: string,
		data: PublishPayload,
		msgId: string,
		messageCount: number,
	): Promise<void> {
		try {
			if (publishConfirmed) {
				this.batcher.reset();
				this.logger?.error(
					`Published batch from endpoint '${endpointName}' but failed to clean durable buffer record; leaving claimed row for timeout recovery`,
					err,
				);
				return;
			}

			if (bufferedRecordId !== undefined) {
				const MessageBufferModel = await this.getMessageBufferModel();
				MessageBufferModel.markRetryFailed(
					bufferedRecordId,
					err instanceof Error ? err.message : String(err),
				);
				this.batcher.reset();
				this.logger?.warn(`Queued failed publish for endpoint '${endpointName}' for durable retry`);
				return;
			}

			await this.publishOffline(topic, data, msgId, messageCount);
			this.logger?.warn(`Buffered failed publish for endpoint '${endpointName}' to durable storage`);
		} catch (bufferError) {
			this.logger?.error(`Failed to durably buffer publish failure for endpoint '${endpointName}'`, bufferError);
		}
	}

	private getPublishDestinationLogContext(topic?: string): Record<string, unknown> | undefined {
		if (this.bindings.length === 0) {
			return undefined;
		}

		// Only include external (non-iotistica) routes — the internal endpointTopic is already shown separately.
		const externalRoutes: Array<{ destination: string; destinationTopic: string; payloadFormat: string; subscriptionId: number | undefined }> = [];
		for (const binding of this.bindings) {
			if ((binding.publisher.id ?? -1) === -1) continue; // skip default iotistica binding
			const destinationTopic = this.resolveDestinationTopic(binding, topic ?? '');
			if (!destinationTopic) continue;
			externalRoutes.push({
				destination: binding.publisher.name,
				destinationTopic,
				payloadFormat: this.resolvePayloadFormatForBinding(binding),
				subscriptionId: binding.subscription.id,
			});
		}

		return {
			protocol: this.protocol,
			endpointTopic: topic,
			...(externalRoutes.length > 0 ? { externalRoutes } : {}),
		};
	}

	private async publishOffline(
		topic: string,
		data: PublishPayload,
		msgId: string,
		messageCount: number,
	): Promise<void> {
		if (this.needStop) return;
		await this.bufferOfflineMessages(topic, data, msgId, messageCount);
	}

	private async bufferOfflineMessages(
		topic: string,
		data: PublishPayload,
		msgId: string,
		messageCount: number,
	): Promise<void> {
		const name = this.config.name || 'unknown';
		this.logger?.warn(`MQTT not connected  buffering ${messageCount} messages from '${name}'`);
		try {
			await this.persistQueuedBatch(topic, data, msgId);
			this.batcher.reset();
		} catch (err) {
			this.logger?.error(`Failed to buffer messages from device '${name}'`, err);
		}
	}

	// eslint-disable-next-line @typescript-eslint/consistent-type-imports
	private async getMessageBufferModel(): Promise<typeof import('../../db/models/buffer.model.js').MessageBufferModel> {
		if (this.messageBufferModel) {
			return this.messageBufferModel;
		}

		if (!this.messageBufferModelPromise) {
			this.messageBufferModelPromise = import('../../db/models/index.js')
				.then(({ MessageBufferModel }) => {
					this.messageBufferModel = MessageBufferModel;
					return MessageBufferModel;
				})
				.finally(() => {
					this.messageBufferModelPromise = undefined;
				});
		}

		return this.messageBufferModelPromise;
	}

	private startBufferTimer(): void {
		if (this.needStop) return;
		this.clearBufferTimer();
		this.bufferTimer = setInterval(() => {
			if (this.needStop) return;
			if (this.batcher.messageCount > 0) this.publishBatch();
			else this.flushPendingDatasetAccumulators();
		}, this.config.bufferTimeMs);
	}

	private clearBufferTimer(): void {
		if (this.bufferTimer) {
			clearInterval(this.bufferTimer);
			this.bufferTimer = null;
		}
	}

	private startDestinationHealthMonitor(): void {
		this.stopDestinationHealthMonitor();
		this.destinationHealthTimer = setInterval(() => {
			this.checkDestinationHealth().catch((err) => {
				this.logger?.error('Destination health check failed', err instanceof Error ? err : new Error(String(err)));
			});
		}, DESTINATION_HEALTH_INTERVAL_MS);
	}

	private stopDestinationHealthMonitor(): void {
		if (this.destinationHealthTimer) {
			clearInterval(this.destinationHealthTimer);
			this.destinationHealthTimer = null;
		}
		this.disconnectedSince.clear();
	}

	private async checkDestinationHealth(): Promise<void> {
		if (this.needStop) return;

		const seen = new Set<IPublishPlugin>();
		for (const [destId, { plugin, snapshot }] of this.pluginByDestinationId) {
			if (seen.has(plugin)) continue;
			seen.add(plugin);

			const publisher = this.bindings.find((b) => b.publisher.id === destId)?.publisher;
			const destName = publisher?.name ?? `destination-${destId}`;
			const destType = publisher?.type ?? 'unknown';
			const connected = plugin.isConnected();

			if (connected) {
				const offlineSince = this.disconnectedSince.get(plugin);
				if (offlineSince !== undefined) {
					const downtimeMs = Date.now() - offlineSince;
					this.logger?.info(`Destination back online`, {
						destination: destName,
						type: destType,
						destinationId: destId,
						downtimeSeconds: Math.round(downtimeMs / 1000),
					});
					this.disconnectedSince.delete(plugin);
				}
				continue;
			}

			if (!this.disconnectedSince.has(plugin)) {
				this.disconnectedSince.set(plugin, Date.now());
				this.logger?.info(`Destination offline`, {
					destination: destName,
					type: destType,
					destinationId: destId,
				});
				continue;
			}

			const offlineSince = this.disconnectedSince.get(plugin)!;
			const offlineMs = Date.now() - offlineSince;
			if (offlineMs < RECONNECT_FORCE_AFTER_MS) continue;

			this.logger?.info(`Destination offline for >${Math.round(RECONNECT_FORCE_AFTER_MS / 60_000)}min, forcing reconnect`, {
				destination: destName,
				type: destType,
				destinationId: destId,
				offlineSeconds: Math.round(offlineMs / 1000),
			});

			try {
				await plugin.stop();
				await plugin.start();
				this.disconnectedSince.set(plugin, Date.now());
				this.logger?.info(`Destination reconnect initiated`, {
					destination: destName,
					type: destType,
					destinationId: destId,
				});
			} catch (err) {
				this.disconnectedSince.set(plugin, Date.now());
				this.logger?.warn(`Destination reconnect failed, will retry next cycle`, {
					destination: destName,
					type: destType,
					destinationId: destId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	private attachConnectionHandlers(): void {
		if (this.connectionHandlersAttached) return;
		this.connection.on('connected', this.onConnected);
		this.connection.on('data', this.onData);
		this.connection.on('error', this.onConnectionError);
		this.connection.on('disconnected', this.onDisconnected);
		this.connection.on('reconnecting', this.onReconnecting);
		this.connectionHandlersAttached = true;
	}

	private detachConnectionHandlers(): void {
		if (!this.connectionHandlersAttached) return;
		this.connection.off('connected', this.onConnected);
		this.connection.off('data', this.onData);
		this.connection.off('error', this.onConnectionError);
		this.connection.off('disconnected', this.onDisconnected);
		this.connection.off('reconnecting', this.onReconnecting);
		this.connectionHandlersAttached = false;
	}

	private isConnected(): boolean {
		const plugins = this.getUniquePlugins();
		if (plugins.length === 0) {
			return false;
		}

		return plugins.some((plugin) => plugin.isConnected());
	}

	public getPublishDestinationInfo(): PublishDestinationInfo[] {
		if (this.bindings.length === 0) {
			return [];
		}

		const byDestination = new Map<number, PublishDestinationInfo>();

		for (const binding of this.bindings) {
			const destinationId = binding.publisher.id ?? -1;
			const normalizedDestinationType = normalizeTarget(binding.publisher.type);
			const existing = byDestination.get(destinationId);
			if (!existing) {
				byDestination.set(destinationId, {
					destinationId: binding.publisher.id,
					destinationName: binding.publisher.name,
					destinationType: normalizedDestinationType,
					subscriptionIds: binding.subscription.id !== undefined ? [binding.subscription.id] : [],
					topics: this.normalizeTopics(binding.subscription.topics),
				});
				continue;
			}

			if (binding.subscription.id !== undefined && !existing.subscriptionIds.includes(binding.subscription.id)) {
				existing.subscriptionIds.push(binding.subscription.id);
			}

			for (const topic of this.normalizeTopics(binding.subscription.topics)) {
				if (!existing.topics.includes(topic)) {
					existing.topics.push(topic);
				}
			}
		}

		for (const destination of byDestination.values()) {
			destination.subscriptionIds.sort((a, b) => a - b);
			destination.topics.sort();
		}

		return Array.from(byDestination.values());
	}

	private resolveDestinationTopic(binding: HostBinding, sourceTopic: string): string | null {
		if ((binding.publisher.id ?? -1) === -1) {
			return sourceTopic;
		}

		// Iotistica always publishes on the agent's structured MQTT topic regardless of what's stored
		if (binding.publisher.type === 'iotistica') {
			return agentTopic(this.deviceUuid, 'endpoints', this.config.mqttTopic);
		}

		const route = binding.subscription.route_json as PublishSubscriptionRoute | null;
		const destinationTopic = typeof route?.topic === 'string' ? route.topic.trim() : '';
		if (destinationTopic.length === 0) {
			// InfluxDB uses an optional measurement name — empty topic is valid, plugin defaults to 'metrics'.
			// TimescaleDB has no per-topic column at all, so an empty topic is likewise valid and ignored.
			if (binding.publisher.type === 'influxdb' || binding.publisher.type === 'timescaledb') {
				return '';
			}
			this.logger?.warn('Skipping publish binding without route_json.topic destination', {
				component: 'PublishManager',
				protocol: this.protocol,
				endpoint: this.endpointName,
				destinationId: binding.publisher.id,
				destinationName: binding.publisher.name,
				subscriptionId: binding.subscription.id,
			});
			return null;
		}

		return destinationTopic;
	}

	private async routePublishBatch(
		sourceTopic: string,
		compressedPayloadCache: Map<string, string | Buffer>,
		compressionInfoCache: Map<string, CompressionInfo>,
		endpointName: string,
		messages: ProtocolMessage[],
	): Promise<void> {
		if (this.bindings.length === 0) {
			throw new Error('No publish destinations configured');
		}

		const entries = await this.collectRouteEntries(sourceTopic, compressedPayloadCache, compressionInfoCache, endpointName, messages);
		if (entries.length === 0) {
			throw new Error('No valid publish destinations configured (missing route_json.topic)');
		}

		const results = await Promise.allSettled(entries.map(([plugin, batch]) => plugin.publishBatch(batch)));
		const failures = results.filter((result) => result.status === 'rejected');
		if (failures.length === 0) {
			return;
		}

		if (failures.length === results.length) {
			const first = failures[0]?.reason;
			throw first instanceof Error ? first : new Error(String(first));
		}

		this.logger?.warn('Some publish destinations failed while others succeeded', {
			component: 'PublishManager',
			protocol: this.protocol,
			endpoint: this.endpointName,
			failedDestinations: failures.length,
			totalDestinations: entries.length,
		});
	}

	private async collectRouteEntries(
		sourceTopic: string,
		compressedPayloadCache: Map<string, string | Buffer>,
		compressionInfoCache: Map<string, CompressionInfo>,
		endpointName: string,
		messages: ProtocolMessage[],
	): Promise<Array<[IPublishPlugin, PublishBatchItem[]]>> {

		const batchesByPlugin = new Map<IPublishPlugin, PublishBatchItem[]>();
		const eventRecordedPoints = new Set<string>();
		for (const binding of this.bindings) {
			const destinationTopic = this.resolveDestinationTopic(binding, sourceTopic);
			if (destinationTopic === null) {
				continue;
			}

			const payloadFormat = this.resolvePayloadFormatForBinding(binding);
			const route = binding.subscription.route_json as PublishSubscriptionRoute | null;
			const qualities = Array.isArray(route?.qualities) ? route.qualities : [];
			// Only drop bad-quality readings when the subscription explicitly restricts to
			// specific qualities and 'BAD' is not in that list.
			let filterBadQuality = qualities.length > 0 && !qualities.includes('BAD');
			if (binding.datasetConfig?.exclude_bad_quality) {
				filterBadQuality = true;
			}
			const subscriptionCompression = (binding.subscription.compression ?? null);

			// Dataset-linked subscriptions use windowed aggregation: accumulate matching
			// readings across buffer ticks, then flush all features as one combined
			// message when the sampling interval elapses.
			if (binding.datasetPointKeys && binding.subscription.id !== undefined) {
				const subscriptionId = binding.subscription.id;
				if (!this.sharedDatasetAccumulators) continue;
				const entry = this.sharedDatasetAccumulators.get(subscriptionId);
				if (!entry) continue;
				entry.destinationTopic = destinationTopic;

				const allowedKeys = binding.datasetPointKeys;
				const allRecords = this.collectTagRecords(messages);
				for (const record of allRecords) {
					const pi = record.pointIdentity as PointIdentity | undefined;
					const sourceName = this.readExternalNodeCandidate(record) ?? endpointName;
					const metric = pi?.normalizedName ?? this.resolveRecordMetric(record);
					const pointKey = JSON.stringify([sourceName, metric]);
					if (!allowedKeys.has(pointKey)) continue;
					if (filterBadQuality) {
						const quality = typeof record.quality === 'string' ? record.quality.toUpperCase() : undefined;
						if (quality === 'BAD') continue;
					}
					const feature = this.mapMlFeaturePayload(record, 0);
					const ts = typeof record.timestamp === 'string' ? new Date(record.timestamp).getTime() : Date.now();
					entry.features.set(pointKey, {
						feature,
						sourceName,
						observedAt: Number.isFinite(ts) ? ts : Date.now(),
					});
				}

				// Activity monitor recording for dataset points
				if (binding.publisher.id !== undefined) {
					for (const record of allRecords) {
						const pi = record.pointIdentity as PointIdentity | undefined;
						const sourceName = this.readExternalNodeCandidate(record) ?? endpointName;
						const metric = pi?.normalizedName ?? this.resolveRecordMetric(record);
						const pointKey = JSON.stringify([sourceName, metric]);
						if (!allowedKeys.has(pointKey)) continue;
						const pointIdentityFields = this.readPointIdentity(record);
						const rulesVersion = (record?.pointIdentity as PointIdentity | undefined)?.rulesVersion;
						const rawObjectName = typeof record?.rawObjectName === 'string' ? record.rawObjectName : undefined;
						const rawPointName = typeof record?.rawPointName === 'string' ? record.rawPointName : undefined;
						const params = {
							subscriptionId: binding.subscription.id ?? null,
							destinationId: binding.publisher.id,
							destinationName: binding.publisher.name,
							destinationType: binding.publisher.type,
							protocol: this.protocol,
							endpointName: sourceName,
							metric,
							value: record?.value ?? record?.rawValue ?? null,
							unit: typeof record?.unit === 'string' ? record.unit : undefined,
							quality: typeof record?.quality === 'string' ? record.quality : undefined,
							pointCount: allRecords.length,
							...pointIdentityFields,
							...(rulesVersion && { rulesVersion }),
							...(rawObjectName && { rawObjectName }),
							...(rawPointName && { rawPointName }),
						};
						const eventKey = JSON.stringify([this.protocol, sourceName, metric]);
						if (eventRecordedPoints.has(eventKey)) {
							activityMonitor.recordSubscriptionOnly(params);
						} else {
							activityMonitor.record(params);
							eventRecordedPoints.add(eventKey);
						}
					}
				}

				const now = Date.now();
				if (now - entry.lastFlushedAt >= entry.samplingIntervalMs && !entry.flushing) {
					await this.flushDatasetAccumulatorEntry(entry, binding, destinationTopic, endpointName, sourceTopic, batchesByPlugin);
				}

				continue;
			}

			// Non-dataset binding: standard point filtering and throttle path.
			const bindingMessages = messages;

			// "Publish interval" throttle. `records` is computed eagerly whenever either the
			// throttle needs it OR the activityMonitor loop below needs it — preserves the
			// previous lazy-computation cost for the common case where neither applies.
			const routeMinIntervalMs = typeof route?.minIntervalMs === 'number' && route.minIntervalMs > 0
				? route.minIntervalMs
				: 0;
			const minIntervalMs = routeMinIntervalMs;
			const records = (minIntervalMs > 0 || binding.publisher.id !== undefined)
				? this.collectTagRecords(bindingMessages)
				: [];
			const effectiveMessages = minIntervalMs > 0
				? this.filterMessagesForPublishInterval(bindingMessages, records, binding.subscription.id ?? null, endpointName, minIntervalMs)
				: bindingMessages;

			// Throttled subscriptions build their payload from a per-binding-filtered
			// subset of `messages`, so they can never safely share a compressedPayloadCache
			// entry with another binding — make the key unique.
			const hasPerBindingFilter = minIntervalMs > 0;
			const cacheKey = hasPerBindingFilter
				? `${payloadFormat}::${subscriptionCompression ?? 'global'}::fq=${filterBadQuality}::sub=${binding.subscription.id ?? 'none'}`
				: subscriptionCompression
					? `${payloadFormat}::${subscriptionCompression}::fq=${filterBadQuality}`
					: `${payloadFormat}::global::fq=${filterBadQuality}`;
			const overrideOpts = subscriptionCompression ? compressionToOpts(subscriptionCompression) : undefined;

			// Every point for this binding currently throttled → send nothing this tick,
			// mirroring SocketServer.routeAndSendToSocket()'s "filteredPoints.length === 0 →
			// return" precedent, instead of publishing an empty/near-empty batch.
			const allThrottledOut = minIntervalMs > 0 && effectiveMessages.length === 0 && bindingMessages.length > 0;
			let payload: string | Buffer | null = null;
			let compressionInfo: CompressionInfo | undefined;
			if (!allThrottledOut) {
				const compressed = await this.getCompressedPayloadForFormat(
					payloadFormat,
					cacheKey,
					endpointName,
					effectiveMessages,
					compressedPayloadCache,
					compressionInfoCache,
					overrideOpts,
					filterBadQuality,
					binding.datasetConfig,
				);
				payload = compressed.payload;
				compressionInfo = compressed.info;
			}

			this.logger?.debug('Routing batch to destination', {
				component: 'PublishManager',
				protocol: this.protocol,
				endpointName,
				destinationName: binding.publisher.name,
				destinationType: binding.publisher.type,
				destinationTopic,
				payloadFormat,
				compression: subscriptionCompression ?? 'global',
				subscriptionId: binding.subscription.id ?? null,
				messageCount: bindingMessages.length,
				...(minIntervalMs > 0 && { publishIntervalMs: minIntervalMs, throttledOut: allThrottledOut }),
			});

			if (binding.publisher.id !== undefined) {
				// Deliberately unaffected by the throttle above — Recent Activity reflects
				// everything this endpoint actually reported for this subscription, regardless
				// of whether this tick's outgoing payload to the destination was itself
				// throttled down to nothing.
				const byPoint = new Map<string, { metric: string; sourceName: string; record: ProtocolMessage }>();
				for (const record of records) {
					const metric = this.resolveRecordMetric(record);
					const sourceName = this.readExternalNodeCandidate(record) ?? endpointName;
					byPoint.set(JSON.stringify([sourceName, metric]), { metric, sourceName, record });
				}
				for (const [, { metric, sourceName, record }] of byPoint) {
					const pointIdentityFields = this.readPointIdentity(record);
					const rulesVersion = (record?.pointIdentity as PointIdentity | undefined)?.rulesVersion;
					const rawObjectName = typeof record?.rawObjectName === 'string' ? record.rawObjectName : undefined;
					const rawPointName = typeof record?.rawPointName === 'string' ? record.rawPointName : undefined;

					const params = {
						subscriptionId: binding.subscription.id ?? null,
						destinationId: binding.publisher.id,
						destinationName: binding.publisher.name,
						destinationType: binding.publisher.type,
						protocol: this.protocol,
						endpointName: sourceName,
						metric,
						value: record?.value ?? record?.rawValue ?? null,
						unit: typeof record?.unit === 'string' ? record.unit : undefined,
						quality: typeof record?.quality === 'string' ? record.quality : undefined,
						pointCount: records.length,
						...pointIdentityFields,
						...(rulesVersion && { rulesVersion }),
						...(rawObjectName && { rawObjectName }),
						...(rawPointName && { rawPointName }),
					};

					const eventKey = JSON.stringify([this.protocol, sourceName, metric]);
					if (eventRecordedPoints.has(eventKey)) {
						activityMonitor.recordSubscriptionOnly(params);
					} else {
						activityMonitor.record(params);
						eventRecordedPoints.add(eventKey);
					}
				}
			}

			if (payload !== null) {
				if (compressionInfo) {
					activityMonitor.recordCompression(destinationTopic, compressionInfo);
				}
				const items = batchesByPlugin.get(binding.plugin) || [];
				items.push({
					topic: sourceTopic,
					payload,
					options: {
						qos: 1,
						destinationTopic,
					},
				});
				batchesByPlugin.set(binding.plugin, items);
			}
		}

		return Array.from(batchesByPlugin.entries());
	}

	private destinationSnapshot(destination: PublisherRecord): string {
		return JSON.stringify({
			type: destination.type,
			name: destination.name,
			enabled: destination.enabled,
			config_json: destination.config_json ?? null,
		});
	}

	private loadBindings(): HostBinding[] {
		const destinations = PublishDestinationsModel.getAll(false);
		const subscriptions = PublishSubscriptionsModel.getAll(false);
		const cloudConnected = this.defaultClient.isConnected();

		if (subscriptions.length === 0 || destinations.length === 0) {
			// No destinations left at all — every cached plugin is genuinely stale.
			this.pluginByDestinationId.clear();
			return cloudConnected ? this.createDefaultIotisticaBinding() : [];
		}

		const destinationsById = new Map<number, PublisherRecord>();
		for (const destination of destinations) {
			if (destination.id !== undefined) {
				destinationsById.set(destination.id, destination);
			}
		}

		// Drop cache entries for destinations that were deleted since the last reload —
		// this is the only case that legitimately invalidates without a config-change
		// check below, since there's no destination record left to compare against.
		for (const id of this.pluginByDestinationId.keys()) {
			if (!destinationsById.has(id)) {
				this.pluginByDestinationId.delete(id);
			}
		}

		const bindings: HostBinding[] = [];

		for (const subscription of subscriptions) {
			const destination = destinationsById.get(subscription.publish_destination_id);
			if (!destination) {
				continue;
			}

			if (!this.matchesSubscription(subscription)) {
				continue;
			}

			// Reuse the cached plugin (and its live MQTT connection) unless this specific
			// destination's config actually changed since it was built. Rebuilding
			// unconditionally on every reload — which happens far more often than actual
			// config edits, e.g. once per endpoint during a bulk device import — used to
			// tear down and recreate every external MQTT client on every reload, which the
			// broker sees as the same clientId reconnecting in a tight loop ("already
			// connected, closing old connection") instead of one stable connection.
			const snapshot = this.destinationSnapshot(destination);
			const cached = this.pluginByDestinationId.get(subscription.publish_destination_id);
			let plugin: IPublishPlugin;
			if (cached?.snapshot === snapshot) {
				plugin = cached.plugin;
			} else {
				plugin = this.buildPlugin(destination, this.defaultClient, this.logger, this.endpointName);
				this.pluginByDestinationId.set(subscription.publish_destination_id, { plugin, snapshot });
			}

			const binding: HostBinding = { subscription, publisher: destination, plugin };

			if (subscription.ml_dataset_id) {
				const dataset = MlDatasetModel.getByIdUnscoped(subscription.ml_dataset_id);
				if (!dataset) {
					continue;
				}
				let rawKeys: unknown[];
				try {
					rawKeys = JSON.parse(dataset.point_keys);
				} catch {
					continue;
				}
				const keys = new Set<string>();
				for (const rawKey of rawKeys) {
					const key = typeof rawKey === 'string' ? JSON.parse(rawKey) : rawKey;
					if (Array.isArray(key) && key.length >= 3 && key[0] === this.protocol) {
						keys.add(JSON.stringify([key[1], key[2]]));
					}
				}
				if (keys.size === 0) {
					continue;
				}
				binding.datasetPointKeys = keys;
				binding.datasetSamplingIntervalMs = dataset.sampling_interval_secs * 1000;
				binding.datasetConfig = dataset;
			}

			bindings.push(binding);
		}

		const hasConfiguredIotisticaBinding = bindings.some((binding) => {
			const destinationType = normalizeTarget(binding.publisher.type);
			return destinationType === 'iotistica';
		});

		if (!hasConfiguredIotisticaBinding && cloudConnected) {
			return [...this.createDefaultIotisticaBinding(), ...bindings];
		}

		return bindings;
	}

	private createDefaultIotisticaBinding(): HostBinding[] {
		const target = 'iotistica';
		const publisher: PublisherRecord = {
			id: -1,
			name: target,
			type: target,
			config_json: null,
			enabled: true,
			use_for_commands: false,
		};
		const plugin = this.buildPlugin(publisher, this.defaultClient, this.logger, this.endpointName);
		return [{
			subscription: {
				publish_destination_id: -1,
				topics: [],
				payload_format: 'custom',
				enabled: true,
			},
			publisher: {
				...publisher,
			},
			plugin,
		}];
	}

	private getUniquePlugins(): IPublishPlugin[] {
		const deduped = new Set<IPublishPlugin>();
		for (const binding of this.bindings) {
			deduped.add(binding.plugin);
		}
		return Array.from(deduped);
	}

	private matchesSubscription(subscription: PublishSubscriptionRecord): boolean {
		const topics = Array.isArray(subscription.topics) ? subscription.topics : [];
		if (topics.length > 0 && !topics.includes(this.protocol)) {
			return false;
		}

		const route = subscription.route_json as PublishSubscriptionRoute | null;
		if (!route) {
			return true;
		}

		if (Array.isArray(route.includeDevices) && route.includeDevices.length > 0) {
			if (!route.includeDevices.includes(this.endpointName)) {
				return false;
			}
		}

		if (Array.isArray(route.excludeDevices) && route.excludeDevices.length > 0) {
			if (route.excludeDevices.includes(this.endpointName)) {
				return false;
			}
		}

		return true;
	}

	private normalizeTopics(topics: string[] | undefined): string[] {
		if (!Array.isArray(topics) || topics.length === 0) {
			return ['*'];
		}

		const normalized = topics
			.map((topic) => topic.trim())
			.filter((topic) => topic.length > 0);

		return normalized.length > 0 ? normalized : ['*'];
	}

	private projectReadingForSchemaDrift(
		reading: ProtocolMessage,
	): ProtocolMessage {
		const pointIdentity =
		reading.pointIdentity as PointIdentity | undefined;

		const normalizedName =
		typeof pointIdentity?.normalizedName === 'string' &&
		pointIdentity.normalizedName.trim().length > 0
			? pointIdentity.normalizedName.trim()
			: undefined;

		const rawMetric =
		typeof reading.metric === 'string'
			? reading.metric
			: typeof reading.name === 'string'
				? reading.name
				: undefined;

		// Strip annotations the live-data interceptor pipeline itself attaches
		// (unitValue from unit normalization, dataQuality from the quality
		// interceptor, pointIdentity from point-name normalization -- the
		// complete, current liveDataInterceptor chain, see src/init/features.ts).
		// These describe how OUR pipeline processed the reading; they are not
		// part of the device's own reported schema. Left in, SchemaDriftDetector's
		// generic key traversal (it walks every object key it doesn't recognize)
		// picks them up as "new fields" each time one gets attached -- and for a
		// point whose enrichment only lands occasionally, that can repeat
		// indefinitely instead of ever settling into the baseline.
		const deviceReported: ProtocolMessage = { ...reading };
		delete deviceReported.unitValue;
		delete deviceReported.dataQuality;
		delete deviceReported.pointIdentity;

		return {
			...deviceReported,

			// Preserve source evidence for diagnostics and future drift reporting.
			...(rawMetric && { rawMetric }),

			// SchemaDriftDetector continues using its existing `metric` extractor,
			// but now receives the canonical point name.
			...(normalizedName && { metric: normalizedName }),
		};
	}

	private projectMessagesForSchemaDrift(
		messages: ProtocolMessage[],
	): ProtocolMessage[] {
		return messages.map((message) => {
			if (Array.isArray(message.readings)) {
				return {
					...message,
					readings: message.readings.map((reading) =>
						this.projectReadingForSchemaDrift(reading),
					),
				};
			}

			return this.projectReadingForSchemaDrift(message);
		});
	}
}
