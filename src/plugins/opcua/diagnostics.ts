/**
 * TEMPORARY DIAGNOSTICS — added to investigate why an OPC-UA server with 100
 * configured "devices" (one physical server, subscriptions enabled) only ever
 * shows 1 active subscription / 1 monitored item server-side, instead of the
 * expected ~one session+subscription set per device (or, after the planned
 * endpoint-based session-sharing refactor, one shared session).
 *
 * Every log line here is tagged `[OPCUA_DIAG]` for easy grep and easy removal
 * once the root cause is found. Do not build anything else on top of this —
 * it's meant to come back out, not become a permanent metrics subsystem.
 *
 * IMPORTANT: the Logger this class receives (see PluginManager's constructor
 * in ../index.ts) only forwards the message string to the real AgentLogger —
 * a second "context object" argument, the usual structured-logging idiom
 * elsewhere in this codebase, is silently dropped by that wrapper. So every
 * field below is baked directly into the message text (key=value pairs),
 * never passed as a second argument.
 */

import type { Logger } from '../types.js';

export interface OpcuaDeviceDiagnosticRecord {
	deviceId: string;
	endpointUrl: string;
	useSubscription: boolean;
	validatedNodeCount: number | null;
	sessionId: string | null;
	subscriptionCreated: boolean | null; // null = not attempted yet this run
	subscriptionIds: number[];
	monitorAttempts: number;
	monitorSuccesses: number;
	monitorFailures: number;
	monitorFailureStatusCodes: string[];
	pollingFallbackActive: boolean;
	subscriptionTerminations: number;
	subscriptionRecreations: number;
}

function blankRecord(deviceId: string, endpointUrl: string, useSubscription: boolean): OpcuaDeviceDiagnosticRecord {
	return {
		deviceId,
		endpointUrl,
		useSubscription,
		validatedNodeCount: null,
		sessionId: null,
		subscriptionCreated: null,
		subscriptionIds: [],
		monitorAttempts: 0,
		monitorSuccesses: 0,
		monitorFailures: 0,
		monitorFailureStatusCodes: [],
		pollingFallbackActive: false,
		subscriptionTerminations: 0,
		subscriptionRecreations: 0,
	};
}

/** Renders fields as `key=value key2=value2` so nothing depends on a logger forwarding a second argument. */
function fmt(fields: Record<string, unknown>): string {
	return Object.entries(fields)
		.map(([key, value]) => `${key}=${Array.isArray(value) ? `[${value.join(',')}]` : value}`)
		.join(' ');
}

/** Minimal shape diagnostics needs from an OPCUASession — avoids importing the concrete type and creating a cycle. */
export interface DiagnosableSession {
	session: unknown | null;
	subscriptions: { subscriptionId: number }[];
}

export class OpcuaStartupDiagnostics {
	private records = new Map<string, OpcuaDeviceDiagnosticRecord>();

	constructor(private logger: Logger) {}

	private getOrCreate(deviceId: string, endpointUrl: string, useSubscription: boolean): OpcuaDeviceDiagnosticRecord {
		let record = this.records.get(deviceId);
		if (!record) {
			record = blankRecord(deviceId, endpointUrl, useSubscription);
			this.records.set(deviceId, record);
		}
		return record;
	}

	recordConnectAttempt(deviceId: string, endpointUrl: string, useSubscription: boolean): void {
		this.getOrCreate(deviceId, endpointUrl, useSubscription);
		this.logger.info(`[OPCUA_DIAG] connect attempt ${fmt({ deviceId, endpointUrl, useSubscription })}`);
	}

	recordSessionEstablished(deviceId: string, sessionId: string | null): void {
		const record = this.records.get(deviceId);
		if (record) record.sessionId = sessionId;
		this.logger.info(`[OPCUA_DIAG] session established ${fmt({ deviceId, sessionId })}`);
	}

	recordValidatedNodes(deviceId: string, count: number): void {
		const record = this.records.get(deviceId);
		if (record) record.validatedNodeCount = count;
		this.logger.info(`[OPCUA_DIAG] validated nodes ${fmt({ deviceId, validatedNodeCount: count })}`);
	}

