/**
 * MQTT Discovery Plugin — Device-Centric Model
 *
 * Groups topics into logical devices by analyzing the topic tree structure.
 * One device = a set of related topics sharing a common base prefix.
 * Sub-topics become data points under that device.
 *
 * Matches the pattern used by all other protocols:
 * - Modbus: one device per slave, registers as data points
 * - OPC-UA: one device per server, nodes as data points
 * - BACnet: one device per instance, objects as data points
 * - MQTT:   one device per topic prefix, sub-topics as data points
 */

import type { AgentLogger } from "../../logging/agent-logger";
import { createHash } from "crypto";
import { LogComponents } from "../../logging/types";
import {
	type DiscoveredDevice,
	type ValidationResult,
} from "../types";

import { BaseDiscovery } from '../base';
import * as mqtt from "mqtt";

export interface MqttDiscoveryOptions {
	brokerUrl?: string;
	username?: string;
	password?: string;
	topics: string[];
	samplingDurationMs?: number;
	qos?: 0 | 1 | 2;
	topicPattern?: string; // e.g., 'factory/{deviceId}/+' — explicit device segment hint

	ca?: Buffer;
	cert?: Buffer;
	key?: Buffer;
	rejectUnauthorized?: boolean;
}

interface TopicValidation {
	topic: string;
	messagesReceived: number;
	retainedMessagesReceived: number;
	firstPayload?: string;
	firstSeen?: Date;
	lastSeen?: Date;
	hasRetained?: boolean;
	hasLive?: boolean;
}

interface TopicTreeNode {
	segment: string;
	children: Map<string, TopicTreeNode>;
	validations: TopicValidation[];
}

interface DeviceGroup {
	deviceId: string;
	baseTopic: string;
	dataPointTopics: Map<string, TopicValidation>;
}

export class MqttDiscovery extends BaseDiscovery {
	private client?: mqtt.MqttClient;
	private validatedTopics: Map<string, TopicValidation> = new Map();
	private brokerConfig?: MqttDiscoveryOptions;

	constructor(
		logger?: AgentLogger,
		private mqttFactory: (
			url: string,
			options: any,
		) => mqtt.MqttClient = mqtt.connect,
	) {
		super("mqtt", logger);
	}

	generateFingerprint(baseTopic: string): string {
		return createHash('sha256').update(`mqtt:${baseTopic}`).digest('hex').substring(0, 32);
	}

