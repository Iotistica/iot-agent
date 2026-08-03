/**
 * OPC-UA Discovery Plugin
 * 
 * Discovers OPC-UA servers via endpoint discovery
 * Uses OPC-UA's built-in discovery mechanism
 */

import type { AgentLogger } from '../../logging/agent-logger';
import { createHash } from 'crypto';
import { LogComponents } from '../../logging/types';
import { BaseDiscovery } from '../base';
import { type DiscoveredDevice } from '../types';
import type { ConfigManager } from '../../core/config.js';

export interface OPCUADiscoveryOptions {
  discoveryUrls?: string[]; // e.g., ['opc.tcp://localhost:4840']
  scanForServers?: boolean; // Use LDS (Local Discovery Server)
  securityMode?: 'None' | 'Sign' | 'SignAndEncrypt';
  securityPolicy?: 'None' | 'Basic128Rsa15' | 'Basic256' | 'Basic256Sha256' | 'Aes128_Sha256_RsaOaep' | 'Aes256_Sha256_RsaPss';
  certificateTrustMode?: 'strict' | 'trust-on-first-use';
  username?: string;
  password?: string;
}

export interface OPCUABrowseRequest {
	endpointUrl: string;
	maxDepth?: number;
	securityMode?: 'None' | 'Sign' | 'SignAndEncrypt';
	securityPolicy?: 'None' | 'Basic128Rsa15' | 'Basic256' | 'Basic256Sha256' | 'Aes128_Sha256_RsaOaep' | 'Aes256_Sha256_RsaPss';
	certificateTrustMode?: 'strict' | 'trust-on-first-use';
	username?: string;
	password?: string;
}

export interface OPCUABrowseTreeNode {
	nodeId: string;
	browseName: string;
	nodeClass: string;
	dataType: string | null;
	writable: boolean;
	children: OPCUABrowseTreeNode[];
}

export class OPCUADiscovery extends BaseDiscovery {
	private configManager?: ConfigManager;

	private resolveBrowseSecurityMode(mode: OPCUABrowseRequest['securityMode'], MessageSecurityMode: any): any {
		switch (mode) {
			case 'Sign':
				return MessageSecurityMode.Sign;
			case 'SignAndEncrypt':
				return MessageSecurityMode.SignAndEncrypt;
			case 'None':
			case undefined:
			default:
				return MessageSecurityMode.None;
		}
	}

	private resolveBrowseSecurityPolicy(policy: OPCUABrowseRequest['securityPolicy'], SecurityPolicy: any): any {
		switch (policy) {
			case 'Basic128Rsa15':
				return SecurityPolicy.Basic128Rsa15;
			case 'Basic256':
				return SecurityPolicy.Basic256;
			case 'Basic256Sha256':
				return SecurityPolicy.Basic256Sha256;
			case 'Aes128_Sha256_RsaOaep':
				return SecurityPolicy.Aes128_Sha256_RsaOaep;
			case 'Aes256_Sha256_RsaPss':
				return SecurityPolicy.Aes256_Sha256_RsaPss;
			case 'None':
			case undefined:
			default:
				return SecurityPolicy.None;
		}
	}

	private mapNodeClass(value: number | undefined): string {
		switch (value) {
			case 1: return 'Object';
			case 2: return 'Variable';
			case 4: return 'Method';
			case 8: return 'ObjectType';
			case 16: return 'VariableType';
			case 32: return 'ReferenceType';
			case 64: return 'DataType';
			case 128: return 'View';
			case undefined:
			default: return 'Unknown';
		}
	}

