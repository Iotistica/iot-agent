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

const MAX_EVENTS = 300;

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
		return Array.from(this.bySubscription.values()).sort((a, b) => b.lastPublishTime.localeCompare(a.lastPublishTime));
	}

	getRecentEvents(limit = 100): ActivityEvent[] {
		return this.recentEvents.slice(-limit).reverse();
	}
}

export const activityMonitor = new ActivityMonitor();
