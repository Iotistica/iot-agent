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
	lastQuality?: string;
	pointCount: number;
	totalBatches: number;
	lastPublishTime: string;
}

export interface ActivityEvent {
	id: number;
	timestamp: string;
	endpointName: string;
	protocol: string;
	metric: string;
	value: unknown;
	quality?: string;
	subscriptionId: number | null;
	destinationId: number;
	destinationName: string;
	pointCount: number;
}

// One event is now recorded per distinct metric per batch (not one per batch),
// so a single BACnet endpoint with dozens of points fills this far faster than
// when it was tuned for one row per publish tick.
const MAX_EVENTS = 2000;

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
	private recentEvents: ActivityEvent[] = [];
	private nextEventId = 1;

	record(params: {
		subscriptionId: number | null;
		destinationId: number;
		destinationName: string;
		destinationType: string;
		protocol: string;
		endpointName: string;
		metric: string;
		value: unknown;
		quality?: string;
		pointCount: number;
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
			lastQuality: params.quality,
			pointCount: params.pointCount,
			totalBatches: (existing?.totalBatches ?? 0) + 1,
			lastPublishTime: now,
		});

		this.recentEvents.push({
			id: this.nextEventId++,
			timestamp: now,
			endpointName: params.endpointName,
			protocol: params.protocol,
			metric: params.metric,
			value: params.value,
			quality: params.quality,
			subscriptionId: params.subscriptionId,
			destinationId: params.destinationId,
			destinationName: params.destinationName,
			pointCount: params.pointCount,
		});
		if (this.recentEvents.length > MAX_EVENTS) {
			this.recentEvents.splice(0, this.recentEvents.length - MAX_EVENTS);
		}
	}

	getSubscriptions(): SubscriptionActivity[] {
		return Array.from(this.bySubscription.values())
			.sort((a, b) => b.lastPublishTime.localeCompare(a.lastPublishTime))
			.map((s) => ({ ...s, endpointName: displayEndpointName(s.endpointName) }));
	}

	getRecentEvents(limit = 100): ActivityEvent[] {
		return this.recentEvents.slice(-limit).reverse()
			.map((e) => ({ ...e, endpointName: displayEndpointName(e.endpointName) }));
	}
}

export const activityMonitor = new ActivityMonitor();
