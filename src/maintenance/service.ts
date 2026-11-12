/**
 * MAINTENANCE / ENERGY RECOMMENDATIONS SERVICE
 * ==============================================
 *
 * Unlike anomaly detection (a per-datapoint synchronous dispatcher — see
 * ../anomaly/detection-runner.ts), several of these rule types (schedule
 * mismatch, cumulative counters re-checked even with no new sample) need
 * re-evaluation against the clock, not just against incoming data. So this
 * service runs its own periodic tick — the "detection-runner-style loop"
 * from docs/preventive-maintenance-energy-plan.md Phase 1 step 4 — the same
 * kind of self-contained internal timer AnomalyDetectionService already
 * uses for periodic baseline persistence (service.ts's startPeriodicBaselineSave).
 *
 * Data still arrives the same way anomaly gets it: Community calls
 * processDataPoint() at the same call sites it already calls
 * anomalyService.processDataPoint() — this service just also keeps its own
 * rolling buffers (reusing ../anomaly/buffer.ts) rather than sharing
 * anomaly's, since the two modules' warm-up/retention needs differ.
 *
 * Phase 3 (publishing): mirrors AnomalyDetectionService's alert-publish
 * pattern exactly (see initAlertMqttClient/emitAnomalyEvent in
 * ../anomaly/service.ts) — same injected options bag (buildTopic,
 * getAlertDestination, createAlertMqttClient), same shared
 * publish_destinations table (via the injected callback, never queried
 * directly here), one long-lived alert client per module reconnected only
 * when alertDestinationId changes. Unlike anomaly (which publishes on every
 * detected event), this only publishes when upsert() reports a brand-new
 * recommendation (see storage.ts's UpsertResult.isNew) — publishing on every
 * re-evaluation tick of an already-open row would turn an "event-shaped"
 * recommendation into the continuous metric stream the plan doc explicitly
 * says this is not.
 */

import type { DatabaseSync as Database } from 'node:sqlite';
import { createBuffer, addValue } from '../anomaly/buffer.js';
import type { StatisticalBuffer } from '../anomaly/types.js';
import type { IPublishClient, AgentLogger } from '../shared/types.js';
import { MaintenanceEnergyStorageService, type RecommendationPublishModule } from './storage.js';
import { DebounceTracker } from './debounce.js';
import {
	evaluateCumulativeRuntime,
	evaluateCycleCount,
	evaluateThresholdDuration,
	evaluateStandbyWaste,
	evaluateScheduleMismatch,
	evaluateDutyCycle,
} from './evaluators.js';
import type {
	EvaluatorContext,
	EvaluationOutcome,
	CumulativeRuntimeRuleConfig,
	CycleCountRuleConfig,
	ThresholdDurationRuleConfig,
	StandbyWasteRuleConfig,
	ScheduleMismatchRuleConfig,
	DutyCycleRuleConfig,
} from './types.js';

export interface AlertDestinationRecord {
	id: number;
	type: string;
	config_json?: Record<string, unknown> | null;
}

export interface RecommendationPublishPayload {
	module: RecommendationPublishModule;
	assetName: string;
	criticality: string;
	component?: string;
	metric?: string;
	ruleType: string;
	message: string;
	status: 'open';
	dueBy?: number | null;
	estimatedImpact?: string | null;
	confidence: number | null;
	timestampMs: number;
}

export interface MaintenanceEnergyOptions {
	/** How often to re-evaluate all enabled rules. Default 60s. */
	tickIntervalMs?: number;
	/** Rolling-buffer capacity per metric, in samples (not a time span — see class doc). Default 500. */
	bufferSize?: number;
	logger?: AgentLogger;
	/** Cloud MQTT connection (e.g. CloudMqttClient.getInstance()) — the "cloud" publish leg, same as AnomalyDetectionService's mqttManager. */
	mqttManager?: { isConnected(): boolean; publish(topic: string, payload: unknown, options?: { qos?: 0 | 1 | 2; retain?: boolean }): Promise<void> };
	deviceUuid?: string;
	buildTopic?: (deviceUuid: string, ...segments: string[]) => string;
	getAlertDestination?: (id: number) => AlertDestinationRecord | null;
	createAlertMqttClient?: (config: Record<string, unknown> | null | undefined, deviceId?: string, name?: string, logger?: AgentLogger) => IPublishClient | null;
}

export class MaintenanceEnergyService {
	private storage: MaintenanceEnergyStorageService;
	private buffers = new Map<string, StatisticalBuffer>();
	private debounce = new DebounceTracker();
	private tickTimer: ReturnType<typeof setInterval> | null = null;
	private readonly tickIntervalMs: number;
	private readonly bufferSize: number;
	private readonly options: MaintenanceEnergyOptions;
	private alertClients = new Map<RecommendationPublishModule, { client: IPublishClient; destinationId: number }>();

