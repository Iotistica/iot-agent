import type { Protocol } from "../../plugins/protocol.js";
import type { Logger } from "../core/types.js";
import type { CanonicalDeviceState } from "./device-state.js";
import {
	extractRawDeviceState,
	normalizeDeviceState,
} from "./device-state.js";
import { DeviceStateHistoryModel } from "../../db/models/index.js";

type Reading = {
	[key: string]: any;
	deviceName?: string;
	metric?: string;
	registerName?: string;
	name?: string;
	value?: unknown;
	device_uuid?: string;
	deviceUuid?: string;
	deviceState?: unknown;
	state?: unknown;
	status?: unknown;
	readings?: Reading[];
	device_state?: unknown;
	raw_device_state?: unknown;
	state_duration_seconds?: number;
	anomaly_score?: number;
	anomaly_threshold?: number;
	baseline_samples?: number;
	detection_methods?: string[];
	predicted_next?: number;
	trend?: string;
	trend_strength?: number;
	forecast_confidence?: number;
	time_to_threshold?: {
		threshold: number;
		estimated_seconds: number;
		confidence: number;
	};
};

/**
 * Enriches pre-parsed messages with anomaly scores, thresholds, and forecasts
 * from the edge anomaly service.  Supports both OPC-UA (direct object) and
 * Modbus ({readings: [...]}) formats.
 */
export class AnomalyEnricher {
	// Per device (not per-tag): how long the device has held its current canonical state.
	private readonly stateHistory = new Map<string, { state: CanonicalDeviceState; since: number }>();

	constructor(
		private readonly getService: () => any | undefined,
		private readonly deviceUuid: string,
		private readonly protocol: Protocol | undefined,
		private readonly logger?: Logger,
	) {}

	enrich(messages: unknown[], deviceName: string): unknown[] {
		const service = this.getService();
		if (!service) return messages;

		const predictions = service.getPredictions();

		for (const data of messages) {
			const d = data as Reading;

			// Modbus format: { readings: [...] }
			if (d.readings && Array.isArray(d.readings)) {
				for (const reading of d.readings) {
					if (typeof reading !== "object" || reading === null) continue;
					const readingDeviceName: string = reading.deviceName || deviceName;
					const fieldName: string | undefined =
						reading.metric || reading.registerName || reading.name;
					if (!fieldName) continue;

					this.applyDeviceState(reading, reading, readingDeviceName);
					this.attachScores(
						service,
						predictions,
						reading,
						readingDeviceName,
						fieldName,
					);
				}
			}
			// OPC-UA format: direct reading object
			else if (
				d.deviceName &&
				(d.metric || d.registerName || d.name) &&
				d.value !== undefined
			) {
				const readingDeviceName: string = d.deviceName;
				const fieldName: string | undefined =
					d.metric || d.registerName || d.name;
				if (!fieldName) continue;

				this.applyDeviceState(d, d, readingDeviceName);
				this.attachScores(
					service,
					predictions,
					d,
					readingDeviceName,
					fieldName,
				);
			}
		}

		return messages;
	}

	private applyDeviceState(target: Reading, source: Reading, deviceIdentifierName: string): void {
		const raw = extractRawDeviceState(source);

		if (raw === undefined) return;

		const state = normalizeDeviceState(this.protocol, raw);
		if (target.device_state === undefined) {
			target.device_state = state;
		}
		if (target.raw_device_state === undefined) {
			target.raw_device_state = raw;
		}

		const deviceKey = this.buildDeviceKey(
			source.device_uuid || source.deviceUuid,
			deviceIdentifierName,
		);
		this.attachStateDuration(target, deviceKey, state);
	}

	private buildDeviceKey(deviceIdentifier: string | undefined, deviceName: string): string {
		const identifier =
			typeof deviceIdentifier === "string" && deviceIdentifier.trim()
				? deviceIdentifier.trim()
				: deviceName || "unknown";

		return `${this.deviceUuid}_${identifier}`;
	}

	/**
	 * Tracks how long a device has held its current canonical state so
	 * downstream (e.g. predictive-maintenance) models get runtime-since-transition
	 * as a feature instead of having to reconstruct it from raw history.
	 *
	 * Backed by SQLite so the duration survives an agent restart: the in-memory
	 * map is a read-through cache (DB read at most once per device per process
	 * lifetime), and only a state *transition* writes back to disk — not every
	 * reading — so this stays off the hot path.
	 */
	private attachStateDuration(target: Reading, deviceKey: string, state: CanonicalDeviceState): void {
		const now = Date.now();
		let previous = this.stateHistory.get(deviceKey);

		if (!previous) {
			previous = this.loadPersistedState(deviceKey) ?? undefined;
			if (previous) {
				this.stateHistory.set(deviceKey, previous);
			}
		}

		if (previous?.state !== state) {
			const record = { state, since: now };
			this.stateHistory.set(deviceKey, record);
			this.persistState(deviceKey, record);
			target.state_duration_seconds = 0;
			return;
		}

		target.state_duration_seconds = Math.floor((now - previous.since) / 1000);
	}

	private loadPersistedState(deviceKey: string): { state: CanonicalDeviceState; since: number } | null {
		try {
			const row = DeviceStateHistoryModel.get(deviceKey);
			if (!row) return null;
			return { state: row.state as CanonicalDeviceState, since: row.since_ms };
		} catch (err: any) {
			this.logger?.warn('Failed to load persisted device state history', {
				deviceKey,
				error: err?.message ?? String(err),
			});
			return null;
		}
	}

	private persistState(deviceKey: string, record: { state: CanonicalDeviceState; since: number }): void {
		try {
			DeviceStateHistoryModel.upsert({ device_key: deviceKey, state: record.state, since_ms: record.since });
		} catch (err: any) {
			this.logger?.warn('Failed to persist device state history', {
				deviceKey,
				error: err?.message ?? String(err),
			});
		}
	}

	private buildMetricKey(
		deviceIdentifier: string | undefined,
		deviceName: string,
		fieldName: string,
	): string {
		const identifier =
			typeof deviceIdentifier === "string" && deviceIdentifier.trim()
				? deviceIdentifier.trim()
				: deviceName || "unknown";

		return `${this.deviceUuid}_${identifier}_${fieldName}`;
	}

	private attachScores(
		service: any,
		predictions: Record<string, any> | undefined,
		target: Reading,
		deviceIdentifierName: string,
		fieldName: string,
	): void {
		const metricName = this.buildMetricKey(
			target.device_uuid || target.deviceUuid || deviceIdentifierName,
			deviceIdentifierName,
			fieldName,
		);
		const score = service.getAnomalyScore(metricName);
		if (score === undefined) return;

		target.anomaly_score = score;

		const metadata = service.getAnomalyMetadata(metricName);
		if (metadata) {
			target.anomaly_threshold = metadata.threshold;
			target.baseline_samples = metadata.samples;
			target.detection_methods = metadata.methods;
		}

		const p = predictions?.[metricName];
		if (p) {
			// Keep outgoing payload fields in snake_case for wire compatibility.
			target.predicted_next = p.predictedNext;
			target.trend = p.trend;
			target.trend_strength = p.trendStrength;
			target.forecast_confidence = p.confidence;
			if (p.timeToThreshold) {
				target.time_to_threshold = {
					threshold: p.timeToThreshold.threshold,
					estimated_seconds: p.timeToThreshold.estimatedSeconds,
					confidence: p.timeToThreshold.confidence,
				};
			}
		}
	}
}