	recordSubscriptionResult(deviceId: string, success: boolean, subscriptionIds: number[] = [], error?: string): void {
		const record = this.records.get(deviceId);
		if (record) {
			// A prior attempt (of either result) already happened for this device —
			// this call is a reconnect re-running connectDevice(), i.e. a recreation,
			// not the first-ever creation. Covers both the standalone
			// recordSubscriptionRecreated() method and automatic detection here.
			if (success && record.subscriptionCreated !== null) {
				record.subscriptionRecreations++;
			}
			record.subscriptionCreated = success;
			record.subscriptionIds = subscriptionIds;
		}
		// Monitor-item tallies are already fully populated by this point (every
		// monitor() call for this device happens before the subscription-result
		// call at the end of createSubscription()) — fold them into this one
		// line instead of a separate line per node (see recordMonitorAttempt).
		this.logger.info(`[OPCUA_DIAG] subscription creation ${success ? 'succeeded' : 'failed'} ${fmt({
			deviceId,
			subscriptionIds,
			monitorAttempts: record?.monitorAttempts ?? 0,
			monitorSuccesses: record?.monitorSuccesses ?? 0,
			monitorFailures: record?.monitorFailures ?? 0,
			...(error && { error }),
		})}`);
	}

	/**
	 * Only logs individually on failure — a device with hundreds/thousands of
	 * nodes would otherwise print one line per node on every single startup or
	 * reconnect. Success counts are still tallied silently and surface in the
	 * subscription-result and aggregate-snapshot lines instead.
	 */
	recordMonitorAttempt(deviceId: string, nodeId: string, success: boolean, statusCode?: string): void {
		const record = this.records.get(deviceId);
		if (record) {
			record.monitorAttempts++;
			if (success) {
				record.monitorSuccesses++;
			} else {
				record.monitorFailures++;
				if (statusCode) record.monitorFailureStatusCodes.push(statusCode);
			}
		}
		if (!success) {
			this.logger.info(`[OPCUA_DIAG] monitor() failed ${fmt({ deviceId, nodeId, ...(statusCode && { statusCode }) })}`);
		}
	}

	recordPollingFallback(deviceId: string): void {
		const record = this.records.get(deviceId);
		if (record) record.pollingFallbackActive = true;
		this.logger.info(`[OPCUA_DIAG] polling fallback activated ${fmt({ deviceId })}`);
	}

	recordSubscriptionTerminated(deviceId: string): void {
		const record = this.records.get(deviceId);
		if (record) record.subscriptionTerminations++;
		this.logger.info(`[OPCUA_DIAG] subscription terminated ${fmt({ deviceId })}`);
	}

	recordSubscriptionRecreated(deviceId: string): void {
		const record = this.records.get(deviceId);
		if (record) record.subscriptionRecreations++;
		this.logger.info(`[OPCUA_DIAG] subscription recreated ${fmt({ deviceId })}`);
	}

	/**
	 * Logs the full per-device table plus aggregate totals. `liveSessions` is
	 * passed in fresh each call so "active sessions"/"active subscriptions"
	 * reflect current state, not a stale cumulative count.
	 */
	logAggregateSnapshot(liveSessions: Map<string, DiagnosableSession>): void {
		const allRecords = [...this.records.values()];
		const distinctEndpoints = new Set(allRecords.map((r) => r.endpointUrl));

		let activeSessions = 0;
		let activeSubscriptions = 0;
		for (const session of liveSessions.values()) {
			if (session.session) activeSessions++;
			activeSubscriptions += session.subscriptions.length;
		}

		const totals = {
			configuredDevices: allRecords.length,
			distinctEndpointUrls: distinctEndpoints.size,
			pollingDevices: allRecords.filter((r) => !r.useSubscription || r.pollingFallbackActive).length,
			subscriptionDevices: allRecords.filter((r) => r.useSubscription && r.subscriptionCreated === true).length,
			activeSessions,
			activeSubscriptions,
			requestedMonitoredItems: allRecords.reduce((sum, r) => sum + r.monitorAttempts, 0),
			successfulMonitoredItems: allRecords.reduce((sum, r) => sum + r.monitorSuccesses, 0),
			failedMonitoredItems: allRecords.reduce((sum, r) => sum + r.monitorFailures, 0),
		};

		this.logger.info(`[OPCUA_DIAG] ==== aggregate snapshot ==== ${fmt(totals)}`);
		for (const record of allRecords) {
			this.logger.info(`[OPCUA_DIAG] device record ${fmt({ ...record })}`);
		}
	}
}
