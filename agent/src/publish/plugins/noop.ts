import { EventEmitter } from 'events';
import type { IPublishPlugin, PublishBatchItem, Logger } from '../core/types.js';

export class NoopPublishPlugin extends EventEmitter implements IPublishPlugin {
	private running = false;

	constructor(private readonly logger?: Logger) {
		super();
	}

	async start(): Promise<void> {
		this.running = true;
		this.emit('started');
	}

	async stop(): Promise<void> {
		this.running = false;
		this.emit('stopped');
	}

	isRunning(): boolean { return this.running; }
	isConnected(): boolean { return true; }

	async publishBatch(_batch: PublishBatchItem[]): Promise<void> {
		// intentional no-op — demo destination discards all payloads silently
	}
}
