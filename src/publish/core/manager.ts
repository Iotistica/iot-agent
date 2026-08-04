import { EventEmitter } from 'events';
import { getHeapStatistics } from 'v8';
import { agentTopic } from '../../mqtt/topics.js';
import type { Protocol } from '../../plugins/protocol.js';
import type { DeviceConfig, MqttConnection, Logger, DeviceStats, IPublishClient, IPublishPlugin } from './types.js';
import { DeviceState, normalizeTarget } from './types.js';
import { AnomalyFeed } from '../anomaly/feed.js';
import { AnomalyEnricher } from '../anomaly/enrich.js';
import { PayloadCompressor } from './compress.js';
import type { CompressorOptions } from './compress.js';
import { compressionToOpts } from './compress.js';
import { MessageBatcher } from './batch.js';
import { SocketConnection } from './socket.js';
import { PublishStats } from './stats.js';
import { HeartbeatManager } from './heartbeat.js';
import { createHash } from 'crypto';
import { loadSchemaDrift } from '../../pro/loader.js';
import { SchemaDriftModel } from '../../db/models/schema-drift.model.js';
import type { AnomalyEventPayload } from '../../db/models/anomaly-event.model.js';
import type { DictionaryManager } from '../../mqtt/dictionary.js';
import type { PublishDestinationInfo, PublishBatchItem } from './types.js';
import { PublishDestinationsModel, PublishSubscriptionsModel } from '../../db/models/index.js';
import type { PublisherRecord, PublishSubscriptionRecord, PublishSubscriptionRoute } from '../../db/models/index.js';
import { activityMonitor } from './activity-monitor.js';
import { cleanDriftFieldName, prettifyDriftDeviceId, cleanProtocolPipeName, stripFieldDevicePrefix } from '../../db/models/drift-labels.js';
import { buildCompactIssueCodes } from '../../quality/index.js';
import type { DataQuality } from '../../quality/index.js';
import type { PointIdentity } from '../../point-name/index.js';

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

		// setIncidentCorrelator() may already have been called before this resolved
		// (it's async, called from the constructor) — re-apply now that there's
		// finally a detector instance to wire it into.
		if (this.incidentCorrelator) {
			this.schemaDriftDetector.setDriftAlertHandler((event: DriftAlertEvent) => this.handleDriftAlert(event));
		}
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
		// Only missing-field/type-drift indicate real breakage; new-field and
		// rename-candidate are still just informational even when the user has
		// opted into alerting on them.
		const severity = event.driftType === 'missing-field' || event.driftType === 'type-drift'
			? 'critical' as const
			: 'warning' as const;

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
		this.connection.connect();
	}

	async stop(): Promise<void> {
		const name = this.config.name || 'unknown';
		this.logger?.info(`Stopping endpoint '${name}'`);
		this.needStop = true;

		this.heartbeat?.stop();
		this.clearBufferTimer();
		this.detachConnectionHandlers();
		this.connection.disconnect();

		if (this.batcher.messageCount > 0) await this.publishBatch();

		for (const plugin of this.getUniquePlugins()) {
			await plugin.stop();
		}

		this.bindings = [];
		this.pluginByDestinationId.clear();
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

		this.logger?.info('Reloaded publish bindings', { bindingCount: this.bindings.length });
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

			this.driftAccumulator.push(...messages);
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

	private buildPayload(endpointName: string, messages: ProtocolMessage[], payloadFormat: PayloadFormat, filterBadQuality = false): {
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

			const data = {
				timestamp: timestampMs,
				node: externalNodeName,
				group: externalGroupName,
				schema: 'iotistica.ml.v1',
				features,
			};

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
		const rawName = String(
			message.metric
			?? message.metric_name
			?? message.nodeName
			?? message.name
			?? message.tag
			?? message.id
			?? `tag_${index}`,
		);
		const pointIdentity = message.pointIdentity as PointIdentity | undefined;
		// Standardized primary identifier (see timescaledb.ts): normalized point name
		// when available, falling back to the raw protocol identifier otherwise. Never
		// loses the raw value — always also carried as `rawName`.
		const name = pointIdentity?.normalizedName ?? rawName;
		const provisionalPointId = pointIdentity?.provisionalPointId;

		const unitFields = this.readNormalizedUnit(message);
		const qualityFields = this.readQualityFields(message);

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
				...(provisionalPointId && { provisionalPointId }),
			};
		}

		return { name, rawName, value, ...unitFields, ...qualityFields, ...(provisionalPointId && { provisionalPointId }) };
	}

	private mapMlFeaturePayload(message: ProtocolMessage, index: number): MlFeaturePayload {
		const rawName = String(
			message.metric
			?? message.metric_name
			?? message.nodeName
			?? message.name
			?? message.tag
			?? message.id
			?? `tag_${index}`,
		);
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

	private attachMlEnrichment(feature: MlFeaturePayload, message: ProtocolMessage): void {
		if (typeof message.anomaly_score === 'number') feature.anomaly_score = message.anomaly_score;
		if (typeof message.anomaly_threshold === 'number') feature.anomaly_threshold = message.anomaly_threshold;
		if (typeof message.baseline_samples === 'number') feature.baseline_samples = message.baseline_samples;
		if (Array.isArray(message.detection_methods)) feature.detection_methods = message.detection_methods as string[];
		if (typeof message.trend === 'string') feature.trend = message.trend;
		if (typeof message.trend_strength === 'number') feature.trend_strength = message.trend_strength;
		if (typeof message.predicted_next === 'number') feature.predicted_next = message.predicted_next;
		if (typeof message.forecast_confidence === 'number') feature.forecast_confidence = message.forecast_confidence;
		if (message.device_state !== undefined) feature.device_state = message.device_state;
		if (typeof message.state_duration_seconds === 'number') feature.state_duration_seconds = message.state_duration_seconds;
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
		overrideOpts?: CompressorOptions,
		filterBadQuality = false,
	): Promise<string | Buffer> {
		const cached = compressedPayloadCache.get(cacheKey);
		if (cached !== undefined) {
			return cached;
		}

		const { data, baselineSize } = this.buildPayload(endpointName, messages, payloadFormat, filterBadQuality);
		const { payload } = await this.compressor.compress(data, baselineSize, this.stats.data.messagesPublished, overrideOpts);
		compressedPayloadCache.set(cacheKey, payload);
		return payload;
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
			compressedPayloadCache.set(`${this.payloadFormat}::global::fq=false`, payload);
			await this.routePublishBatch(topic, compressedPayloadCache, endpointName, enriched);
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
		}, this.config.bufferTimeMs);
	}

	private clearBufferTimer(): void {
		if (this.bufferTimer) {
			clearInterval(this.bufferTimer);
			this.bufferTimer = null;
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
		endpointName: string,
		messages: ProtocolMessage[],
	): Promise<void> {
		if (this.bindings.length === 0) {
			throw new Error('No publish destinations configured');
		}

		const entries = await this.collectRouteEntries(sourceTopic, compressedPayloadCache, endpointName, messages);
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
		endpointName: string,
		messages: ProtocolMessage[],
	): Promise<Array<[IPublishPlugin, PublishBatchItem[]]>> {

		const batchesByPlugin = new Map<IPublishPlugin, PublishBatchItem[]>();
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
			const filterBadQuality = qualities.length > 0 && !qualities.includes('BAD');
			const subscriptionCompression = (binding.subscription.compression ?? null);
			const cacheKey = subscriptionCompression
				? `${payloadFormat}::${subscriptionCompression}::fq=${filterBadQuality}`
				: `${payloadFormat}::global::fq=${filterBadQuality}`;
			const overrideOpts = subscriptionCompression ? compressionToOpts(subscriptionCompression) : undefined;
			const payload = await this.getCompressedPayloadForFormat(
				payloadFormat,
				cacheKey,
				endpointName,
				messages,
				compressedPayloadCache,
				overrideOpts,
				filterBadQuality,
			);

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
				messageCount: messages.length,
			});

			if (binding.publisher.id !== undefined) {
				const records = this.collectTagRecords(messages);
				// A batch carries every metric the endpoint polled this tick, not just one —
				// dedupe by metric name (keeping the last reading, same convention as the ECP
				// payload format) so Recent Activity shows the full spread instead of only
				// whichever tag happened to be first in the batch.
				const byMetric = new Map<string, ProtocolMessage>();
				for (const record of records) {
					const metric = String(
						record?.metric ?? record?.metric_name ?? record?.nodeName ?? record?.name ?? record?.tag ?? record?.id ?? '—',
					);
					byMetric.set(metric, record);
				}
				for (const [metric, record] of byMetric) {
					// Prefer the reading's own device identity (the same field the actual
					// outbound MQTT "node" name is resolved from, see resolveExternalNodeName)
					// over the coarse protocol-group endpointName — a single protocol group
					// batches readings from multiple devices, so "opcua"/"bacnet" alone tells
					// an operator nothing about which device a row in the Data Flow page came
					// from. Falls back to the group name when a reading has no device field.
					const sourceName = this.readExternalNodeCandidate(record) ?? endpointName;
					// Reuses the same compact projection mapTagPayload()/attachMlEnrichment() already
					// use for provisionalPointId/normalizedName. rulesVersion is read separately here
					// (not via readPointIdentity()) because that helper's contract deliberately never
					// carries rulesVersion into tag/ml payloads — see its doc comment above.
					const pointIdentityFields = this.readPointIdentity(record);
					const rulesVersion = (record?.pointIdentity as PointIdentity | undefined)?.rulesVersion;
					// True protocol-reported name (currently BACnet only — see plugins/types.ts's
					// DeviceDataPoint.rawObjectName doc comment), when the adapter captured one
					// separately from the sanitized `metric` identifier. Display-only.
					const rawObjectName = typeof record?.rawObjectName === 'string' ? record.rawObjectName : undefined;

					const rawPointName =typeof record?.rawPointName === 'string'? record.rawPointName: undefined;

					if (this.protocol === 'bacnet') {
		
					this.logger?.info('BACnet names before ActivityMonitor', {
						metric,
						rawObjectName,
						rawPointName,
						deviceName: record?.deviceName,
						sourceName,
					});

    }

					activityMonitor.record({
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
					});
				}
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

			bindings.push({ subscription, publisher: destination, plugin });
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
}
