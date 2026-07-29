import { type BACnetDevice, type BACnetObject, type BACnetWriteDataType, BACnetObjectType, BACnetProperty } from './types';
import { type Logger, type IProtocolClient } from '../types';
import { pLimit } from '../../lib/p-limit.js';
import BACnet from 'bacstack';

/** Shared between reads and writes — bacstack identifies object types by number, not by our string enum. */
const OBJECT_TYPE_MAP: Record<string, number> = {
	'analog-input': 0,
	'analog-output': 1,
	'analog-value': 2,
	'binary-input': 3,
	'binary-output': 4,
	'binary-value': 5,
	'multi-state-input': 13,
	'multi-state-output': 14,
	'multi-state-value': 19,
};

interface BACnetReadResult {
  objectId: {
    type: number;
    instance: number;
  };
  values: Array<{
    propertyIdentifier: number;
    value: any;
  }>;
}

/**
 * BACnet Client wrapper for bacstack library
 * Handles connection, reads, and error handling for a single device
 */
export class BACnetClient implements IProtocolClient<BACnetObject[], Map<string, { value: any; quality: 'GOOD' | 'BAD'; error?: string }>> {
	// Each client needs a unique local UDP port so bacstack doesn't fight over the same socket.
	// Discovery uses 47809; adapter clients start at 47810 and increment per instance.
	// Fixed ports are more reliable than port=0 (ephemeral) — with ephemeral ports the OS-assigned
	// port is only known after the async bind completes, and the 100ms heuristic can race on slow
	// hosts, leaving the transport patch applied to an unbound socket.
	private static _nextPort = 47810;

	private config: BACnetDevice;
	private logger: Logger;
	private client: any;
	private connected: boolean = false;
	private lastError: string | null = null;

	constructor(config: BACnetDevice, _bacnetPort: number, logger: Logger) {
		this.config = config;
		this.logger = logger;

		const localPort = BACnetClient._nextPort++;

		this.client = new BACnet({
			apduTimeout: config.connectionTimeoutMs,
			port: localPort,
			broadcastAddress: '255.255.255.255',
			deviceId: 4190000 + Math.floor(Math.random() * 1000),
		});

		// bacstack uses this._settings.port as the UDP destination port even for
		// unicast ReadProperty calls.  With bacnetPort=47809 every packet would
		// go to port 47809, but BACnet devices listen on port 47808.  Patch
		// transport.send so we listen on bacnetPort but always send to 47808.
		// The patch is also applied (re-applied) in connect() after the socket
		// has had time to bind, in case _transport._server is not yet ready here.
		this._applyTransportPatch();

		this.logger.debug(`BACnet client initialized for ${config.name} (${config.ipAddress}:${config.port})`);
	}

	/**
   * Patch the bacstack transport so all outgoing packets are sent to the
   * standard BACnet port (47808) regardless of which port this client is
   * bound to locally.  Safe to call multiple times; subsequent calls are
   * no-ops if the patch is already in place.
   */
	private _applyTransportPatch(): void {
		const xport = (this.client)?._transport;
		if (!xport) return;
		const server = xport._server;
		if (!server || typeof server.send !== 'function') return;
		// Guard: don't double-patch
		if ((xport)._portPatched) return;
		xport.send = (buffer: Buffer, offset: number, receiver: string) => {
			server.send(buffer, 0, offset, 47808, receiver);
		};
		(xport)._portPatched = true;
	}

	/**
   * Connect to the BACnet device
   */
	async connect(): Promise<void> {
		try {
			// bacstack doesn't have explicit connect - it uses UDP
			// Just verify device is reachable with a Who-Is
			// Re-apply the transport patch here after the UDP socket has had time
			// to bind (bacstack binds asynchronously in its constructor).
			await new Promise(resolve => setTimeout(resolve, 100));
			this._applyTransportPatch();

			const xport = (this.client)?._transport;
			const patched = !!(xport)?._portPatched;
			const serverExists = !!xport?._server;
			this.logger.debug(`BACnet transport state: xport=${!!xport} server=${serverExists} patched=${patched}`);

			this.connected = true;
			this.lastError = null;
			this.logger.debug(`BACnet client connected to ${this.config.name}`);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.lastError = errorMessage;
			this.connected = false;
			throw new Error(`Failed to connect to ${this.config.name}: ${errorMessage}`);
		}
	}

