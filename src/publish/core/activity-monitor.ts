/**
 * In-memory observer for the Sources → Subscriptions → Destinations pipeline.
 *
 * Same shape as BrokerMonitorService (src/mqtt/broker-monitor.ts): a
 * singleton fed by the publish path, polled via REST — no WebSocket, no
 * persistence. Deliberately aggregate-first (last value per subscription)
 * rather than a raw per-message firehose, since endpoints can poll as fast
 * as every second with many points each.
 */

export interface SubscriptionActivity {
	key: string;
	subscriptionId: number | null;
	destinationId: number;
	destinationName: string;
	destinationType: string;
	protocol: string;
	endpointName: string;
	lastMetric: string;
	lastValue: unknown;
	lastUnit?: string;
	lastQuality?: string;
	pointCount: number;
	totalBatches: number;
	lastPublishTime: string;
	/** From Point Name Normalization (src/point-name/) — see PublishManager.readPointIdentity(). Additive/optional: absent for readings the interceptor skipped or predating this feature. */
	normalizedName?: string;
	provisionalPointId?: string;
	rulesVersion?: string;
	/** True protocol-reported name, when the adapter captured one separately from the sanitized metric identifier (currently BACnet only — see plugins/types.ts's DeviceDataPoint.rawObjectName). Display-only. */
	rawObjectName?: string;
	rawPointName?: string;
}

export interface CompressionSnapshot {
	topic: string;
	method: string;
	originalSize: number;
	compressedSize: number;
	savedBytes: number;
	savedPercent: number; // 0-100, one decimal place — frontend formats for display
	compressionMs: number;
	recordedAt: string;
}

export interface ActivityEvent {
	id: number;
	timestamp: string;
	endpointName: string;
	protocol: string;
	metric: string;
	value: unknown;
	unit?: string;
	quality?: string;
	subscriptionId: number | null;
	destinationId: number;
	destinationName: string;
	pointCount: number;
	/** From Point Name Normalization (src/point-name/) — see PublishManager.readPointIdentity(). Additive/optional: absent for readings the interceptor skipped or predating this feature. */
	normalizedName?: string;
	provisionalPointId?: string;
	rulesVersion?: string;
	/** True protocol-reported name, when the adapter captured one separately from the sanitized metric identifier (currently BACnet only — see plugins/types.ts's DeviceDataPoint.rawObjectName). Display-only. */
	rawObjectName?: string;
	rawPointName?: string;
}

// One event is now recorded per distinct metric per batch (not one per batch),
// so a single BACnet endpoint with dozens of points fills this far faster than
// when it was tuned for one row per publish tick. Capped per protocol (see
// eventsByProtocol below), not globally — a single shared buffer let a
// high-volume protocol evict a quieter one's entire history within seconds.
const MAX_EVENTS_PER_PROTOCOL = 500;

// Endpoint names are generated internally as "{protocol}-pipe" (see
// init/features.ts) — "pipe" reflects internal plumbing (the endpoint's
// buffered read pipeline), not something an operator recognizes. Same
// stripping PublishManager.normalizeExternalGroupName() already does for
// outbound MQTT group naming; applied here too since this is the other place
// the raw internal name reaches something operator-facing (the Data Flow UI).
function displayEndpointName(endpointName: string): string {
	return endpointName.replace(/(?:^|[-_\s])pipe$/i, '').replace(/[-_\s]+$/g, '') || endpointName;
}

class ActivityMonitor {
	private bySubscription = new Map<string, SubscriptionActivity>();
	// Keyed by lowercased protocol — each protocol gets its own ring buffer so a
	// high-volume one (e.g. many BACnet points polling every few seconds) can
	// never evict a quieter protocol's history. `id` stays a single monotonic
	// counter across all buckets so the no-filter view can still merge them back
	// into one correctly-ordered feed.
	private eventsByProtocol = new Map<string, ActivityEvent[]>();
	private nextEventId = 1;
	// Monotonic, never-evicted point counter per protocol (unlike eventsByProtocol,
	// which is capped and rolls off old entries) — lets a poller compute a
	// points/sec rate by diffing two snapshots, the same way the dashboard derives
	// CPU/network history from repeated stat snapshots rather than server-tracked
	// time series.
	private totalPointsByProtocol = new Map<string, number>();

	/**
	 * Per-point last-seen tracking for the Dashboard's "Data Overview" tiles
	 * (Active Points / Active Devices). Keyed by protocol+device+metric so the
	 * same metric name reported by two different devices — or the same device
	 * name reused across two different protocols — is never conflated into one
	 * point. Updated once per record() call; repeat calls for the same point
	 * from multiple destination bindings just refresh the same entry (no
	 * fan-out over-count, unlike totalPointsByProtocol above — presence doesn't
	 * care how many times it was refreshed). Self-bounding in practice: grows to
	 * the number of distinct points ever seen, not unboundedly over time —
	 * getOverviewStats() below opportunistically evicts anything stale for over
	 * an hour.
	 */
	private lastSeenByPoint = new Map<string, { protocol: string; deviceName: string; lastSeen: number }>();

