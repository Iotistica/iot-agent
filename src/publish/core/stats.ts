import type { DeviceStats, Logger } from '../core/types.js';
import type { CompressionInfo } from './compress.js';

/**
 * Tracks all publish-side metrics for one endpoint.
 * Does not track messagesReceived or reconnectAttempts — those are
 * provided externally by the manager from MessageBatcher.totalReceived
 * and EndpointConnection.attempts respectively.
 */
export class PublishStats {
	readonly data: DeviceStats = {
		messagesReceived: 0,
		messagesPublished: 0,
		bytesReceived: 0,
		bytesPublished: 0,
		reconnectAttempts: 0,
	};

	recordPublish(messageCount: number, batchBytes: number): void {
		this.data.messagesPublished += messageCount;
		this.data.bytesPublished += batchBytes;
		this.data.lastPublishTime = new Date();
	}

	recordError(message: string): void {
		this.data.lastError = message;
		this.data.lastErrorTime = new Date();
	}

	recordConnected(): void {
		this.data.lastConnectedTime = new Date();
		this.data.reconnectAttempts = 0;
	}

	recordHeartbeat(): void {
		this.data.lastHeartbeatTime = new Date();
	}

	logPublishSuccess(
		messageCount: number,
		batchBytes: number,
		info: CompressionInfo,
		deviceName: string,
		logger?: Logger,
		extraContext?: Record<string, unknown>,
	): void {
		if (!logger) return;

		const destinations = Array.isArray(extraContext?.destinations) ? extraContext.destinations as string[] : [];
		const buffered = Array.isArray(extraContext?.buffered) ? extraContext.buffered as string[] : [];

		logger.info('Published batch', {
			source: deviceName,
			messages: messageCount,
			batchBytes,
			...(destinations.length > 0 && { destinations }),
			...(buffered.length > 0 && { buffered }),
			...(info.originalSize > info.compressedSize && { saved: `${info.ratio.toFixed(0)}%` }),
			...(info.isBaseline && { baseline: true }),
		});
	}

	private static formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		const kb = bytes / 1024;
		if (kb < 1024) return `${kb.toFixed(1)} KB`;
		return `${(kb / 1024).toFixed(1)} MB`;
	}
}