	/**
   * Disconnect from the BACnet device
   */
	async disconnect(): Promise<void> {
		try {
			if (this.client) {
				this.client.close();
			}
			this.connected = false;
			this.logger.debug(`BACnet client disconnected from ${this.config.name}`);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.warn(`Error disconnecting from ${this.config.name}: ${errorMessage}`);
		}
	}

	/**
   * Read the BACnet Device object's objectName property (BACnet property 77).
   * Returns the device's self-reported name, or null if unavailable.
   * Device object type is 8; instance is the device's deviceInstance number.
   */
	async readDeviceName(): Promise<string | null> {
		if (!this.connected || !this.config.deviceInstance) {
			return null;
		}

		const DEVICE_OBJECT_TYPE = 8;  // BACnet Device object type
		const PROP_OBJECT_NAME = 77;   // BACnet objectName property

		return new Promise((resolve) => {
			const timeout = setTimeout(() => resolve(null), this.config.connectionTimeoutMs);

			try {
				this.client.readProperty(
					this.config.ipAddress,
					{ type: DEVICE_OBJECT_TYPE, instance: this.config.deviceInstance },
					PROP_OBJECT_NAME,
					(err: Error | null, value: any) => {
						clearTimeout(timeout);
						if (err) {
							resolve(null);
							return;
						}
						// bacstack returns objectName as a CharacterString in values[0].value[0].value
						const name = value?.values?.[0]?.value?.[0]?.value;
						resolve(typeof name === 'string' && name.trim() ? name.trim() : null);
					}
				);
			} catch {
				clearTimeout(timeout);
				resolve(null);
			}
		});
	}