	async discover(
		options?: MqttDiscoveryOptions,
		signal?: AbortSignal,
	): Promise<DiscoveredDevice[]> {
		this.validatedTopics.clear();

		const brokerUrl = options?.brokerUrl || process.env.MQTT_BROKER_URL;
		if (!brokerUrl) {
			throw new Error("MQTT_BROKER_URL is required for MQTT discovery");
		}
		const topics = options?.topics || [];
		const samplingDurationMs = options?.samplingDurationMs || 10000;
		const qos = options?.qos ?? 0;

		this.brokerConfig = options;

		if (!topics || topics.length === 0) {
			this.logger?.warnSync("No topics provided for MQTT discovery", {
				component: (LogComponents.discovery + "] [" + this.protocol) as any,
				hint: 'Provide explicit topics to validate (e.g., ["factory/#"])',
			});
			return [];
		}

		this.logger?.infoSync("Starting MQTT device discovery", {
			component: (LogComponents.discovery + "] [" + this.protocol) as any,
			protocol: this.protocol,
			phase: "discovery",
			brokerUrl,
			topicCount: topics.length,
			topics: topics.slice(0, 5),
			samplingDurationMs,
			topicPattern: options?.topicPattern,
		});

		try {
			this.client = this.mqttFactory(brokerUrl, {
				username: options?.username,
				password: options?.password,
				clientId: `iotistic-discovery-${Date.now()}`,
				clean: true,
				reconnectPeriod: 0,
				ca: options?.ca,
				cert: options?.cert,
				key: options?.key,
				rejectUnauthorized: options?.rejectUnauthorized ?? true,
			});

			if (signal) {
				signal.addEventListener("abort", () => {
					this.logger?.warnSync("Discovery aborted by signal", {
						component: (LogComponents.discovery + "] [" + this.protocol) as any,
					});
					this.cleanupClient();
				});
			}

			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => {
					this.logger?.errorSync(
						"MQTT connection timeout - broker unreachable",
						undefined,
						{
							component: (LogComponents.discovery +
								"] [" +
								this.protocol) as any,
							brokerUrl,
							timeout: "5000ms",
							hint: "Check if broker is running and accessible",
						},
					);
					reject(
						new Error(`MQTT connection timeout - cannot reach ${brokerUrl}`),
					);
				}, 5000);

				this.client!.on("connect", () => {
					clearTimeout(timeout);
					this.logger?.infoSync("Connected to MQTT broker for discovery", {
						component: (LogComponents.discovery + "] [" + this.protocol) as any,
						brokerUrl,
					});
					resolve();
				});

				this.client!.on("error", (err) => {
					clearTimeout(timeout);
					this.logger?.errorSync("MQTT connection error", err, {
						component: (LogComponents.discovery + "] [" + this.protocol) as any,
						brokerUrl,
						error: err.message,
					});
					reject(err);
				});
			});

			for (const topic of topics) {
				await new Promise<void>((resolve, reject) => {
					this.client!.subscribe(topic, { qos }, (err) => {
						if (err) {
							this.logger?.errorSync(
								`Failed to subscribe to topic: ${topic}`,
								err,
								{
									component: (LogComponents.discovery +
										"] [" +
										this.protocol) as any,
								},
							);
							reject(err);
						} else {
							this.logger?.debugSync(`Subscribed to topic: ${topic}`, {
								component: (LogComponents.discovery +
									"] [" +
									this.protocol) as any,
							});
							resolve();
						}
					});
				});
			}

			this.logger?.debugSync(
				`Sampling ${topics.length} topics for ${samplingDurationMs}ms`,
				{
					component: (LogComponents.discovery + "] [" + this.protocol) as any,
				},
			);

			this.client.on("message", (topic, payload, packet) => {
				this.handleMessage(topic, payload.toString(), packet.retain);
			});

			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, samplingDurationMs);
				signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					resolve();
				});
			});

			this.cleanupClient();

			const activeTopics = Array.from(this.validatedTopics.values()).filter(
				(t) => t.messagesReceived > 0,
			);
			const inactiveTopics = Array.from(this.validatedTopics.values()).filter(
				(t) => t.messagesReceived === 0,
			);

			this.logger?.infoSync("Discovery sampling complete", {
				component: (LogComponents.discovery + "] [" + this.protocol) as any,
				totalTopics: this.validatedTopics.size,
				activeTopics: activeTopics.length,
				inactiveTopics: inactiveTopics.length,
			});

			if (inactiveTopics.length > 0) {
				this.logger?.warnSync(
					`${inactiveTopics.length} topic(s) did not receive messages during sampling period`,
					{
						component: (LogComponents.discovery + "] [" + this.protocol) as any,
						inactiveTopics: inactiveTopics.map((t) => t.topic),
						recommendation:
							"Verify publishers are active or increase samplingDurationMs",
					},
				);
			}

			const retainedOnlyTopics = activeTopics.filter(
				(t) => t.hasRetained && !t.hasLive,
			);
			if (retainedOnlyTopics.length > 0) {
				this.logger?.warnSync(
					`${retainedOnlyTopics.length} topic(s) have only retained messages (no live publisher observed)`,
					{
						component: (LogComponents.discovery + "] [" + this.protocol) as any,
						retainedOnlyTopics: retainedOnlyTopics.map((t) => t.topic),
						recommendation:
							"These topics may have stale data - verify publishers are running",
					},
				);
			}

			const deviceGroups = this.groupTopicsIntoDevices(activeTopics, options?.topicPattern);
			return this.convertGroupsToDevices(deviceGroups);
		} catch (error) {
			this.logger?.errorSync("MQTT discovery failed", error as Error, {
				component: (LogComponents.discovery + "] [" + this.protocol) as any,
			});

			this.cleanupClient();
			throw error;
		}
	}

	private handleMessage(
		topic: string,
		payload: string,
		isRetained: boolean = false,
	): void {
		let validation = this.validatedTopics.get(topic);
		if (!validation) {
			validation = {
				topic,
				messagesReceived: 0,
				retainedMessagesReceived: 0,
				hasRetained: false,
				hasLive: false,
			};
			this.validatedTopics.set(topic, validation);
		}

		const now = new Date();

		if (validation.messagesReceived === 0) {
			validation.firstPayload = payload;
			validation.firstSeen = now;

			this.logger?.debugSync(`Topic active: ${topic}`, {
				component: (LogComponents.discovery + "] [" + this.protocol) as any,
				payloadPreview: payload.substring(0, 100),
				retained: isRetained,
			});
		}

		validation.messagesReceived++;
		validation.lastSeen = now;

		if (isRetained) {
			validation.retainedMessagesReceived++;
			validation.hasRetained = true;
		} else {
			validation.hasLive = true;
		}
	}

	/**
	 * Group active topics into logical devices by analyzing topic tree structure.
	 *
	 * Algorithm:
	 * 1. Build a trie from all observed topic paths.
	 * 2. Find the "device level" — the depth where siblings share common
	 *    sub-topic names (indicating they are instances of the same device type).
	 * 3. Each node at the device level becomes one DeviceGroup with its
	 *    sub-topics as data points.
	 *
	 * Fallback: if no branching pattern is found, each topic = one device.
	 */
	private groupTopicsIntoDevices(
		activeTopics: TopicValidation[],
		topicPattern?: string,
	): DeviceGroup[] {
		if (activeTopics.length === 0) {
			return [];
		}

		// If user provided a topic pattern hint, use it directly
		if (topicPattern) {
			return this.groupByPattern(activeTopics, topicPattern);
		}

		// Build topic tree
		const root: TopicTreeNode = { segment: '', children: new Map(), validations: [] };
		for (const validation of activeTopics) {
			const segments = validation.topic.split('/');
			let node = root;
			for (const segment of segments) {
				if (!node.children.has(segment)) {
					node.children.set(segment, {
						segment,
						children: new Map(),
						validations: [],
					});
				}
				node = node.children.get(segment)!;
			}
			node.validations.push(validation);
		}

		// Find the device level by walking the trie
		const deviceLevel = this.findDeviceLevel(root);

		if (deviceLevel === null) {
			// No grouping pattern found — each topic is its own device (backward compat)
			return activeTopics.map(v => ({
				deviceId: v.topic.replace(/\//g, '_'),
				baseTopic: v.topic,
				dataPointTopics: new Map([[v.topic, v]]),
			}));
		}

		// Collect device groups at the identified level
		return this.collectDeviceGroups(root, deviceLevel);
	}

	/**
	 * Group topics using an explicit user-provided pattern.
	 * Pattern uses {deviceId} as the placeholder for the device segment.
	 * e.g., 'factory/{deviceId}/+' means topic level 1 is the device ID.
	 */
	private groupByPattern(
		activeTopics: TopicValidation[],
		pattern: string,
	): DeviceGroup[] {
		const patternSegments = pattern.split('/');
		const deviceSegmentIdx = patternSegments.findIndex(s => s === '{deviceId}');

		if (deviceSegmentIdx < 0) {
			this.logger?.warnSync(
				"topicPattern must contain {deviceId} placeholder, falling back to tree analysis",
				{ component: (LogComponents.discovery + "] [" + this.protocol) as any, pattern },
			);
			return this.groupTopicsIntoDevices(activeTopics, undefined);
		}

		const groups = new Map<string, DeviceGroup>();

		for (const validation of activeTopics) {
			const segments = validation.topic.split('/');
			if (segments.length <= deviceSegmentIdx) {
				continue;
			}

			const deviceId = segments[deviceSegmentIdx];
			const baseTopic = segments.slice(0, deviceSegmentIdx + 1).join('/');
			const subTopic = segments.slice(deviceSegmentIdx + 1).join('/');

			if (!groups.has(baseTopic)) {
				groups.set(baseTopic, {
					deviceId,
					baseTopic,
					dataPointTopics: new Map(),
				});
			}

			const key = subTopic || validation.topic;
			groups.get(baseTopic)!.dataPointTopics.set(key, validation);
		}

		return Array.from(groups.values());
	}

	/**
	 * Walk the trie to find the depth where device instances branch.
	 *
	 * The heuristic: a level contains device IDs when it has multiple siblings
	 * AND those siblings share at least one common child name (the data points).
	 *
	 * Returns the depth (0-indexed from root children) or null if no pattern found.
	 */
	private findDeviceLevel(root: TopicTreeNode): number | null {
		let currentNodes: TopicTreeNode[] = Array.from(root.children.values());
		let depth = 0;

		while (currentNodes.length > 0) {
			// If this level has multiple nodes, check if they share sub-topic names
			if (currentNodes.length > 1) {
				const childNameSets = currentNodes
					.filter(n => n.children.size > 0)
					.map(n => new Set(n.children.keys()));

				if (childNameSets.length >= 2) {
					// Find intersection of child names across siblings
					const first = childNameSets[0];
					const shared = [...first].filter(name =>
						childNameSets.every(s => s.has(name))
					);

					if (shared.length > 0) {
						return depth;
					}
				}
			}

			// Go one level deeper: collect all children from current level
			const nextLevel: TopicTreeNode[] = [];
			for (const node of currentNodes) {
				for (const child of node.children.values()) {
					nextLevel.push(child);
				}
			}
			currentNodes = nextLevel;
			depth++;
		}

		return null;
	}

	/**
	 * Collect all device groups at the identified depth in the trie.
	 */
	private collectDeviceGroups(
		root: TopicTreeNode,
		deviceLevel: number,
	): DeviceGroup[] {
		const groups: DeviceGroup[] = [];

		const collectAtLevel = (
			node: TopicTreeNode,
			currentDepth: number,
			pathSoFar: string[],
		): void => {
			if (currentDepth === deviceLevel) {
				const baseTopic = pathSoFar.join('/');
				const dataPointTopics = new Map<string, TopicValidation>();

				this.collectLeafValidations(node, '', dataPointTopics);

				for (const v of node.validations) {
					dataPointTopics.set('', v);
				}

				if (dataPointTopics.size > 0) {
					groups.push({
						deviceId: node.segment,
						baseTopic,
						dataPointTopics,
					});
				}
				return;
			}

			for (const child of node.children.values()) {
				collectAtLevel(child, currentDepth + 1, [...pathSoFar, child.segment]);
			}
		};

		for (const child of root.children.values()) {
			collectAtLevel(child, 0, [child.segment]);
		}

		return groups;
	}

	private collectLeafValidations(
		node: TopicTreeNode,
		relativePath: string,
		result: Map<string, TopicValidation>,
	): void {
		for (const [segment, child] of node.children) {
			const subPath = relativePath ? `${relativePath}/${segment}` : segment;

			for (const v of child.validations) {
				result.set(subPath, v);
			}

			this.collectLeafValidations(child, subPath, result);
		}
	}

	private inferDataType(payload: string): string {
		try {
			const parsed = JSON.parse(payload);
			if (typeof parsed === "object") return "json";
			if (typeof parsed === "number" && Number.isFinite(parsed)) return "number";
			if (typeof parsed === "boolean") return "boolean";
			return "string";
		} catch {
			const trimmed = payload.trim();
			const lower = trimmed.toLowerCase();
			if (lower === "true" || lower === "false") return "boolean";
			if (/^-?\d+(\.\d+)?$/.test(trimmed)) return "number";
			return "string";
		}
	}

	private extractSampleFields(payload: string): string[] | undefined {
		try {
			const parsed = JSON.parse(payload);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				return Object.keys(parsed).filter(key => {
					const val = parsed[key];
					return val === null || typeof val !== "object";
				}).slice(0, 20);
			}
		} catch { /* not JSON */ }
		return undefined;
	}

	private convertGroupsToDevices(groups: DeviceGroup[]): DiscoveredDevice[] {
		const devices: DiscoveredDevice[] = [];

		let brokerHost: string | undefined;
		let brokerPort: number | undefined;
		const rawUrl = this.brokerConfig?.brokerUrl || process.env.MQTT_BROKER_URL;
		if (rawUrl) {
			try {
				const url = new URL(rawUrl);
				brokerHost = url.hostname;
				brokerPort = parseInt(url.port) || 1883;
			} catch { /* leave undefined */ }
		}

		for (const group of groups) {
			const fingerprint = this.generateFingerprint(group.baseTopic);

			let topicName = group.baseTopic.replace(/\//g, '_');
			if (topicName.length > 58) {
				topicName = "..." + topicName.slice(-55);
			}
			const name = `mqtt_${topicName}`;

			const dataPoints: any[] = [];
			let earliestSeen: Date | undefined;

			for (const [subTopic, validation] of group.dataPointTopics) {
				const dataType = validation.firstPayload
					? this.inferDataType(validation.firstPayload)
					: "string";
				const sampleFields = validation.firstPayload
					? this.extractSampleFields(validation.firstPayload)
					: undefined;

				dataPoints.push({
					subTopic: subTopic || group.baseTopic.split('/').pop() || '',
					fullTopic: validation.topic,
					dataType,
					...(sampleFields && sampleFields.length > 0 ? { sampleFields } : {}),
				});

				if (validation.firstSeen && (!earliestSeen || validation.firstSeen < earliestSeen)) {
					earliestSeen = validation.firstSeen;
				}
			}

			const device: DiscoveredDevice = {
				name,
				protocol: "mqtt",
				fingerprint,
				connection: {
					baseTopic: group.baseTopic,
					...(brokerHost ? { host: brokerHost } : {}),
					...(brokerPort ? { port: brokerPort } : {}),
					autoMetrics: true,
				},
				dataPoints,
				confidence: "high",
				discoveredAt:
					earliestSeen?.toISOString() || new Date().toISOString(),
				validated: false,
			};

			devices.push(device);

			this.logger?.debugSync(`Discovered device: ${name}`, {
				component: (LogComponents.discovery + "] [" + this.protocol) as any,
				baseTopic: group.baseTopic,
				dataPointCount: dataPoints.length,
				dataPointTopics: dataPoints.map((dp: any) => dp.subTopic),
			});
		}

		return devices;
	}

	async validate(device: DiscoveredDevice): Promise<ValidationResult> {
		const baseTopic = device.connection?.baseTopic || device.connection?.topic;

		if (!baseTopic || typeof baseTopic !== "string") {
			return {
				deviceInfo: {
					valid: false,
					message: "Invalid device configuration - missing baseTopic field",
				},
			};
		}

		this.logger?.debugSync("Validating MQTT device", {
			component: (LogComponents.discovery + "] [" + this.protocol) as any,
			baseTopic,
		});

		try {
			const brokerUrl =
				this.brokerConfig?.brokerUrl || process.env.MQTT_BROKER_URL;
			if (!brokerUrl) {
				throw new Error(
					"MQTT_BROKER_URL is required for MQTT device validation",
				);
			}

			// Subscribe to baseTopic/# to check if any sub-topic is active
			const subscriptionTopic = `${baseTopic}/#`;
			const validationResult = await this.quickValidateTopic(
				brokerUrl,
				subscriptionTopic,
				this.brokerConfig,
			);

			if (validationResult) {
				this.logger?.infoSync(`Device validated successfully: ${baseTopic}`, {
					component: (LogComponents.discovery + "] [" + this.protocol) as any,
				});

				return {
					deviceInfo: {
						valid: true,
						message: "Device is active — messages received on sub-topics",
					},
				};
			} else {
				this.logger?.warnSync(
					`Device validation failed (no messages): ${baseTopic}`,
					{
						component: (LogComponents.discovery + "] [" + this.protocol) as any,
					},
				);

				return {
					deviceInfo: {
						valid: false,
						message: "No messages received during validation period",
					},
				};
			}
		} catch (error) {
			this.logger?.errorSync("Device validation error", error as Error, {
				component: (LogComponents.discovery + "] [" + this.protocol) as any,
				baseTopic,
			});

			return {
				deviceInfo: {
					valid: false,
					message: `Validation failed: ${(error as Error).message}`,
				},
			};
		}
	}

	private async quickValidateTopic(
		brokerUrl: string,
		topic: string,
		config?: MqttDiscoveryOptions,
	): Promise<boolean> {
		return new Promise((resolve) => {
			let resolved = false;

			const safeResolve = (value: boolean) => {
				if (!resolved) {
					resolved = true;
					resolve(value);
				}
			};

			const client = this.mqttFactory(brokerUrl, {
				clientId: `iotistic-validate-${Date.now()}`,
				clean: true,
				reconnectPeriod: 0,
				username: config?.username,
				password: config?.password,
				ca: config?.ca,
				cert: config?.cert,
				key: config?.key,
				rejectUnauthorized: config?.rejectUnauthorized ?? true,
			});

			let messageReceived = false;
			const timeout = setTimeout(() => {
				client.removeAllListeners("message");
				client.removeAllListeners("error");
				client.removeAllListeners("connect");
				client.end(true);
				safeResolve(messageReceived);
			}, 5000);

			const connectHandler = () => {
				client.subscribe(topic, { qos: 0 }, (err) => {
					if (err) {
						clearTimeout(timeout);
						client.removeAllListeners("message");
						client.removeAllListeners("error");
						client.removeAllListeners("connect");
						client.end(true);
						safeResolve(false);
					}
				});
			};

			const messageHandler = () => {
				messageReceived = true;
				clearTimeout(timeout);
				client.removeAllListeners("message");
				client.removeAllListeners("error");
				client.removeAllListeners("connect");
				client.end(true);
				safeResolve(true);
			};

			const errorHandler = () => {
				clearTimeout(timeout);
				client.removeAllListeners("message");
				client.removeAllListeners("error");
				client.removeAllListeners("connect");
				client.end(true);
				safeResolve(false);
			};

			client.on("connect", connectHandler);
			client.on("message", messageHandler);
			client.on("error", errorHandler);
		});
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	private cleanupClient(): void {
		if (this.client) {
			this.client.removeAllListeners("message");
			this.client.removeAllListeners("error");
			this.client.removeAllListeners("connect");
			this.client.end(true);
			this.client = undefined;
		}
	}
}