	constructor(db: Database, options: MaintenanceEnergyOptions = {}) {
		this.storage = new MaintenanceEnergyStorageService(db);
		this.tickIntervalMs = options.tickIntervalMs ?? 60_000;
		this.bufferSize = options.bufferSize ?? 500;
		this.options = options;
	}

	start(): void {
		if (this.tickTimer) return;
		this.tickTimer = setInterval(() => this.tick(), this.tickIntervalMs);
		this.tickTimer.unref?.();
	}

	stop(): void {
		if (!this.tickTimer) return;
		clearInterval(this.tickTimer);
		this.tickTimer = null;
		for (const { client } of this.alertClients.values()) {
			client.disconnect?.().catch(() => {});
		}
		this.alertClients.clear();
	}

	private bufferKey(deviceUuid: string, endpointUuid: string | null, metric: string): string {
		return `${deviceUuid}::${endpointUuid ?? ''}::${metric}`;
	}

	/** Feed one metric sample. Same call site Community already has for anomalyService.processDataPoint(). */
	processDataPoint(deviceUuid: string, endpointUuid: string | null, metric: string, value: number, timestamp: number): void {
		const key = this.bufferKey(deviceUuid, endpointUuid, metric);
		let buffer = this.buffers.get(key);
		if (!buffer) {
			buffer = createBuffer(this.bufferSize);
			this.buffers.set(key, buffer);
		}
		addValue(buffer, value, timestamp);
	}

	/**
	 * Resolves a rule's `metric` to its buffer via the asset's metric bindings.
	 * If more than one device/endpoint reports the same metric name for this
	 * asset, the first one with actual buffered data wins — v1 doesn't merge
	 * multiple sources for a single rule.
	 */
	private getBufferForMetric(assetId: number, metric: string): StatisticalBuffer | undefined {
		const bindings = this.storage.getAssetMetricBindings(assetId, metric);
		for (const binding of bindings) {
			const buffer = this.buffers.get(this.bufferKey(binding.device_uuid, binding.endpoint_uuid, metric));
			if (buffer) return buffer;
		}
		return undefined;
	}

	/** Runs one evaluation pass over every enabled rule. Exposed (not just scheduled) so tests can drive it directly with an explicit `now`. */
	tick(now: number = Date.now()): void {
		this.tickMaintenanceRules(now);
		this.tickEnergyRules(now);
	}

	private tickMaintenanceRules(now: number): void {
		for (const rule of this.storage.getEnabledMaintenanceRules()) {
			const asset = this.storage.getAssetById(rule.asset_id);
			if (!asset) continue;

			const buffer = this.getBufferForMetric(rule.asset_id, rule.config.metric);
			if (!buffer) continue;

			const gatingMetric = (rule.config as { windowGating?: { metric: string } }).windowGating?.metric;
			const gatingBuffer = gatingMetric ? this.getBufferForMetric(rule.asset_id, gatingMetric) : undefined;

			const ctx: EvaluatorContext = {
				now,
				buffer,
				gatingBuffer,
				asset: {
					ratedLifeHours: asset.rated_life_hours,
					ratedCycles: asset.rated_cycles,
					lastServiceDate: asset.last_service_date,
				},
			};

			let outcome: EvaluationOutcome | undefined;
			let requiredHits = 1;

			switch (rule.rule_type) {
				case 'cumulative_runtime':
					outcome = evaluateCumulativeRuntime(rule.config as CumulativeRuntimeRuleConfig, ctx);
					break;
				case 'cycle_count':
					outcome = evaluateCycleCount(rule.config as CycleCountRuleConfig, ctx);
					break;
				case 'threshold_duration': {
					const config = rule.config as ThresholdDurationRuleConfig;
					outcome = evaluateThresholdDuration(config, ctx);
					requiredHits = config.consecutiveWindowsRequired ?? 1;
					break;
				}
				default:
					continue; // unknown rule_type — ignore rather than throw, config may be ahead of this build
			}

			const shouldFire = this.debounce.recordAndShouldFire(`maintenance:${rule.id}`, outcome.triggered, requiredHits);
			if (!shouldFire) continue;

			const { isNew } = this.storage.upsertMaintenanceRecommendation({
				asset_id: asset.id,
				asset_name: asset.name,
				criticality: asset.criticality,
				component: rule.component,
				rule_type: rule.rule_type,
				rule_config: rule.config,
				message: outcome.message,
				due_by: outcome.dueBy ?? null,
				confidence: outcome.confidence,
				evaluated_at: now,
			});

			if (isNew) {
				this.publish('maintenance', {
					module: 'maintenance',
					assetName: asset.name,
					criticality: asset.criticality,
					component: rule.component,
					ruleType: rule.rule_type,
					message: outcome.message,
					status: 'open',
					dueBy: outcome.dueBy ?? null,
					confidence: outcome.confidence,
					timestampMs: now,
				}).catch((error) => this.options.logger?.errorSync?.('Maintenance recommendation publish failed', error));
			}
		}
	}