	/**
   * Read a single object's present value, with retry on transient timeout.
   * retryAttempts and retryDelayMs come from the device config (defaults: 1 / 500ms).
   */
	async readObject(
		object: BACnetObject,
		remainingRetries: number = this.config.retryAttempts ?? 1
	): Promise<{ value: any; quality: 'GOOD' | 'BAD'; error?: string }> {
		if (!this.connected) {
			return {
				value: null,
				quality: 'BAD',
				error: 'Not connected'
			};
		}

		try {
			const objectTypeNum = OBJECT_TYPE_MAP[object.objectType];
			if (objectTypeNum === undefined) {
				throw new Error(`Unknown object type: ${object.objectType}`);
			}

			const result = await new Promise<BACnetReadResult>((resolve, reject) => {
				const timeout = setTimeout(() => {
					reject(new Error('Read timeout'));
				}, this.config.connectionTimeoutMs);

				this.client.readProperty(
					this.config.ipAddress,
					{
						type: objectTypeNum,
						instance: object.objectInstance
					},
					object.propertyId || BACnetProperty.PRESENT_VALUE,
					(err: Error | null, value: BACnetReadResult) => {
						clearTimeout(timeout);
						if (err) {
							reject(err);
						} else {
							resolve(value);
						}
					}
				);
			});

			// bacstack wraps decoded values as [{ value, type }] — unwrap to scalar
			const rawValue = result.values?.[0]?.value;
			const presentValue = Array.isArray(rawValue) && rawValue.length > 0
				? rawValue[0]?.value
				: rawValue;

			return {
				value: presentValue,
				quality: 'GOOD'
			};

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);

			if (remainingRetries > 0) {
				await new Promise(r => setTimeout(r, this.config.retryDelayMs ?? 500));
				return this.readObject(object, remainingRetries - 1);
			}

			this.lastError = errorMessage;
			this.logger.warn(`Error reading ${object.name} from ${this.config.name}: ${errorMessage}`);

			return {
				value: null,
				quality: 'BAD',
				error: errorMessage
			};
		}
	}

	/**
   * Read multiple objects in batch (sequential for now, can optimize with ReadPropertyMultiple later)
   */
	async readObjects(objects: BACnetObject[]): Promise<Map<string, { value: any; quality: 'GOOD' | 'BAD'; error?: string }>> {
		const results = new Map<string, { value: any; quality: 'GOOD' | 'BAD'; error?: string }>();

		// Use maxConcurrentReads to limit concurrency
		const limit = pLimit(this.config.maxConcurrentReads);

		const readPromises = objects.map(obj =>
			limit(async () => {
				const result = await this.readObject(obj);
				results.set(obj.name, result);
			})
		);

		await Promise.all(readPromises);
		return results;
	}

	async read(objects: BACnetObject[] = this.config.objects): Promise<Map<string, { value: any; quality: 'GOOD' | 'BAD'; error?: string }>> {
		return this.readObjects(objects);
	}

	/** Read-only lookup of a configured object by name, e.g. for allowlist checks by callers that don't own a write path of their own. */
	getObjectConfig(pointName: string): BACnetObject | undefined {
		return this.config.objects.find((o) => o.name === pointName);
	}

	/**
	 * Resolves the BACnet application tag to encode a write with. Explicit
	 * `writeDataType` wins; otherwise inferred from `objectType`, since an
	 * analog-* is virtually always Real, a binary-* Boolean, and a
	 * multi-state-* an Unsigned Integer.
	 */
	private resolveWriteTag(object: BACnetObject): number {
		const tags = BACnet.enum.ApplicationTags;
		const explicit: Record<BACnetWriteDataType, number> = {
			boolean: tags.BOOLEAN,
			unsigned: tags.UNSIGNED_INTEGER,
			signed: tags.SIGNED_INTEGER,
			real: tags.REAL,
			double: tags.DOUBLE,
			enumerated: tags.ENUMERATED,
			string: tags.CHARACTER_STRING,
		};
		if (object.writeDataType) {
			return explicit[object.writeDataType];
		}

		switch (object.objectType) {
			case BACnetObjectType.ANALOG_INPUT:
			case BACnetObjectType.ANALOG_OUTPUT:
			case BACnetObjectType.ANALOG_VALUE:
				return tags.REAL;
			case BACnetObjectType.BINARY_INPUT:
			case BACnetObjectType.BINARY_OUTPUT:
			case BACnetObjectType.BINARY_VALUE:
				return tags.BOOLEAN;
			case BACnetObjectType.MULTI_STATE_INPUT:
			case BACnetObjectType.MULTI_STATE_OUTPUT:
			case BACnetObjectType.MULTI_STATE_VALUE:
				return tags.UNSIGNED_INTEGER;
			default:
				throw new Error(`Cannot infer BACnet write data type for object type: ${object.objectType} — set writeDataType explicitly`);
		}
	}

	/** Validates the command value matches what the resolved application tag expects, without silently coercing types. */
	private coerceWriteValue(tag: number, value: number | boolean | string): number | boolean | string {
		const tags = BACnet.enum.ApplicationTags;
		if (tag === tags.BOOLEAN) {
			if (typeof value !== 'boolean') {
				throw new Error(`Expected a boolean value, got ${typeof value}`);
			}
			return value;
		}
		if (tag === tags.CHARACTER_STRING) {
			if (typeof value !== 'string') {
				throw new Error(`Expected a string value, got ${typeof value}`);
			}
			return value;
		}
		// UNSIGNED_INTEGER, SIGNED_INTEGER, REAL, DOUBLE, ENUMERATED all take a JS number.
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new Error(`Expected a finite numeric value, got ${typeof value === 'number' ? value : typeof value}`);
		}
		return value;
	}

	/**
	 * Writes a single object's present value using BACnet's priority-array
	 * WriteProperty service. `writable` and `writePriority` come from this
	 * object's own configuration — never from the caller — matching the
	 * read-only allowlist pattern OPC-UA/Modbus already use for MQTT commands.
	 */
	async write(pointName: string, value: number | boolean | string): Promise<void> {
		const object = this.config.objects.find((o) => o.name === pointName);
		if (!object) {
			throw new Error(`Object not found on device ${this.config.name}: ${pointName}`);
		}
		if (!object.writable) {
			throw new Error(`Object is not writable: ${object.name}`);
		}
		if (!this.connected) {
			throw new Error(`Device ${this.config.name} is not connected`);
		}

		const objectTypeNum = OBJECT_TYPE_MAP[object.objectType];
		if (objectTypeNum === undefined) {
			throw new Error(`Unknown object type: ${object.objectType}`);
		}

		const tag = this.resolveWriteTag(object);
		const encodedValue = this.coerceWriteValue(tag, value);

		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error('Write timeout'));
			}, this.config.connectionTimeoutMs);

			this.client.writeProperty(
				this.config.ipAddress,
				{ type: objectTypeNum, instance: object.objectInstance },
				object.propertyId || BACnetProperty.PRESENT_VALUE,
				[{ type: tag, value: encodedValue }],
				{ priority: object.writePriority },
				(err: Error | null) => {
					clearTimeout(timeout);
					if (err) {
						reject(err);
					} else {
						resolve();
					}
				}
			);
		});
	}

	/**
   * Get device name
   */
	getDeviceName(): string {
		return this.config.name;
	}

	/**
   * Get connection status
   */
	isConnected(): boolean {
		return this.connected;
	}

	/**
   * Get last error
   */
	getLastError(): string | null {
		return this.lastError;
	}
}
