import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import type { DiscoveryService, DiscoveredDevice } from './service';
import { DiscoveryRuleModel, type DiscoveryRule } from '../db/models/discovery-rule.model';
import { DiscoveryRunModel } from '../db/models/discovery-run.model';
import { DiscoveryBlocklistModel } from '../db/models/discovery-blocklist.model';

const POLL_INTERVAL_MS = 30_000;
// start() only resets a rule stuck at status='running' when the agent process
// itself restarts — if a run crashes/hangs without taking the whole process
// down with it (or the container just stays up for hours after), that status
// never clears on its own. Treat 'running' older than this as abandoned rather
// than genuinely in-progress, so the overlap guard below can't permanently wedge
// a rule shut. Generous relative to observed scan durations (even 500 devices
// under heavy load has taken low minutes, not hours).
const STALE_RUNNING_THRESHOLD_MS = 15 * 60 * 1000;

export class DiscoveryRulesScheduler {
	private logger?: AgentLogger;
	private discoveryService: DiscoveryService;
	private timer?: NodeJS.Timeout;
	private runningAbort = new Map<string, AbortController>();

	constructor(discoveryService: DiscoveryService, logger?: AgentLogger) {
		this.discoveryService = discoveryService;
		this.logger = logger;
	}

	start(): void {
		// Reset any rules left in 'running' state from a previous interrupted session
		const stale = DiscoveryRuleModel.getAll().filter((r) => r.status === 'running');
		for (const rule of stale) {
			DiscoveryRuleModel.update(rule.uuid, {
				status: 'error',
				last_result_json: { found: 0, saved: 0, skipped: 0, error: 'interrupted by restart' },
			});
		}

		// Reschedule any rules that became "due" during downtime so they don't
		// all fire on the first tick. They'll run at their normal interval from now.
		const due = DiscoveryRuleModel.getDue();
		for (const rule of due) {
			const next = new Date(Date.now() + rule.interval_seconds * 1000).toISOString();
			DiscoveryRuleModel.update(rule.uuid, { next_run_at: next });
			this.logger?.infoSync('Rescheduled discovery rule (was due during downtime)', {
				component: LogComponents.agent,
				ruleUuid: rule.uuid,
				ruleName: rule.name,
				nextRunAt: next,
			});
		}

		this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
		this.logger?.infoSync('Discovery rules scheduler started', {
			component: LogComponents.agent,
			pollIntervalMs: POLL_INTERVAL_MS,
		});
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	pauseRule(uuid: string): void {
		const controller = this.runningAbort.get(uuid);
		if (!controller) {
			throw Object.assign(
				new Error('Discovery rule is not currently running'),
				{ statusCode: 409 },
			);
		}
		controller.abort();
		this.logger?.infoSync('Discovery rule paused by user', {
			component: LogComponents.agent,
			ruleUuid: uuid,
		});
	}

	async runNow(
		uuid: string,
		pruneOptions?: { prune?: boolean; pruneDryRun?: boolean; forceFullBrowse?: boolean }
	): Promise<{
		rule: DiscoveryRule;
		devices: DiscoveredDevice[];
		prunedCount: number;
		prunedDevices?: Array<{ name: string; protocol: string }>;
		pruneDryRun?: boolean;
	}> {
		const rule = DiscoveryRuleModel.getByUuid(uuid);
		if (!rule) {
			throw Object.assign(new Error(`Discovery rule not found: ${uuid}`), { statusCode: 404 });
		}
		// At larger device counts a scan+reconcile can run well past a client's request
		// timeout — without this guard, a client retrying after its own timeout fires
		// a second overlapping run on the same rule while the first is still finishing.
		if (rule.status === 'running') {
			const runningSinceMs = rule.last_run_at ? Date.now() - new Date(rule.last_run_at).getTime() : Infinity;
			if (runningSinceMs <= STALE_RUNNING_THRESHOLD_MS) {
				throw Object.assign(
					new Error(`Discovery rule "${rule.name}" is already running — wait for it to finish before running again`),
					{ statusCode: 409 }
				);
			}
			this.logger?.warnSync('Discovery rule stuck at status=running past the stale threshold — treating as abandoned and allowing this run', {
				component: LogComponents.agent,
				ruleUuid: rule.uuid,
				ruleName: rule.name,
				lastRunAt: rule.last_run_at,
				runningForMs: runningSinceMs,
			});
		}

		// Prune is opt-in per manual run only — never applied on a scheduled tick,
		// where nobody is present to confirm what's about to be disabled.
		let pruneResult: { prunedCount: number; prunedDevices?: Array<{ name: string; protocol: string }>; pruneDryRun?: boolean } = {
			prunedCount: 0,
		};
		const onComplete = (payload: any) => {
			pruneResult = {
				prunedCount: payload.prunedCount ?? 0,
				prunedDevices: payload.prunedDevices,
				pruneDryRun: payload.pruneDryRun,
			};
		};
		if (pruneOptions?.prune) {
			this.discoveryService.once('discovery-complete', onComplete);
		}

		let devices: DiscoveredDevice[];
		try {
			devices = await this.executeRule(rule, 'manual', pruneOptions, pruneOptions?.forceFullBrowse);
		} finally {
			this.discoveryService.off('discovery-complete', onComplete);
		}

		try {
			const blocked = DiscoveryBlocklistModel.getFingerprints();
			for (const d of devices) {
				(d as any).blocked = blocked.has(d.fingerprint);
			}
		} catch { /* non-fatal: blocklist table may not exist yet */ }

		return { rule: DiscoveryRuleModel.getByUuid(uuid)!, devices, ...pruneResult };
	}

	private async tick(): Promise<void> {
		const due = DiscoveryRuleModel.getDue();
		for (const rule of due) {
			await this.executeRule(rule, 'scheduled');
		}
	}

	private async executeRule(
		rule: DiscoveryRule,
		trigger: 'scheduled' | 'manual',
		pruneOptions?: { prune?: boolean; pruneDryRun?: boolean },
		forceFullBrowse?: boolean,
	): Promise<DiscoveredDevice[]> {
		const startedAt = new Date().toISOString();
		DiscoveryRuleModel.update(rule.uuid, { status: 'running', last_run_at: startedAt });

		const controller = new AbortController();
		this.runningAbort.set(rule.uuid, controller);

		let runId: number | null = null;
		try {
			runId = DiscoveryRunModel.create({
				rule_uuid: rule.uuid,
				rule_name: rule.name,
				protocol:  rule.protocol,
				trigger,
				started_at: startedAt,
			});
		} catch {
			// non-fatal: run tracking unavailable (e.g. migration pending)
		}

		this.logger?.infoSync('Discovery rule started', {
			component: LogComponents.agent,
			ruleUuid: rule.uuid,
			ruleName: rule.name,
			protocol: rule.protocol,
			trigger,
		});

		const onProgress = (progress: { found: number; phase: string; target?: string }) => {
			try {
				DiscoveryRuleModel.update(rule.uuid, {
					last_result_json: { found: progress.found, saved: 0, skipped: 0, in_progress: true },
				});
			} catch { /* non-fatal */ }
		};

		let devices: DiscoveredDevice[] = [];
		try {
			devices = await this.discoveryService.runDiscovery({
				trigger: trigger === 'manual' ? 'manual' : 'scheduled',
				protocols: [rule.protocol as any],
				forceRun: true,
				validate: true,
				failOnError: true,
				autoEnableNew: rule.auto_enable,
				...(rule.params_json || forceFullBrowse
					? { optionOverrides: { [rule.protocol]: { ...(rule.params_json || {}), ...(forceFullBrowse ? { forceFullBrowse: true } : {}) } } }
					: {}),
				...(pruneOptions?.prune ? { prune: true, pruneDryRun: pruneOptions.pruneDryRun ?? false } : {}),
				onProgress,
				signal: controller.signal,
			});

			if (controller.signal.aborted) {
				const found = devices[0]?.dataPoints?.length ?? 0;
				const finishedAt = new Date().toISOString();
				const durationMs = Date.now() - new Date(startedAt).getTime();

				DiscoveryRuleModel.update(rule.uuid, {
					status: 'paused',
					last_result_json: { found, saved: 0, skipped: 0, paused: true },
				});
				if (runId !== null) {
					try { DiscoveryRunModel.finish(runId, { finished_at: finishedAt, duration_ms: durationMs, status: 'ok', found, saved: 0, skipped: 0 }); } catch { /* non-fatal */ }
				}

				this.logger?.infoSync('Discovery rule paused', {
					component: LogComponents.agent,
					ruleUuid: rule.uuid,
					ruleName: rule.name,
					found,
				});
				return devices;
			}

			const found = devices.length;
			const saved = found;
			const finishedAt = new Date().toISOString();
			const durationMs = Date.now() - new Date(startedAt).getTime();
			const next = new Date(Date.now() + rule.interval_seconds * 1000).toISOString();

			const deviceMeta = devices[0]?.metadata;
			const mode = deviceMeta?.discoveryMode as string | undefined;
			const cached_nodes = deviceMeta?.cachedNodeCount as number | undefined;
			const new_nodes = deviceMeta?.newNodeCount as number | undefined;

			DiscoveryRuleModel.update(rule.uuid, {
				status: 'ok',
				last_result_json: {
					found, saved, skipped: 0,
					...(mode && { mode }),
					...(cached_nodes && { cached_nodes }),
					...(new_nodes && { new_nodes }),
				},
				next_run_at: next,
			});
			if (runId !== null) {
				try { DiscoveryRunModel.finish(runId, { finished_at: finishedAt, duration_ms: durationMs, status: 'ok', found, saved, skipped: 0 }); } catch { /* non-fatal */ }
			}

			this.logger?.infoSync('Discovery rule completed', {
				component: LogComponents.agent,
				ruleUuid: rule.uuid,
				ruleName: rule.name,
				found,
				autoEnable: rule.auto_enable,
				nextRunAt: next,
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			const finishedAt = new Date().toISOString();
			const durationMs = Date.now() - new Date(startedAt).getTime();
			const next = new Date(Date.now() + rule.interval_seconds * 1000).toISOString();

			DiscoveryRuleModel.update(rule.uuid, {
				status: 'error',
				last_result_json: { found: 0, saved: 0, skipped: 0, error: msg },
				next_run_at: next,
			});
			if (runId !== null) {
				try { DiscoveryRunModel.finish(runId, { finished_at: finishedAt, duration_ms: durationMs, status: 'error', found: 0, saved: 0, skipped: 0, error: msg }); } catch { /* non-fatal */ }
			}

			this.logger?.errorSync('Discovery rule failed', error instanceof Error ? error : new Error(msg), {
				component: LogComponents.agent,
				ruleUuid: rule.uuid,
				ruleName: rule.name,
			});
		} finally {
			this.runningAbort.delete(rule.uuid);
		}

		return devices;
	}
}
