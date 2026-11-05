import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import type { LicenseService } from './service';

export interface BootstrapOptions {
	autoTrial: boolean;
	licenseKey?: string;
	retryIntervalMs?: number;
}

const DEFAULT_RETRY_MS = 60 * 60 * 1000;

/**
 * Runs once at startup (never throws, never blocks):
 *  - LICENSE_KEY set and not already paid -> activate paid (also converts a trial)
 *  - otherwise, no license stored and auto-trial enabled -> request a trial
 * Network failures are logged and retried on a slow timer.
 * Returns a stop function that cancels any pending retry.
 */
export function bootstrapLicense(
	service: LicenseService,
	options: BootstrapOptions,
	logger?: AgentLogger,
): () => void {
	let timer: NodeJS.Timeout | undefined;
	let stopped = false;
	const retryMs = options.retryIntervalMs ?? DEFAULT_RETRY_MS;

	const attempt = async (): Promise<void> => {
		if (stopped) return;
		try {
			const status = service.getStatus();
			if (options.licenseKey && status.state !== 'paid') {
				await service.activatePaid(options.licenseKey);
				return;
			}
			if (options.autoTrial && !service.hasStoredLicense()) {
				await service.activateTrial();
				return;
			}
		} catch (error) {
			logger?.warnSync('License bootstrap failed; will retry', {
				component: LogComponents.agentManager,
				operation: 'license-bootstrap',
				error: error instanceof Error ? error.message : String(error),
				retryMs,
			});
			if (!stopped) {
				timer = setTimeout(() => void attempt(), retryMs);
				timer.unref?.();
			}
		}
	};

	void attempt();
	return () => {
		stopped = true;
		if (timer) clearTimeout(timer);
	};
}
