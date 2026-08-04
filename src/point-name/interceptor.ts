import { getPointNameCatalog, type PointNameCatalog } from './catalog.js';
import type { Logger, PointIdentity } from './types.js';

interface ProtocolMessage extends Record<string, unknown> {
	readings?: ProtocolMessage[];
}

const FLUSH_INTERVAL_MS = 5000;

/**
 * Creates the point-name-normalization stage for PublishManager's
 * liveDataInterceptor hook — registered FIRST via composeInterceptors() (plan
 * §10), ahead of unit-normalization/data-quality. Mirrors the exact dual-shape
 * handling those stages already use. Three fault-isolation layers: per-reading
 * try/catch (below — one malformed reading is skipped, no pointIdentity
 * attached, reading otherwise untouched and still published), per-message
 * try/catch (below), and the existing manager-level try/catch around the
 * whole interceptor chain as the final backstop.
 *
 * Persistence of newly-computed mappings is deferred and batched (catalog.ts)
 * via a periodic flush — never a synchronous DB call from this function's own
 * call stack.
 */
export function createPointNameNormalizationInterceptor(opts: { logger?: Logger } = {}) {
	const catalog = getPointNameCatalog();
	catalog.init(opts.logger);

	const flushTimer = setInterval(() => catalog.flush(), FLUSH_INTERVAL_MS);
	flushTimer.unref?.();

	const shutdownFlush = (): void => catalog.shutdownFlush();
	process.once('SIGTERM', shutdownFlush);
	process.once('SIGINT', shutdownFlush);

	return function pointNameNormalizationInterceptor(
		messages: ProtocolMessage[],
		endpointName: string,
	): ProtocolMessage[] {
		for (const message of messages) {
			try {
				if (Array.isArray(message.readings)) {
					for (const reading of message.readings) {
						try {
							attachIdentity(reading, endpointName, catalog);
						} catch (err) {
							opts.logger?.warn('Point-name normalization failed for a reading, skipping', err);
						}
					}
					continue;
				}
				attachIdentity(message, endpointName, catalog);
			} catch (err) {
				opts.logger?.warn('Point-name normalization failed for a message, skipping', err);
			}
		}
		return messages;
	};
}

function attachIdentity(reading: ProtocolMessage, endpointNameHint: string, catalog: PointNameCatalog): void {
	const rawName = reading.metric ?? reading.name;
	if (typeof rawName !== 'string' || rawName.length === 0) return;

	const sourceSystem = typeof reading.protocol === 'string' ? reading.protocol : undefined;
	const deviceKeyRaw = reading.deviceId ?? reading.device_uuid ?? reading.endpoint_uuid;
	const deviceKey = typeof deviceKeyRaw === 'string' ? deviceKeyRaw : '';
	const rawDeviceName = typeof reading.deviceName === 'string' ? reading.deviceName : undefined;
	// Never fabricated — only carried through if a reading already has it (no
	// adapter attaches this in Phase 1, plan §1/§2).
	const sourceAddress = typeof reading.sourceAddress === 'string' ? reading.sourceAddress : undefined;

	const identity: PointIdentity = catalog.resolve({
		sourceSystem,
		endpointName: endpointNameHint,
		deviceKey,
		rawName,
		rawDeviceName,
		sourceAddress,
	});

	reading.pointIdentity = identity;
}