	/**
	 * Latest compression result per destination topic, for the MQTT Explorer's
	 * per-topic compression stats display. Keyed directly by the outbound MQTT
	 * topic string (not subscriptionId/destinationId) since that's the only
	 * identity the Explorer — which only sniffs raw wire traffic — actually
	 * has. One entry per topic, overwritten on every publish; never evicted
	 * (same self-bounding reasoning as lastSeenByPoint — bounded by the number
	 * of distinct destination topics actually configured, not by time).
	 */
	private compressionByTopic = new Map<string, CompressionSnapshot>();

	// Fixed-size ring for the rolling "Good Quality %" tile — 20 buckets of 15s
	// = 5 minutes of trailing history, bounded memory instead of retaining every
	// individual reading. Fed from PublishManager.publishBatch() (see
	// recordQualitySample() below), NOT from record() above — record() fires
	// once per (destination × deduped metric), which would both over-count
	// (multiplied by however many destinations an endpoint has) and under-count
	// (collapsed to one per metric per batch) relative to true individual
	// readings, biasing a cross-protocol percentage toward whichever
	// protocols/endpoints happen to have more destinations or denser batches.
	private static readonly QUALITY_BUCKET_MS = 15_000;
	private static readonly QUALITY_BUCKET_COUNT = 20; // 20 * 15s = 5 minutes
	private qualityBuckets: Array<{ bucketStart: number; good: number; total: number }> =
		Array.from({ length: ActivityMonitor.QUALITY_BUCKET_COUNT }, () => ({ bucketStart: 0, good: 0, total: 0 }));

	record(params: {
		subscriptionId: number | null;
		destinationId: number;
		destinationName: string;
		destinationType: string;
		protocol: string;
		endpointName: string;
		metric: string;
		value: unknown;
		unit?: string;
		quality?: string;
		pointCount: number;
		normalizedName?: string;
		provisionalPointId?: string;
		rulesVersion?: string;
		rawObjectName?: string;
		rawPointName?: string;
	}): void {
		const key = `${params.subscriptionId ?? 'default'}:${params.destinationId}`;
		const nowDate = new Date();
		const now = nowDate.toISOString();

		const existing = this.bySubscription.get(key);
		this.bySubscription.set(key, {
			key,
			subscriptionId: params.subscriptionId,
			destinationId: params.destinationId,
			destinationName: params.destinationName,
			destinationType: params.destinationType,
			protocol: params.protocol,
			endpointName: params.endpointName,
			lastMetric: params.metric,
			lastValue: params.value,
			lastUnit: params.unit,
			lastQuality: params.quality,
			pointCount: params.pointCount,
			totalBatches: (existing?.totalBatches ?? 0) + 1,
			lastPublishTime: now,
			normalizedName: params.normalizedName,
			provisionalPointId: params.provisionalPointId,
			rulesVersion: params.rulesVersion,
			rawObjectName: params.rawObjectName,
			rawPointName: params.rawPointName,
		});

		const event: ActivityEvent = {
			id: this.nextEventId++,
			timestamp: now,
			endpointName: params.endpointName,
			protocol: params.protocol,
			metric: params.metric,
			value: params.value,
			unit: params.unit,
			quality: params.quality,
			subscriptionId: params.subscriptionId,
			destinationId: params.destinationId,
			destinationName: params.destinationName,
			pointCount: params.pointCount,
			normalizedName: params.normalizedName,
			provisionalPointId: params.provisionalPointId,
			rulesVersion: params.rulesVersion,
			rawObjectName: params.rawObjectName,
			rawPointName: params.rawPointName,
		};

		const protocolKey = params.protocol.toLowerCase();
		const bucket = this.eventsByProtocol.get(protocolKey) ?? [];
		bucket.push(event);
		if (bucket.length > MAX_EVENTS_PER_PROTOCOL) {
			bucket.splice(0, bucket.length - MAX_EVENTS_PER_PROTOCOL);
		}
		this.eventsByProtocol.set(protocolKey, bucket);

		this.totalPointsByProtocol.set(protocolKey, (this.totalPointsByProtocol.get(protocolKey) ?? 0) + 1);

		this.lastSeenByPoint.set(`${protocolKey}:${params.endpointName}:${params.metric}`, {
			protocol: protocolKey,
			deviceName: params.endpointName,
			lastSeen: nowDate.getTime(),
		});
	}

	getSubscriptions(): SubscriptionActivity[] {
		return Array.from(this.bySubscription.values())
			.sort((a, b) => b.lastPublishTime.localeCompare(a.lastPublishTime))
			.map((s) => ({ ...s, endpointName: displayEndpointName(s.endpointName) }));
	}

