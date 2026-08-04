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
	}): void {
		const key = `${params.subscriptionId ?? 'default'}:${params.destinationId}`;
		const now = new Date().toISOString();

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
		};

		const protocolKey = params.protocol.toLowerCase();
		const bucket = this.eventsByProtocol.get(protocolKey) ?? [];
		bucket.push(event);
		if (bucket.length > MAX_EVENTS_PER_PROTOCOL) {
			bucket.splice(0, bucket.length - MAX_EVENTS_PER_PROTOCOL);
		}
		this.eventsByProtocol.set(protocolKey, bucket);

		this.totalPointsByProtocol.set(protocolKey, (this.totalPointsByProtocol.get(protocolKey) ?? 0) + 1);
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
}

export const activityMonitor = new ActivityMonitor();