	private mapDataTypeName(nodeId: any): string | null {
		if (!nodeId) return null;

		const namespace = typeof nodeId.namespace === 'number' ? nodeId.namespace : 0;
		const value = typeof nodeId.value === 'number' ? nodeId.value : undefined;

		if (namespace === 0 && value !== undefined) {
			const builtIn: Record<number, string> = {
				1: 'Boolean',
				2: 'SByte',
				3: 'Byte',
				4: 'Int16',
				5: 'UInt16',
				6: 'Int32',
				7: 'UInt32',
				8: 'Int64',
				9: 'UInt64',
				10: 'Float',
				11: 'Double',
				12: 'String',
				13: 'DateTime',
				14: 'Guid',
				15: 'ByteString',
				16: 'XmlElement',
				17: 'NodeId',
				18: 'ExpandedNodeId',
				19: 'StatusCode',
				20: 'QualifiedName',
				21: 'LocalizedText',
				22: 'ExtensionObject',
				23: 'DataValue',
				24: 'Variant',
				25: 'DiagnosticInfo',
			};
			if (builtIn[value]) {
				return builtIn[value];
			}
		}

		if (typeof nodeId.toString === 'function') {
			return nodeId.toString();
		}

		return String(nodeId);
	}

	private scoreSecurityMode(securityMode: number | string | undefined): number {
		const mode = typeof securityMode === 'string' ? securityMode : String(securityMode ?? '0');
		switch (mode) {
			case '3':
			case 'SignAndEncrypt':
				return 3;
			case '2':
			case 'Sign':
				return 2;
			default:
				return 1;
		}
	}

	private scoreSecurityPolicy(securityPolicyUri: string | undefined): number {
		switch (securityPolicyUri) {
			case 'http://opcfoundation.org/UA/SecurityPolicy#Aes256_Sha256_RsaPss':
				return 6;
			case 'http://opcfoundation.org/UA/SecurityPolicy#Aes128_Sha256_RsaOaep':
				return 5;
			case 'http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256':
				return 4;
			case 'http://opcfoundation.org/UA/SecurityPolicy#Basic256':
				return 3;
			case 'http://opcfoundation.org/UA/SecurityPolicy#Basic128Rsa15':
				return 2;
			case undefined:
			default:
				return 1;
		}
	}

	private mapSecurityMode(securityMode: number | string | undefined): 'None' | 'Sign' | 'SignAndEncrypt' {
		const mode = typeof securityMode === 'string' ? securityMode : String(securityMode ?? '0');
		switch (mode) {
			case '2':
			case 'Sign':
				return 'Sign';
			case '3':
			case 'SignAndEncrypt':
				return 'SignAndEncrypt';
			default:
				return 'None';
		}
	}

	private mapSecurityPolicy(securityPolicyUri: string | undefined): 'None' | 'Basic128Rsa15' | 'Basic256' | 'Basic256Sha256' | 'Aes128_Sha256_RsaOaep' | 'Aes256_Sha256_RsaPss' {
		switch (securityPolicyUri) {
			case 'http://opcfoundation.org/UA/SecurityPolicy#Basic128Rsa15':
				return 'Basic128Rsa15';
			case 'http://opcfoundation.org/UA/SecurityPolicy#Basic256':
				return 'Basic256';
			case 'http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256':
				return 'Basic256Sha256';
			case 'http://opcfoundation.org/UA/SecurityPolicy#Aes128_Sha256_RsaOaep':
				return 'Aes128_Sha256_RsaOaep';
			case 'http://opcfoundation.org/UA/SecurityPolicy#Aes256_Sha256_RsaPss':
				return 'Aes256_Sha256_RsaPss';
			case undefined:
			default:
				return 'None';
		}
	}

	private selectPreferredEndpoint(endpoints: any[]): any | undefined {
		return endpoints
			.filter((endpoint: any) => endpoint.transportProfileUri?.includes('http://opcfoundation.org/UA-Profile/Transport/uatcp-uasc-uabinary'))
			.sort((left: any, right: any) => {
				const leftScore = (this.scoreSecurityMode(left.securityMode) * 10) + this.scoreSecurityPolicy(left.securityPolicyUri);
				const rightScore = (this.scoreSecurityMode(right.securityMode) * 10) + this.scoreSecurityPolicy(right.securityPolicyUri);
				return rightScore - leftScore;
			})[0];
	}