	getRecentEvents(limit = 100, protocol?: string): ActivityEvent[] {
		let merged: ActivityEvent[];
		if (protocol) {
			merged = this.eventsByProtocol.get(protocol.toLowerCase()) ?? [];
		} else {
			merged = Array.from(this.eventsByProtocol.values()).flat();
			merged.sort((a, b) => a.id - b.id);
		}
		return merged.slice(-limit).reverse()
			.map((e) => ({ ...e, endpointName: displayEndpointName(e.endpointName) }));
	}

	/** Cumulative points recorded per protocol since agent start — never resets or evicts. */
	getThroughputCounters(): Record<string, number> {
		return Object.fromEntries(this.totalPointsByProtocol);
	}

	/**
	 * Records one destination binding's compression result for this publish
	 * tick. Call once per binding (not per metric/reading) — same formulas
	 * PublishStats.logPublishSuccess() already logs (savedBytes = originalSize
	 * - compressedSize, savedPercent = ratio), reused here instead of
	 * reimplemented so the two stay in lockstep.
	 *
	 * Skips the periodic no-op calibration pass (CompressionInfo.isBaseline,
	 * ~1 in 1000 publishes — see compress.ts's shouldMeasureBaseline()):
	 * recording it would overwrite a topic's real compression snapshot with a
	 * misleading "0% saved" blip once every ~1000 ticks.
	 */
	recordCompression(topic: string, info: { method: string; originalSize: number; compressedSize: number; ratio: number; compressionMs: number; isBaseline?: boolean }): void {
		if (info.isBaseline) return;
		this.compressionByTopic.set(topic, {
			topic,
			method: info.method,
			originalSize: info.originalSize,
			compressedSize: info.compressedSize,
			savedBytes: info.originalSize - info.compressedSize,
			savedPercent: Math.round(info.ratio * 10) / 10,
			compressionMs: info.compressionMs,
			recordedAt: new Date().toISOString(),
		});
	}

	getCompression(topic: string): CompressionSnapshot | undefined {
		return this.compressionByTopic.get(topic);
	}

	/**
	 * Records one individual reading's quality for the rolling "Good Quality %"
	 * window. Call once per physical reading — see PublishManager.publishBatch(),
	 * which taps in via the existing collectTagRecords() helper before any
	 * per-destination fan-out or per-metric dedup.
	 */
	recordQualitySample(quality: string | undefined): void {
		const now = Date.now();
		const bucketStart = Math.floor(now / ActivityMonitor.QUALITY_BUCKET_MS) * ActivityMonitor.QUALITY_BUCKET_MS;
		const idx = Math.floor(now / ActivityMonitor.QUALITY_BUCKET_MS) % ActivityMonitor.QUALITY_BUCKET_COUNT;
		const bucket = this.qualityBuckets[idx];
		if (bucket.bucketStart !== bucketStart) {
			// First use of this slot, or it's wrapped around from >1 lap ago — reset.
			bucket.bucketStart = bucketStart;
			bucket.good = 0;
			bucket.total = 0;
		}
		bucket.total++;
		if (quality === 'GOOD') bucket.good++;
	}

	private getRollingQualityPct(windowMs: number): number | null {
		const now = Date.now();
		let good = 0;
		let total = 0;
		for (const bucket of this.qualityBuckets) {
			if (bucket.bucketStart === 0 || now - bucket.bucketStart > windowMs) continue;
			good += bucket.good;
			total += bucket.total;
		}
		return total > 0 ? (good / total) * 100 : null;
	}

	/**
	 * Snapshot for the Dashboard's compact "Data Overview" row. Pure read aside from
	 * opportunistic eviction of points that haven't reported in over an hour, so a
	 * decommissioned device/point doesn't linger in lastSeenByPoint forever. Cheap to
	 * scan at the cardinalities this agent sees (low thousands of distinct points).
	 */
	getOverviewStats(windowMs = 5 * 60 * 1000): { activePoints: number; activeDevices: number; goodQualityPct: number | null } {
		const now = Date.now();
		const STALE_MS = 60 * 60 * 1000; // 1 hour — bounds memory for decommissioned points
		let activePoints = 0;
		const activeDeviceKeys = new Set<string>();

		for (const [key, point] of this.lastSeenByPoint) {
			const age = now - point.lastSeen;
			if (age > STALE_MS) {
				this.lastSeenByPoint.delete(key);
				continue;
			}
			if (age <= windowMs) {
				activePoints++;
				activeDeviceKeys.add(`${point.protocol}:${point.deviceName}`);
			}
		}

		return {
			activePoints,
			activeDevices: activeDeviceKeys.size,
			goodQualityPct: this.getRollingQualityPct(windowMs),
		};
	}
}

export const activityMonitor = new ActivityMonitor();
