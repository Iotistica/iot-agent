/** Discovery persistence store for endpoints and staleness checks. */
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';
import { EndpointModel, type Endpoint } from '../db/models/endpoint.model.js';
import { ProtocolDevicesModel } from '../db/models/index.js';
import type { DiscoveredDevice } from '../plugins/types.js';
import type { ConfigManager } from '../core/config.js';

// A device must be absent from this many *consecutive* prune-eligible scans before
// its endpoint is disabled. Protects against a single corrupted/dropped discovery
// response (e.g. a misattributed BACnet I-Am under heavy broadcast load) evicting a
// still-valid endpoint out from under a device that's actually still there.
const PRUNE_MISS_THRESHOLD = 2;

export class DiscoveryStore {
	constructor(
    private logger?: AgentLogger,
    private configManager?: ConfigManager,
    private emit: (event: string, ...args: any[]) => void = () => {}
	) {}

	async save(
		discovered: DiscoveredDevice[],
		traceId: string,
		updateOnly: boolean = false,
		// When set, endpoints of these protocols that existed before this run but
		// weren't matched by any discovered device get disabled (soft — mirrors the
		// cloud API's deleteEndpoint, not hardDeleteEndpoint). dryRun reports what
		// would be pruned without writing, so a caller can preview before committing.
		prune?: { protocols: string[]; dryRun?: boolean },
		// Default `enabled` state for newly-created endpoints (a discovery rule's
		// "auto-enable found endpoints" setting) — independent of updateOnly, which
		// controls whether new endpoints get created at all. A pre-existing target
		// endpoint's own explicit `enabled` value (below) still takes priority.
		autoEnableNew: boolean = false
	): Promise<{ saved: number; skipped: number; pruned: number; prunedDevices?: Array<{ name: string; protocol: string }> }> {
		if (discovered.length === 0 && !prune) {
			this.logger?.debugSync('No discovered endpoints to save', {
				component: LogComponents.discovery,
				traceId
			});
			return { saved: 0, skipped: 0, pruned: 0 };
		}

		if (updateOnly) {
			this.logger?.debugSync('Discovery running in update-only mode', {
				component: LogComponents.discovery,
				traceId,
				discoveredCount: discovered.length,
				mode: 'update-existing-only'
			});
		}

		const existingEndpoints = await EndpointModel.getAll();

		const targetEndpoints = this.configManager?.getTargetConfig().endpoints || [];
		const targetEndpointByName = new Map(
			targetEndpoints.map((endpoint: any) => [endpoint.name, endpoint])
		);


		let saved = 0;
		let skipped = 0;
		const savedDevices: Array<{ name: string; protocol: string; confidence: string }> = [];
		const skippedDevices: Array<{ name: string; protocol: string; reason: string }> = [];
		// Every existing endpoint matched to a discovered device this run — the
		// complement of this set (within the pruned protocols) is what gets disabled.
		const matchedEndpointIds = new Set<number>();

		for (const device of discovered) {
			try {

				const existingByFingerprint = existingEndpoints.find(s =>
					s.metadata?.fingerprint === device.fingerprint
				);
				const existingByName = existingEndpoints.find(s =>
					s.name === device.name
				);
				const existingByEndpointUrl = device.protocol === 'opcua'
					? existingEndpoints.find(s =>
						s.protocol === 'opcua' &&
              s.connection?.endpointUrl === device.connection?.endpointUrl
					)
					: undefined;

				const existing = existingByFingerprint || existingByName || existingByEndpointUrl;
				if (existing?.id !== undefined) {
					matchedEndpointIds.add(existing.id);
				}

				if (existing) {
					const matchType = existingByFingerprint ? 'fingerprint' :
						existingByName ? 'name' :
							existingByEndpointUrl ? 'endpointUrl' : 'unknown';
					if (matchType === 'endpointUrl') {
						this.logger?.infoSync('Matched discovered device to existing by endpointUrl', {
							component: LogComponents.discovery,
							traceId,
							existingName: existing.name,
							discoveredName: device.name,
							endpointUrl: device.connection?.endpointUrl,
							willUpdate: true
						});
					}

					const deviceConnectionKeys = Object.keys(device.connection || {});
					const existingConnectionSubset = Object.fromEntries(
						deviceConnectionKeys.map((k) => [k, (existing.connection as any)?.[k]])
					);
					const configChanged = JSON.stringify(existingConnectionSubset) !== JSON.stringify(device.connection);
					const fingerprintChanged = existing.metadata?.fingerprint !== device.fingerprint;
					const existingProfile = existing.metadata?.profile || 'Generic';
					const newProfile = device.metadata?.profile || 'Generic';
					const profileChanged = existingProfile !== newProfile;
					// Don't overwrite existing populated data_points with an empty validation result
					const wouldClearDataPoints = (existing.data_points?.length ?? 0) > 0 && (device.dataPoints?.length ?? 0) === 0;
					const dataPointsChanged = !wouldClearDataPoints && JSON.stringify(existing.data_points) !== JSON.stringify(device.dataPoints);
					const validationChanged = device.validated && !existing.metadata?.validated;
					// One-way ratchet: a rule with auto_enable on turns an already-known
					// device on if it wasn't already — a rule WITHOUT auto_enable never
					// forces it back off. Applies on every run this device is matched, not
					// just at first discovery — otherwise "auto-enable" only ever took
					// effect once, and a device created before this option existed (or
					// before it was turned on) would stay disabled forever regardless of
					// the rule's current setting.
					const shouldRatchetEnable = autoEnableNew && !existing.enabled;

					this.logger?.debugSync(`Configuration comparison for "${device.name}"`, {
						component: LogComponents.discovery,
						traceId,
						configChanged: profileChanged || dataPointsChanged || validationChanged,
						dataPointsCount: device.dataPoints?.length || 0,
						dataPointsChanged,
						validationChanged
					});

					if (profileChanged || dataPointsChanged || validationChanged) {
						const reason = profileChanged ? 'Profile changed' : 'Data points changed (same profile)';

						this.logger?.infoSync('Updating device with discovered nodes', {
							component: LogComponents.discovery,
							traceId,
							deviceName: existing.name,
							protocol: device.protocol,
							reason,
							dataPointsCount: device.dataPoints?.length || 0,
							sampleNodes: device.dataPoints?.slice(0, 3).map(dp => ({
								nodeId: dp.nodeId,
								name: dp.name || dp.address
							}))
						});

						await EndpointModel.update(existing.name, {
							data_points: device.dataPoints || [],
							// Merge fresh discovery-derived connection fields (security mode/
							// policy/trust mode/credentials — this rule's discovery run is
							// authoritative for these) on top of the existing connection,
							// preserving any other manually-set fields (connectionTimeout etc.)
							// discovery doesn't know about. Without this, a device discovered
							// once with a broken/stale connection (e.g. wrong certificateTrustMode)
							// stays broken forever — this "already exists" branch previously
							// never touched `connection` at all, so re-running discovery could
							// never actually fix it.
							connection: { ...existing.connection, ...device.connection },
							enabled: shouldRatchetEnable ? true : existing.enabled,
							metadata: {
								...existing.metadata,
								...device.metadata,
								confidence: device.confidence,
								validated: device.validated,
								dataPointValidation: undefined
							},
							lastSeenAt: new Date()
						});

						this.logger?.infoSync('Database update complete', {
							component: LogComponents.discovery,
							traceId,
							deviceName: existing.name,
							updatedDataPoints: device.dataPoints?.length || 0,
							operation: 'DeviceEndpointModel.update'
						});

						if (shouldRatchetEnable) {
							this.logger?.infoSync(`Device "${existing.name}" auto-enabled by discovery rule`, {
								component: LogComponents.discovery,
								traceId,
								protocol: device.protocol
							});
						}

						const updatedDevice = await EndpointModel.getByName(existing.name);
						if (updatedDevice) {
							await ProtocolDevicesModel.syncFromEndpoint(updatedDevice);
							this.logger?.infoSync('Verified data persisted to database', {
								component: LogComponents.discovery,
								traceId,
								deviceName: existing.name,
								persistedDataPoints: updatedDevice.data_points?.length || 0,
								samplePersistedNodes: updatedDevice.data_points?.slice(0, 3).map(dp => ({
									nodeId: dp.nodeId,
									name: dp.name || dp.address
								}))
							});
						} else {
							this.logger?.errorSync(
								'Failed to verify database update - device not found',
								new Error('Device not found after update'),
								{ component: LogComponents.discovery, traceId, deviceName: existing.name }
							);
						}

						// existing.enabled is the pre-update value — shouldRatchetEnable means
						// we just flipped it to true in the write above, so check the
						// resulting state, not the stale one, or a freshly auto-enabled
						// device's adapter never gets told to actually start polling it.
						if (existing.enabled || shouldRatchetEnable) {
							this.emit('endpoint-enabled', {
								protocol: device.protocol,
								endpoint: {
									...existing,
									enabled: true,
									data_points: device.dataPoints || [],
									metadata: { ...existing.metadata, profile: device.metadata?.profile }
								},
								isBatchDiscovery: !!traceId,
								profileChanged: true
							});
						}

						saved++;
						savedDevices.push({
							name: existing.name,
							protocol: device.protocol,
							confidence: device.confidence || 'updated'
						});
						continue;

					} else {
						if (configChanged || shouldRatchetEnable) {
							// Actually persist the merged connection — this branch previously
							// only logged oldConnection/newConnection for debugging and bumped
							// lastSeenAt, never writing the change. That meant a device whose
							// data/profile hadn't changed but whose connection HAD (e.g. fixing
							// certificateTrustMode/credentials on a discovery rule) could never
							// be corrected by re-running discovery, no matter how many times.
							// Safe to merge unconditionally here: `existing` was matched by
							// fingerprint/name/endpointUrl above, so this is confirmed to be the
							// same server — even an endpointUrl change reflects that server
							// genuinely being found at a new address, which is exactly what
							// should be persisted.
							await EndpointModel.update(existing.name, {
								connection: { ...existing.connection, ...device.connection },
								enabled: shouldRatchetEnable ? true : existing.enabled,
								lastSeenAt: new Date()
							});
							if (configChanged) {
								this.logger?.debugSync(`Device "${device.name}" moved/reconfigured — connection updated`, {
									component: LogComponents.discovery,
									traceId,
									oldConnection: existing.connection,
									newConnection: device.connection
								});
							}
							if (shouldRatchetEnable) {
								this.logger?.infoSync(`Device "${device.name}" auto-enabled by discovery rule`, {
									component: LogComponents.discovery,
									traceId,
									protocol: device.protocol
								});
								// Same reload-trigger this branch's sibling above already does on
								// enable — without it, an adapter restart would be the only way to
								// pick up a device auto-enabled via this "connection changed"/
								// "unchanged" path specifically (see init/adapters.ts's listener).
								this.emit('endpoint-enabled', {
									protocol: device.protocol,
									endpoint: {
										...existing,
										enabled: true,
										connection: { ...existing.connection, ...device.connection },
										data_points: device.dataPoints || existing.data_points
									},
									isBatchDiscovery: !!traceId
								});
							}
						} else {
							await EndpointModel.updateLastSeen(device.fingerprint);
						}

						if (fingerprintChanged) {
							this.logger?.debugSync(`Device "${device.name}" fingerprint changed (dynamic data)`, {
								component: LogComponents.discovery,
								traceId,
								oldFingerprint: existing.metadata?.fingerprint,
								newFingerprint: device.fingerprint
							});
						} else {
							this.logger?.debugSync(`Device "${device.name}" already known - skipping`, {
								component: LogComponents.discovery,
								traceId,
								protocol: device.protocol,
								lastSeen: existing.lastSeenAt
							});
						}
						skipped++;
						skippedDevices.push({
							name: device.name,
							protocol: device.protocol,
							reason: configChanged ? 'moved' : (fingerprintChanged ? 'fingerprint_changed' : 'already_exists')
						});
						continue;
					}
				}

				if (updateOnly) {
					this.logger?.debugSync('Skipping new device creation (update-only mode)', {
						component: LogComponents.discovery,
						traceId,
						deviceName: device.name,
						protocol: device.protocol,
						endpointUrl: device.connection?.endpointUrl,
						reason: 'reconcile-creates-records'
					});
					skipped++;
					skippedDevices.push({ name: device.name, protocol: device.protocol, reason: 'update_only_mode' });
					continue;
				}

				let endpointEnabled = autoEnableNew;
				const targetEndpoint = device.metadata?.connectionName
					? targetEndpointByName.get(device.metadata.connectionName)
					: targetEndpointByName.get(device.name);

				if (targetEndpoint?.enabled !== undefined) {
					endpointEnabled = Boolean(targetEndpoint.enabled);
				} else if (device.metadata?.connectionName && this.configManager) {
					const modbusConfig = this.configManager.getModbusConfig();
					const parentConn = modbusConfig.connections?.find(
						(c: any) => c.name === device.metadata?.connectionName
					);
					endpointEnabled = parentConn?.enabled ?? false;
				}

				const endpoint: Endpoint = {
					name: device.name,
					protocol: device.protocol as 'modbus' | 'can' | 'opcua' | 'mqtt',
					enabled: endpointEnabled,
					poll_interval: 5000,
					connection: device.connection,
					data_points: device.dataPoints || [],
					lastSeenAt: new Date(),
					metadata: {
						...device.metadata,
						fingerprint: device.fingerprint,
						confidence: device.confidence,
						validated: device.validated,
						discoveredAt: device.discoveredAt,
						...(targetEndpoint?.id && { discoveryParentId: targetEndpoint.id }),
						...(device.validationData && {
							manufacturer: device.validationData.manufacturer,
							modelNumber: device.validationData.modelNumber,
							firmwareVersion: device.validationData.firmwareVersion,
							capabilities: device.validationData.capabilities,
							deviceInfo: device.validationData.deviceInfo,
							dataPointValidation: device.validationData.dataPointValidation
						})
					}
				};

				if (targetEndpoint?.id) {
					this.logger?.infoSync('Discovered device linked to parent', {
						component: LogComponents.discovery,
						traceId,
						deviceName: device.name,
						parentId: targetEndpoint.id,
						parentName: targetEndpoint.name,
						connectionName: device.metadata?.connectionName
					});
				} else {
					this.logger?.warnSync('Discovered device has no parent tracking - parent endpoint not found', {
						component: LogComponents.discovery,
						traceId,
						deviceName: device.name,
						protocol: device.protocol,
						connectionName: device.metadata?.connectionName,
						availableTargetEndpoints: Array.from(targetEndpointByName.entries()).map(([name, ep]: [string, any]) => ({
							name,
							id: ep?.id,
							protocol: ep?.protocol
						}))
					});
				}

				const createdEndpoint = await EndpointModel.create(endpoint);
				await ProtocolDevicesModel.syncFromEndpoint(createdEndpoint);
				saved++;
				savedDevices.push({
					name: device.name,
					protocol: device.protocol,
					confidence: device.confidence || 'unknown'
				});

				if (endpoint.enabled) {
					this.emit('endpoint-enabled', {
						protocol: device.protocol,
						endpoint: endpoint,
						isBatchDiscovery: !!traceId
					});
				}
			} catch (error) {
				this.logger?.errorSync(
					`Failed to save device "${device.name}"`,
          error as Error,
          { component: LogComponents.discovery, traceId }
				);
			}
		}

		this.logger?.debugSync(
			`Discovery complete: ${saved} new, ${skipped} existing`,
			{
				component: LogComponents.discovery,
				traceId,
				saved: savedDevices.length > 0 ? savedDevices : undefined,
				skipped: skippedDevices.length > 0 ? skippedDevices : undefined,
			}
		);

		let pruned = 0;
		let prunedDevices: Array<{ name: string; protocol: string }> | undefined;

		if (prune && prune.protocols.length > 0) {
			const candidateEndpoints = existingEndpoints.filter((e) =>
				e.id !== undefined &&
        e.enabled &&
        prune.protocols.includes(e.protocol)
			);

			const staleEndpoints: Endpoint[] = [];

			for (const endpoint of candidateEndpoints) {
				const matched = endpoint.id !== undefined && matchedEndpointIds.has(endpoint.id);
				const missCount = endpoint.metadata?.pruneMissCount ?? 0;

				if (matched) {
					if (missCount > 0 && !prune.dryRun) {
						await EndpointModel.update(endpoint.name, {
							metadata: { ...endpoint.metadata, pruneMissCount: 0 }
						});
					}
					continue;
				}

				const nextMissCount = missCount + 1;
				if (nextMissCount < PRUNE_MISS_THRESHOLD) {
					if (!prune.dryRun) {
						await EndpointModel.update(endpoint.name, {
							metadata: { ...endpoint.metadata, pruneMissCount: nextMissCount }
						});
					}
					this.logger?.debugSync(
						`Endpoint "${endpoint.name}" not seen this scan (${nextMissCount}/${PRUNE_MISS_THRESHOLD}) - deferring prune`,
						{ component: LogComponents.discovery, traceId, protocol: endpoint.protocol }
					);
					continue;
				}

				staleEndpoints.push(endpoint);
			}

			if (staleEndpoints.length > 0) {
				prunedDevices = staleEndpoints.map((e) => ({ name: e.name, protocol: e.protocol }));

				if (prune.dryRun) {
					this.logger?.infoSync(
						`Prune dry run: ${staleEndpoints.length} endpoint(s) would be disabled (not seen in this scan)`,
						{ component: LogComponents.discovery, traceId, protocols: prune.protocols, devices: prunedDevices }
					);
				} else {
					for (const endpoint of staleEndpoints) {
						try {
							await EndpointModel.update(endpoint.name, {
								enabled: false,
								metadata: { ...endpoint.metadata, pruneMissCount: 0 }
							});
							this.emit('endpoint-disabled', { protocol: endpoint.protocol, endpoint, reason: 'prune' });
						} catch (error) {
							this.logger?.errorSync(
								`Failed to prune endpoint "${endpoint.name}"`,
								error as Error,
								{ component: LogComponents.discovery, traceId }
							);
							continue;
						}
					}
					this.logger?.warnSync(
						`Pruned ${staleEndpoints.length} endpoint(s) not seen in this scan`,
						{ component: LogComponents.discovery, traceId, protocols: prune.protocols, devices: prunedDevices }
					);
				}
			}

			pruned = staleEndpoints.length;
		}

		await this.checkStale(traceId);

		return { saved, skipped, pruned, prunedDevices };
	}

	async checkStale(traceId: string, daysThreshold = 7): Promise<void> {
		try {
			const staleDevices = await EndpointModel.getStaleDevices(daysThreshold);
			if (staleDevices.length > 0) {
				this.logger?.warnSync(
					`Found ${staleDevices.length} stale devices (not seen in ${daysThreshold}+ days)`,
					{
						component: LogComponents.discovery,
						traceId,
						staleCount: staleDevices.length,
						devices: staleDevices.map(d => ({
							name: d.name,
							protocol: d.protocol,
							lastSeenAt: d.lastSeenAt,
							fingerprint: d.metadata?.fingerprint
						}))
					}
				);
			}
		} catch (error) {
			this.logger?.debugSync('Failed to check stale devices', {
				component: LogComponents.discovery,
				traceId,
				error: (error as Error).message
			});
		}
	}
}