	private tickEnergyRules(now: number): void {
		for (const rule of this.storage.getEnabledEnergyRules()) {
			const asset = this.storage.getAssetById(rule.asset_id);
			if (!asset) continue;

			const buffer = this.getBufferForMetric(rule.asset_id, rule.config.metric);
			if (!buffer) continue;

			const ctx: EvaluatorContext = {
				now,
				buffer,
				asset: {
					ratedLifeHours: asset.rated_life_hours,
					ratedCycles: asset.rated_cycles,
					lastServiceDate: asset.last_service_date,
				},
			};

			let outcome: EvaluationOutcome | undefined;

			switch (rule.rule_type) {
				case 'standby_waste':
					outcome = evaluateStandbyWaste(rule.config as StandbyWasteRuleConfig, ctx);
					break;
				case 'schedule_mismatch':
					outcome = evaluateScheduleMismatch(rule.config as ScheduleMismatchRuleConfig, ctx);
					break;
				case 'duty_cycle':
					outcome = evaluateDutyCycle(rule.config as DutyCycleRuleConfig, ctx);
					break;
				default:
					continue;
			}

			const shouldFire = this.debounce.recordAndShouldFire(`energy:${rule.id}`, outcome.triggered, 1);
			if (!shouldFire) continue;

			const { isNew } = this.storage.upsertEnergyRecommendation({
				asset_id: asset.id,
				asset_name: asset.name,
				criticality: asset.criticality,
				metric: rule.metric,
				rule_type: rule.rule_type,
				rule_config: rule.config,
				message: outcome.message,
				estimated_impact: outcome.estimatedImpact ?? null,
				confidence: outcome.confidence,
				evaluated_at: now,
			});

			if (isNew) {
				this.publish('energy', {
					module: 'energy',
					assetName: asset.name,
					criticality: asset.criticality,
					metric: rule.metric,
					ruleType: rule.rule_type,
					message: outcome.message,
					status: 'open',
					estimatedImpact: outcome.estimatedImpact ?? null,
					confidence: outcome.confidence,
					timestampMs: now,
				}).catch((error) => this.options.logger?.errorSync?.('Energy recommendation publish failed', error));
			}
		}
	}

	// ── Publishing ──────────────────────────────────────────────────────────

	/** (Re)creates the alert MQTT client for `module` only when its configured destination has changed — same reconnect-on-change strategy as AnomalyDetectionService.initAlertMqttClient(). */
	private async getAlertClient(module: RecommendationPublishModule, destinationId: number): Promise<IPublishClient | null> {
		const cached = this.alertClients.get(module);
		if (cached?.destinationId === destinationId) return cached.client;

		if (cached) {
			await cached.client.disconnect?.().catch(() => {});
			this.alertClients.delete(module);
		}

		const destination = this.options.getAlertDestination?.(destinationId);
		if (destination?.type !== 'mqtt') {
			this.options.logger?.warnSync?.(`Alert destination ${destinationId} for ${module} is missing or not an MQTT destination`);
			return null;
		}

		const client = this.options.createAlertMqttClient?.(destination.config_json, this.options.deviceUuid, `${module}-alerts`, this.options.logger);
		if (!client) return null;

		await client.connect?.();
		this.alertClients.set(module, { client, destinationId });
		return client;
	}

	private async publish(module: RecommendationPublishModule, payload: RecommendationPublishPayload): Promise<void> {
		const settings = this.storage.getPublishSettings(module);
		if (!settings.mqtt && !settings.cloud) return;

		if (settings.mqtt && settings.alertDestinationId != null) {
			const client = await this.getAlertClient(module, settings.alertDestinationId);
			if (client?.isConnected()) {
				const topic = settings.alertTopic || `iotistica/alerts/${module}`;
				await client.publish(topic, Buffer.from(JSON.stringify(payload)), { qos: 1, destinationTopic: topic });
			}
		}

		if (settings.cloud && this.options.mqttManager?.isConnected() && this.options.deviceUuid && this.options.buildTopic) {
			const topic = this.options.buildTopic(this.options.deviceUuid, 'events', module);
			await this.options.mqttManager.publish(topic, { format: 'json', data: payload }, { qos: 1, retain: false });
		}
	}
}