	private calculateThumbprint(certificate: Buffer | undefined): string | undefined {
		if (!certificate) {
			return undefined;
		}

		return createHash('sha1').update(certificate).digest('hex');
	}

	/**
	 * Probes whether this server actually supports OPC-UA subscriptions, by
	 * creating a real (throwaway) one and seeing whether the server accepts
	 * it — the same session.createSubscription2() call the adapter uses at
	 * runtime, just with a short lifetime since it's discarded immediately.
	 * A server that doesn't implement the Subscribe service, or that's
	 * already at a subscription/session limit, rejects CreateSubscription
	 * outright (e.g. BadServiceUnsupported, BadTooManySubscriptions) — a far
	 * more reliable signal than any capability string in
	 * GetEndpoints/ServerCapabilities, which describe conformance profiles
	 * rather than concrete per-service support and are inconsistently kept
	 * accurate across vendors. Never throws; a failed probe just means
	 * "assume no" so discovery itself is never blocked by it.
	 */
	private async probeSubscriptionSupport(session: { createSubscription2: (options: Record<string, unknown>) => Promise<{ terminate: () => Promise<void> }> }): Promise<boolean> {
		try {
			const subscription = await session.createSubscription2({
				requestedPublishingInterval: 1000,
				requestedLifetimeCount: 10,
				requestedMaxKeepAliveCount: 5,
				maxNotificationsPerPublish: 10,
				publishingEnabled: true,
				priority: 10,
			});
			await subscription.terminate().catch(() => {});
			return true;
		} catch (error) {
			this.logger?.debugSync('Server does not support OPC-UA subscriptions (or the probe failed) — will use polling', {
				component: LogComponents.discovery + "] [" + this.protocol as any,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	constructor(logger?: AgentLogger, configManager?: ConfigManager) {
		super('opcua', logger);
		this.configManager = configManager;
	}

	generateFingerprint(applicationUri: string): string {
		return createHash('sha256').update(`opcua:${applicationUri}`).digest('hex').substring(0, 32);
	}

	async browseAddressSpace(request: OPCUABrowseRequest): Promise<OPCUABrowseTreeNode[]> {
		if (!request.endpointUrl || typeof request.endpointUrl !== 'string') {
			throw new Error('endpointUrl is required for OPC UA browse');
		}

		const maxDepth = Math.min(Math.max(request.maxDepth ?? 6, 1), 20);

		const { OPCUAClient, AttributeIds, MessageSecurityMode, SecurityPolicy, UserTokenType } = await import('node-opcua-client');
		const { getDefaultCertificateManager } = await import('node-opcua-certificate-manager');

		const certificateManager = getDefaultCertificateManager('PKI');
		certificateManager.automaticallyAcceptUnknownCertificate =
			(request.certificateTrustMode || 'strict') === 'trust-on-first-use';

		const client = OPCUAClient.create({
			applicationName: 'Iotistica Agent',
			applicationUri: 'urn:iotistica:agent',
			endpointMustExist: false,
			securityMode: this.resolveBrowseSecurityMode(request.securityMode, MessageSecurityMode),
			securityPolicy: this.resolveBrowseSecurityPolicy(request.securityPolicy, SecurityPolicy),
			clientCertificateManager: certificateManager,
			connectionStrategy: {
				maxRetry: 1,
				initialDelay: 100,
				maxDelay: 1000,
			},
		});

		let session: any;
		const visited = new Set<string>();

		try {
			await client.connect(request.endpointUrl);

			if (request.username && request.password) {
				session = await client.createSession({
					type: UserTokenType.UserName,
					userName: request.username,
					password: request.password,
				});
			} else {
				session = await client.createSession();
			}

			const browseRecursive = async (nodeId: string, depth: number): Promise<OPCUABrowseTreeNode[]> => {
				if (depth > maxDepth || visited.has(nodeId)) {
					return [];
				}

				visited.add(nodeId);

				const browseResult = await session.browse(nodeId);
				const references = browseResult.references || [];
				const nodes: OPCUABrowseTreeNode[] = [];

				for (const ref of references) {
					const childNodeId = ref.nodeId.toString();
					const browseName = ref.browseName?.name || childNodeId;

					const [nodeClassResult, dataTypeResult, accessLevelResult, userAccessLevelResult] = await session.read([
						{ nodeId: childNodeId, attributeId: AttributeIds.NodeClass },
						{ nodeId: childNodeId, attributeId: AttributeIds.DataType },
						{ nodeId: childNodeId, attributeId: AttributeIds.AccessLevel },
						{ nodeId: childNodeId, attributeId: AttributeIds.UserAccessLevel },
					]);

					const nodeClassValue = Number(nodeClassResult?.value?.value ?? 0);
					const accessLevel = Number(accessLevelResult?.value?.value ?? 0);
					const userAccessLevel = Number(userAccessLevelResult?.value?.value ?? accessLevel);
					const writable = nodeClassValue === 2 && (((accessLevel | userAccessLevel) & 0x02) !== 0);

					const node: OPCUABrowseTreeNode = {
						nodeId: childNodeId,
						browseName,
						nodeClass: this.mapNodeClass(nodeClassValue),
						dataType: this.mapDataTypeName(dataTypeResult?.value?.value),
						writable,
						children: [],
					};

					if (depth < maxDepth && (nodeClassValue === 1 || nodeClassValue === 8)) {
						node.children = await browseRecursive(childNodeId, depth + 1);
					}

					nodes.push(node);
				}

				return nodes;
			};

			const rootNodeId = 'ns=0;i=85';
			return await browseRecursive(rootNodeId, 0);
		} finally {
			if (session) {
				await session.close().catch(() => {});
			}
			await client.disconnect().catch(() => {});
		}
	}

	/**
   * Phase 1: Fast endpoint enumeration
   */
	async discover(options?: OPCUADiscoveryOptions): Promise<DiscoveredDevice[]> {
		const discovered: DiscoveredDevice[] = [];

		// Get discovery targets from endpoints (those with endpointUrl but no dataPoints)
		let discoveryTargets = this.configManager?.getDiscoveryTargets?.('opcua') || [];

		// Fallback: allow explicit URL probing when no DB targets exist yet.
		if (discoveryTargets.length === 0) {
			const fallbackUrls = options?.discoveryUrls && options.discoveryUrls.length > 0
				? options.discoveryUrls
				: ['opc.tcp://localhost:4840'];

			discoveryTargets = fallbackUrls.map((endpointUrl) => ({
				uuid: undefined,
				name: `opcua_${endpointUrl.replace(/[^a-zA-Z0-9]/g, '_')}`,
				protocol: 'opcua',
				connection: {
					endpointUrl,
					securityMode: options?.securityMode,
					securityPolicy: options?.securityPolicy,
					certificateTrustMode: options?.certificateTrustMode,
					username: options?.username,
					password: options?.password,
				},
				dataPoints: []
			}));

			this.logger?.debugSync('Using OPC-UA fallback discovery URLs', {
				component: LogComponents.discovery + "] [" + this.protocol as any,
				protocol: this.protocol,
				urls: fallbackUrls
			});
		}
    
		this.logger?.debugSync('OPC-UA discovery targets received', {
			component: LogComponents.discovery + "] [" + this.protocol as any,
			protocol: this.protocol,
			targetCount: discoveryTargets.length,
			targets: discoveryTargets.map((t: any) => ({
				uuid: t.uuid,
				name: t.name,
				protocol: t.protocol,
				connection: t.connection,
				dataPointsCount: t.dataPoints?.length || 0
			}))
		});
		
		if (discoveryTargets.length === 0) {
			this.logger?.debugSync('No OPC-UA discovery targets configured (need endpointUrl without dataPoints)', {
				component: LogComponents.discovery + "] [" + this.protocol as any,
				protocol: this.protocol
			});
			return [];
		}

		this.logger?.debugSync(`Starting OPC-UA discovery (${discoveryTargets.length} targets)`, {
			component: LogComponents.discovery + "] [" + this.protocol as any,
			protocol: this.protocol,
			phase: 'discovery',
			targetCount: discoveryTargets.length
		});

		for (const endpoint of discoveryTargets) {
			const url = endpoint.connection?.endpointUrl;
			if (!url) continue;

			try {
				const { OPCUAClient, AttributeIds, MessageSecurityMode, SecurityPolicy, UserTokenType } = await import('node-opcua-client');
				const { getDefaultCertificateManager } = await import('node-opcua-certificate-manager');
				const certificateManager = getDefaultCertificateManager('PKI');
				certificateManager.automaticallyAcceptUnknownCertificate =
					endpoint.connection?.certificateTrustMode === 'trust-on-first-use';

				const client = OPCUAClient.create({
					applicationName: 'Iotistica Agent',
					applicationUri: 'urn:iotistica:agent',
					endpointMustExist : false,
					securityMode: this.resolveBrowseSecurityMode(endpoint.connection?.securityMode, MessageSecurityMode),
					securityPolicy: this.resolveBrowseSecurityPolicy(endpoint.connection?.securityPolicy, SecurityPolicy),
					clientCertificateManager: certificateManager,
					connectionStrategy: {
						maxRetry: 1,
						initialDelay: 100,
						maxDelay: 1000
					}
				});

				await client.connect(url);
				const endpoints = await client.getEndpoints();

				// Create session to browse the node tree
				const session = endpoint.connection?.username && endpoint.connection?.password
					? await client.createSession({
						type: UserTokenType.UserName,
						userName: endpoint.connection.username,
						password: endpoint.connection.password,
					})
					: await client.createSession();
				const dataPoints: Array<{ nodeId: string; name: string; browseName?: string; device_uuid?: string; device_name?: string; writable?: boolean; unit?: string }> = [];
				let subscriptionsSupported = false;

				try {
					// Recursive tree browsing function
					const browseRecursive = async (
						nodeId: string,
						pathSegments: string[] = [],
						depth: number = 0,
						maxDepth: number = 10,
						inheritedDeviceUuid?: string,  // UUID from parent folder's DeviceUUID node
						inheritedDeviceName?: string   // Friendly name of the folder that owns that DeviceUUID node
					): Promise<void> => {
						// Protection against infinite loops
						if (depth > maxDepth) {
							this.logger?.warnSync(`Max depth ${maxDepth} reached, stopping recursion`, {
								component: LogComponents.discovery + "] [" + this.protocol as any,
								path: pathSegments.join('/')
							});
							return;
						}
						
						try {
							const browseResult = await session.browse(nodeId);
							const refs = browseResult.references || [];

							// Pre-scan: look for a DeviceUUID variable in this folder to stamp on siblings
							let folderDeviceUuid: string | undefined = inheritedDeviceUuid;
							// The folder that directly owns the DeviceUUID marker IS the device —
							// its own browseName (last segment of pathSegments, e.g. "FCU-11A") is
							// the human-friendly name the device actually reports, as opposed to
							// the technical endpoint-name+uuid-suffix fallback device.model.ts
							// otherwise has to construct.
							let folderDeviceName: string | undefined = inheritedDeviceName;
							for (const ref of refs) {
								if (ref.browseName?.name === 'DeviceUUID') {
									try {
										const val = await session.read({
											nodeId: ref.nodeId.toString(),
											attributeId: 13 // Value attribute
										});
										if (val.value?.value && typeof val.value.value === 'string') {
											folderDeviceUuid = val.value.value;
											folderDeviceName = pathSegments[pathSegments.length - 1] || folderDeviceName;
										}
									} catch (_) { /* ignore read errors */ }
									break;
								}
							}

							// Reads the OPC-UA standard EngineeringUnits property (Part 8) — a
							// child Property node (browseName "EngineeringUnits") of an
							// AnalogItemType Variable, holding an EUInformation struct whose
							// displayName.text is the actual unit string (e.g. "°C"). Only
							// analog-style variables expose this at all, so a miss is the
							// common case, not an error — best-effort like the DeviceUUID
							// pre-scan above, silently returning undefined on any failure.
							const readEngineeringUnits = async (variableNodeId: string): Promise<string | undefined> => {
								try {
									const propBrowse = await session.browse(variableNodeId);
									const euRef = (propBrowse.references || []).find(
										(r: any) => r.browseName?.name === 'EngineeringUnits'
									);
									if (!euRef) return undefined;

									const euValue = await session.read({
										nodeId: euRef.nodeId.toString(),
										attributeId: AttributeIds.Value,
									});
									const euInfo = euValue.value?.value as { displayName?: { text?: string } } | string | undefined;
									if (typeof euInfo === 'string') {
										const trimmed = euInfo.trim();
										return trimmed || undefined;
									}
									const text = euInfo?.displayName?.text;
									return typeof text === 'string' && text.trim() ? text.trim() : undefined;
								} catch (_) {
									return undefined;
								}
							};

							for (const ref of refs) {
								const nodeName = ref.browseName?.name || '';
								const childNodeId = ref.nodeId.toString();
								const currentPath = [...pathSegments, nodeName];
								
								// Skip standard OPC UA system folders at root level (IEC 62541)
								// ServerInfo contains metadata like ProfileName, deviceCount which pollute data_points
								if (depth === 0 && ['Server', 'ServerInfo', 'Types', 'Views', 'Aliases'].includes(nodeName)) {
									continue;
								}

								// Skip the DeviceUUID node itself — it's metadata, not a device reading
								if (nodeName === 'DeviceUUID') {
									continue;
								}
								
								// NodeClass: 1 = Object/Folder, 2 = Variable
								// Verify the actual NodeClass by reading node attributes. Also read
								// AccessLevel/UserAccessLevel here (same attributes browseOPCUATree()
								// uses to compute `writable`) — this recursive scan is what periodically
								// overwrites the endpoint's persisted data_points wholesale on rediscovery
								// (see DiscoveryStore.save()), so if it doesn't report writable itself,
								// any previously-known writable flag silently disappears on every rescan.
								try {
									const [nodeClass, accessLevelResult, userAccessLevelResult, descriptionResult] = await session.read([
										{ nodeId: childNodeId, attributeId: AttributeIds.NodeClass },
										{ nodeId: childNodeId, attributeId: AttributeIds.AccessLevel },
										{ nodeId: childNodeId, attributeId: AttributeIds.UserAccessLevel },
										{ nodeId: childNodeId, attributeId: AttributeIds.Description },
									]);

									const actualNodeClass = nodeClass.value.value;

									if (actualNodeClass === 2) {
										// Extract semantic metric name from browseName prefix (OPC UA standard)
										// Format: "Temperature_device1" → metric: "temperature"
										// If no underscore, use full browseName in lowercase
										const metricName = nodeName.includes('_')
											? nodeName.split('_')[0].toLowerCase()
											: nodeName.toLowerCase();

										const accessLevel = Number(accessLevelResult?.value?.value ?? 0);
										const userAccessLevel = Number(userAccessLevelResult?.value?.value ?? accessLevel);
										const writable = ((accessLevel | userAccessLevel) & 0x02) !== 0;
										// Prefer the real EngineeringUnits property (compliant AnalogItemType
										// servers); fall back to the Description attribute — some lightweight
										// OPC-UA servers/simulators stash the unit string there instead of
										// implementing the full EngineeringUnits/EUInformation structure.
										const descriptionText = (descriptionResult?.value?.value as { text?: string } | undefined)?.text;
										const unit = (await readEngineeringUnits(childNodeId))
											?? (typeof descriptionText === 'string' && descriptionText.trim() ? descriptionText.trim() : undefined);

										dataPoints.push({
											nodeId: childNodeId,
											name: metricName,
											// Raw OPC-UA browseName as reported by the server (e.g. "SpaceTemp_device1").
											// `name` above is lowercased and truncated to the pre-underscore prefix for
											// use as the metric tag — preserved separately here for accurate display.
											browseName: nodeName,
											writable,
											...(folderDeviceUuid && { device_uuid: folderDeviceUuid }),
											...(folderDeviceName && { device_name: folderDeviceName }),
											...(unit && { unit }),
										});
										
										this.logger?.debugSync(`Discovered variable: ${currentPath.join('/')}`, {
											component: LogComponents.discovery + "] [" + this.protocol as any,
											nodeId: childNodeId,
											browseName: nodeName,
											metricName,
											depth,
											...(folderDeviceUuid && { device_uuid: folderDeviceUuid }),
										});
									} else if (actualNodeClass === 1) {
										// Verified folder - recurse into it, propagating any UUID/name found
										this.logger?.debugSync(`Browsing into folder: ${currentPath.join('/')}`, {
											component: LogComponents.discovery + "] [" + this.protocol as any,
											nodeId: childNodeId,
											depth
										});

										await browseRecursive(childNodeId, currentPath, depth + 1, maxDepth, folderDeviceUuid, folderDeviceName);
									}
								} catch (readError) {
									// If we can't read NodeClass, skip this node
									this.logger?.debugSync(`Skipping node (cannot read NodeClass): ${currentPath.join('/')}`, {
										component: LogComponents.discovery + "] [" + this.protocol as any,
										nodeId: childNodeId,
										error: readError instanceof Error ? readError.message : String(readError)
									});
								}
							}
						} catch (browseError) {
							this.logger?.debugSync(`Failed to browse node: ${pathSegments.join('/')}`, {
								component: LogComponents.discovery + "] [" + this.protocol as any,
								error: browseError instanceof Error ? browseError.message : String(browseError),
								depth
							});
						}
					};
					
					// Start recursive browsing from Objects folder
					const ObjectsNodeId = 'ns=0;i=85'; // Standard Objects folder
					await browseRecursive(ObjectsNodeId, [], 0);
				} catch (browseError) {
					this.logger?.warnSync('Failed to browse OPC UA tree recursively, using default node', {
						component: LogComponents.discovery + "] [" + this.protocol as any,
						error: browseError instanceof Error ? browseError.message : String(browseError)
					});
					
					// Fallback to example node if browsing fails
					if (dataPoints.length === 0) {
						dataPoints.push({
							nodeId: 'ns=2;s=MyVariable',
							name: 'example_node'
						});
					}
				} finally {
					// Probe subscription support while the session is still open, before
					// closing it — a server that doesn't implement the Subscribe service
					// (or has hit a subscription/session limit) rejects CreateSubscription
					// outright, which is a much more reliable signal than any capability
					// string in GetEndpoints/ServerCapabilities (those describe conformance
					// profiles, not concrete per-service support, and vendors are
					// inconsistent about keeping them accurate).
					subscriptionsSupported = await this.probeSubscriptionSupport(session);
					await session.close();
				}

				this.logger?.debugSync(`OPC UA recursive tree browsing complete: discovered ${dataPoints.length} nodes`, {
					component: LogComponents.discovery + "] [" + this.protocol as any,
					url,
					dataPointCount: dataPoints.length
				});
				
				// Log sample of discovered nodes for verification
				if (dataPoints.length > 0) {
					this.logger?.debugSync(`OPC UA nodes discovered and ready to save`, {
						component: LogComponents.discovery + "] [" + this.protocol as any,
						endpointUrl: url,
						totalNodes: dataPoints.length,
						sampleNodes: dataPoints.slice(0, 5).map(dp => ({
							nodeId: dp.nodeId,
							name: dp.name
						}))
					});
				}
				
				await client.disconnect();

				if (endpoints.length > 0) {
					const preferredEndpoint = this.selectPreferredEndpoint(endpoints) || endpoints[0];
					
					// Extract ApplicationUri from endpoint (most stable OPC-UA identifier)
					const applicationUri = preferredEndpoint.server?.applicationUri || `urn:${new URL(url).hostname}:unknown`;
					
					// Generate cryptographic fingerprint
					const fingerprint = this.generateFingerprint(applicationUri);
					
					const certThumbprint = this.calculateThumbprint(preferredEndpoint.serverCertificate);
					const selectedSecurityMode = this.mapSecurityMode(preferredEndpoint.securityMode);
					const selectedSecurityPolicy = this.mapSecurityPolicy(preferredEndpoint.securityPolicyUri);

					discovered.push({
						name: `opcua_${new URL(url).hostname}_${new URL(url).port}`,
						protocol: 'opcua' as const,
						fingerprint,
						connection: {
							endpointUrl: url,
							securityMode: selectedSecurityMode,
							securityPolicy: selectedSecurityPolicy,
							// Was hardcoded 'strict' regardless of what this discovery run was
							// actually configured with — meaning the browse itself could succeed
							// (using endpoint.connection?.certificateTrustMode further up, from
							// the rule's own options) while the SAVED device connection silently
							// reverted to 'strict', breaking every subsequent connection attempt
							// (the live polling client, any future rediscovery) against a
							// self-signed server cert with BadCertificateUntrusted. Carry forward
							// whatever this discovery run was actually configured with instead.
							certificateTrustMode: endpoint.connection?.certificateTrustMode || 'strict',
							// Probed live against this server during discovery (see
							// probeSubscriptionSupport) rather than left to the schema
							// default — a server that can't actually create a subscription
							// gets saved as polling-only up front, instead of discovering
							// that the hard way on every connection attempt afterward.
							useSubscription: subscriptionsSupported,
							...(endpoint.connection?.username && { username: endpoint.connection.username }),
							...(endpoint.connection?.password && { password: endpoint.connection.password }),
							...(certThumbprint ? { expectedServerThumbprint: certThumbprint } : {})
						},
						dataPoints: dataPoints.length > 0 ? dataPoints : [{
							nodeId: 'ns=2;s=MyVariable',
							name: 'example_node'
						}],
						confidence: 'medium',
						discoveredAt: new Date().toISOString(),
						validated: false,
						metadata: {
							endpointUrl: url,
							applicationUri,
							availableEndpoints: endpoints.length,
							serverCertificateThumbprint: certThumbprint,
							selectedSecurityMode,
							selectedSecurityPolicy,
							discoveryMethod: 'endpoint_discovery'
						}
					});

					this.logger?.debugSync(`Discovered OPC-UA endpoint at ${url}`, {
						component: LogComponents.discovery + "] [" + this.protocol as any,
						endpoints: endpoints.length,
						phase: 'discovery'
					});
				}
			} catch (_error) {
				this.logger?.debugSync(`No OPC-UA server at ${url}`, {
					component: LogComponents.discovery + "] [" + this.protocol as any
				});
			}
		}

		return discovered;
	}
	/**
   * Phase 2: Validate server (read ServerInfo)
   */
	async validate(device: DiscoveredDevice, _timeout = 5000): Promise<any> {
		this.logger?.debugSync('Validating OPC-UA server', {
			component: LogComponents.discovery + "] [" + this.protocol as any,
			endpoint: device.connection.endpointUrl,
			phase: 'validation'
		});

		// TODO: Implement OPC-UA server validation
		// - Read Server_ServerStatus node
		// - Read Server_ServerArray
		// - Read manufacturer info from namespace 0
    
		return null; // Placeholder
	}

	/**
   * Check if OPC-UA client is available
   */
	async isAvailable(): Promise<boolean> {
		try {
			await import('node-opcua-client');
			return true;
		} catch {
			return false;
		}
	}
}

