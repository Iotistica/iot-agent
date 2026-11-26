# Graph Report - iot-agent  (2026-11-26)

## Corpus Check
- 739 files · ~729,189 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 21 file(s) not represented in the graph (top: (none) 11, .tmp-shm 2, .tmp-wal 2)

## Summary
- 9753 nodes · 22759 edges · 337 communities (264 shown, 73 thin omitted)
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 1765 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `0bb65f2f`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- AgentLogger
- publish/core/types.ts
- actions.ts
- PublishManager
- AnomalyView.vue
- AppLayout.vue
- ContainersView.vue
- AssetsView.vue
- SettingsView.vue
- device-resolution-store.ts
- CloudSync
- commands-e2e.integration.spec.ts
- BACnetAdapter
- ModbusClient
- plugins/index.ts
- discovery/db.ts
- DiscoveryRulesView.vue
- core/index.ts
- collection-utils.ts
- DataExplorer.vue
- .warnSync
- OPCUADeviceClient
- ConfigManager
- codec.ts
- EndpointModel
- SchemaDriftDetector
- DictionaryManager
- logging/types.ts
- plugins/index.ts
- DestinationsView.vue
- LogsView.vue
- detectors.ts
- points/catalog.ts
- DriftRuleDrawer.vue
- .infoSync
- PointPickerModal.vue
- MessageBufferModel
- SubscriptionDrawer.vue
- fixtures.ts
- types/index.ts
- CloudLogBackend
- OPCUAAdapter
- CloudMqttClient
- SchemaDriftModel
- container-manager.ts
- Agent
- core/manager.ts
- AlertsView.vue
- runtime.ts
- lib/errors.ts
- SourcesView.vue
- package.json
- CreateViewDrawer.vue
- maintenance/service.ts
- .warn
- ContainerManager
- models/index.ts
- UsersView.vue
- MaintenanceRuleDrawer.vue
- CloudSync
- DashboardView.vue
- DiscoveryDrawer.vue
- CreateDatasetDrawer.vue
- steps
- DeviceDrawer.vue
- docker-manager.ts
- quality/index.ts
- containers/types.ts
- PrivateEvidenceRegistry
- buildCommands
- publish/src/lib.rs
- timescaledb.ts
- sqlite.ts
- anomaly/types.ts
- BaseHttpClient
- memory.ts
- configured-point-resolver.ts
- system/metrics.ts
- agent.model.ts
- credentials.ts
- data-explorer-point-key.ts
- MarketplaceCatalog.vue
- opcua/src/lib.rs
- src/core.ts
- publish/core/types.ts
- MqttAdapter
- OfflineQueue
- AnomalyDetectionService
- anomaly/service.ts
- MessageViewer.vue
- CaptureTab.vue
- containers.ts
- backup.ts
- SourcePointsPanel.vue
- PointsTable.vue
- ipc/src/lib.rs
- point-identity-catalog.ts
- BackupsView.vue
- startWatchdog
- MqttBrokerView.vue
- BaseOrchestratorDriver
- StateReporter
- infra.ts
- .discover
- cli/package.json
- compress.ts
- with
- units/catalog.ts
- mqtt/auth.ts
- ModbusAdapter
- JobsFeature
- units/index.ts
- AnomalyStorageService
- scripts
- lib/http-client.ts
- RetryManager
- DecodedPacket
- init/agent.ts
- ActivityMonitor
- NetworkView.vue
- express
- DiscoveryRuleModel
- BaseFeature
- SourceDrawer.vue
- configured-points.ts
- steps
- TcpAssembler
- OpcUaReader
- forecaster.ts
- MqttUsersTab.vue
- CaptureEngine
- pipeline.service.ts
- DevicePublish
- iotctl.ts
- compilerOptions
- with
- dependencies
- SocketServer
- jobs/types.ts
- opcua-shadow-evidence.unit.spec.ts
- DiscoveryService
- BaseMqttClient
- normalizeSourceSystem
- compilerOptions
- useSystemStats.ts
- compilerOptions
- agent
- steps
- DeviceDrawer.vue
- MessageBatcher
- opcua/discovery.ts
- AgentFirewall
- FeatureInitializer
- TerminalView.vue
- canonical-address.ts
- buildCommands
- build-agent-ci.yml
- asset.model.ts
- src/api/network.ts
- native-migrations.ts
- BrokerMonitorService
- Publish Pipeline Architecture
- JobsFeature
- SocketConnection
- Phase 2C-3: Trusted Protocol Evidence Integration Design
- getDatabase
- TailscaleManager
- UnitDefinitionsModel
- ShellHandler
- WireGuardManager
- Iotistic Agent
- admin/src/api/network.ts
- commands/db.ts
- steps
- package-cli
- logger
- anomaly-rule-template.model.ts
- energy-recommendation.model.ts
- MaintenanceRecommendationModel
- opcua/adapter.ts
- MessageBufferSync
- anomaly/buffer.ts
- SourceConnectionFields.vue
- setup_remote_access.sh
- src/api/ml-datasets.ts
- AppMarketplaceModel
- AnomalyInjectionSimulation
- MqttBrokerClient
- install.sh
- MqttUserModel
- schema-drift-rule.model.ts
- JobEngine
- RustOpcuaSubscriber
- schema-drift-rule-template.model.ts
- handleServiceMenu
- overrides
- anomaly/utils.ts
- endpoint-outputs.model.ts
- docker
- steps
- recommendation-publish-settings.model.ts
- transform-shared.ts
- jobs/monitor.ts
- validation.ts
- opcua/device-identity.ts
- load
- Iotistica Agent
- AlertManager
- api/mqtt.ts
- 🔐 MQTTS/TLS Setup
- LocalLogBackend
- MetadataModel
- graphify.yml
- AgentState
- doAction
- drift-presets.ts
- schema-drift.ts
- package
- EnergyRuleModel
- CredentialManager
- MaintenanceRuleModel
- version
- maintenance-recommendation.model.ts
- BacnetPropertyId
- connectLogs
- CLIError
- build
- docker
- jobs
- AssetModel
- AssetMetricModel
- JobStatus
- connectWs
- arbiter.ts
- modbus/types.ts
- StatusError
- resolveState
- 🔍 Protocol Discovery
- version
- rule-resolver.ts
- OPC-UA Adapter
- Modbus TCP/RTU Adapter
- Iotistic Agent: Feature Overview
- ref_node_assert
- cleanup.sh
- smoke.sh
- opcua-device-identification.test.ts
- upload-azure
- test-provisioning-skip.sh
- .resolveMqttPointIdentities
- SKILL.md
- configured-points.unit.spec.ts
- install-unit-generation.unit.spec.ts
- write_reading_json
- Logger
- IPublishPlugin
- 🔀 IPC Pub/Sub Routing
- jobs
- ipc/package.json
- Iotistica Agent — Troubleshooting
- update.sh
- Transport Switch Buffering Review
- opcua/package.json
- publish/package.json
- AzureIotClient
- external-modules.d.ts
- uninstall.sh
- cli-install.sh
- docker-entrypoint.sh
- build-deb.sh
- enable_ssl.sh
- isCodedSysError
- shell-handler.ts
- test-install-with-vpn.sh
- test-wireguard-client.sh
- Main Functions
- 🔄 Cloud Sync Reliability
- rimraf@^5.0.10
- Unified Event System
- verify_ci
- @types/dockerode@^3.3.28
- IoTistic CPU profiling — Raspberry Pi to Windows
- @types/pg@^8.20.3
- ConfigurationValidationError
- DeltaApplyError
- NativeIpcServer
- NativeIpcServer
- commands/license.ts
- FailedToProvisionDeviceError
- GitHub Actions → Raspberry Pi deployment
- PULL_REQUEST_TEMPLATE.md
- env
- DestinationConfigFields.vue
- confidence-policy.ts
- docker-image-usage.ts
- MarketplaceCategoriesModel
- MqttRouter
- cgroups.sh
- services
- Security Policy
- src/api/anomaly.ts
- influxdb.ts
- update-runner.sh
- SchemaViewer.vue
- ipc
- opcua-subscriber
- discovery-blocklist.model.ts
- MessageIdGenerator
- mqtt/adapter.ts
- DiscoveryRunModel
- getHealthPayload
- schema.ts
- 🎯 Quick Start
- publish/index.d.ts
- publish

## God Nodes (most connected - your core abstractions)
1. `AgentLogger` - 257 edges
2. `getDatabase()` - 145 edges
3. `PublishManager` - 116 edges
4. `LogComponents` - 89 edges
5. `CLIError` - 83 edges
6. `ConfigManager` - 76 edges
7. `OPCUAAdapter` - 76 edges
8. `AdapterManager` - 74 edges
9. `ContainerManager` - 73 edges
10. `buildCommands()` - 71 edges

## Surprising Connections (you probably didn't know these)
- `Phase 2C-4: internal resolution` --references--> `PublishManager`  [INFERRED]
  docs/phase2c-point-identity-integration-design.md → src/publish/core/manager.ts
- `Gap During Transport Switching` --references--> `MessageBufferSync`  [INFERRED]
  docs/transport-switch-buffering-review.md → src/publish/core/buffer.ts
- `10. Legacy compatibility and preservation` --references--> `DeviceDataPoint`  [INFERRED]
  docs/phase2c3-trusted-protocol-evidence-design.md → src/plugins/types.ts
- `2. Current lifecycle and trust boundaries` --references--> `DeviceDataPoint`  [INFERRED]
  docs/phase2c3-trusted-protocol-evidence-design.md → src/plugins/types.ts
- `Event sources` --references--> `EventSource`  [INFERRED]
  CLAUDE.md → src/events/types.ts

## Import Cycles
- 2-file cycle: `src/containers/container-manager.ts -> src/containers/docker-manager.ts -> src/containers/container-manager.ts`

## Communities (337 total, 73 thin omitted)

### Community 0 - "AgentLogger"
Cohesion: 0.06
Nodes (12): Dynamic Configuration Updates, How It Works, Supported Dynamic Updates, DeviceAPIConstructOpts, AgentLogger, LogBackend, LogLevel, ChunkingConfig (+4 more)

### Community 1 - "publish/core/types.ts"
Cohesion: 0.04
Nodes (30): mqtt, BasePublishPlugin, PayloadChunkCalculator, DatasetAccumulatorEntry, IPublishClient, Logger, AwsIotConfig, AwsPublishPlugin (+22 more)

### Community 2 - "actions.ts"
Cohesion: 0.03
Nodes (102): addService(), AgentInstance, anomalyMetricResultKey(), approveImageUpdate(), browseOPCUAAddressSpace(), buildDockerOptions(), checkForUpdate(), checkImageUpdates() (+94 more)

### Community 3 - "PublishManager"
Cohesion: 0.06
Nodes (7): Subscription/Binding Model, CloudSync state reports, Endpoint telemetry, Recommended Behavior by Flow, CompressionInfo, compressionToOpts(), PublishManager

### Community 4 - "AnomalyView.vue"
Cohesion: 0.02
Nodes (115): BUILTIN_ANOMALY_TEMPLATES, BuiltinAnomalyTemplate, DetectionMethod, SeasonalityPattern, activeCategories, activeTab, advancedOpen, badActors (+107 more)

### Community 5 - "AppLayout.vue"
Cohesion: 0.03
Nodes (78): authApi, AuthUser, MarketplaceImage, usersApi, agentVersion, buildId, { currentUser, logout }, { fetchDockerStatus } (+70 more)

### Community 6 - "ContainersView.vue"
Cohesion: 0.02
Nodes (85): actionInFlight, addSvcDrawerOpen, addSvcForm, addSvcSaving, addSvcSelectedImage, addSvcTargetApp, appDetailsName, appDetailsOpen (+77 more)

### Community 7 - "AssetsView.vue"
Cohesion: 0.02
Nodes (80): energyApi, maintenanceApi, assets, availableMetricOptions, buildConfig(), buildWindowGating(), close(), cumulativeRuntime (+72 more)

### Community 8 - "SettingsView.vue"
Cohesion: 0.02
Nodes (96): licenseApi, LicenseState, LicenseStatus, LicenseTier, updateApi, UpdateCheckResult, UpdateTriggerResult, activeTab (+88 more)

### Community 9 - "device-resolution-store.ts"
Cohesion: 0.17
Nodes (18): previewOPCUADevices(), addOwner(), confirmDeviceResolution(), ConfirmedDeviceIdentity, ConfirmedDeviceResolution, DeviceResolutionCandidate, DeviceResolutionKey, DeviceResolutionPreview (+10 more)

### Community 11 - "commands-e2e.integration.spec.ts"
Cohesion: 0.07
Nodes (34): CommandDeduplicator, DedupEntry, CommandDestination, CommandError, createCommandFeature(), readConfigFromEnv(), MqttCommandConsumer, CommandResultPublisher (+26 more)

### Community 12 - "BACnetAdapter"
Cohesion: 0.06
Nodes (18): Architecture, BACnet write data types, Command schema, Enabling it, MQTT Device-Write Commands, MQTT topics, Point name rules, Protocol support (+10 more)

### Community 13 - "ModbusClient"
Cohesion: 0.09
Nodes (7): ModbusClient, ByteOrder, ABCD, BADC, CDAB, DCBA, ModbusRegister

### Community 14 - "plugins/index.ts"
Cohesion: 0.06
Nodes (17): ISocketServer, AdapterFeatures, AdapterManager, hasOpcuaReadingEvidence(), matchesOpcuaConfiguration(), OpcuaIdentityState, OpcuaNamespaceEvidence, OpcuaShadowOptions (+9 more)

### Community 15 - "discovery/db.ts"
Cohesion: 0.06
Nodes (35): bacstack@^0.0.1-beta.14, bacstack, zod, DuplicateEndpointConnectionError, bacnetObjectTypes, discoveryPointKey(), mergeDiscoveredPoints(), BACnetReadResult (+27 more)

### Community 16 - "DiscoveryRulesView.vue"
Cohesion: 0.06
Nodes (30): activeTab, bulkDisable(), bulkDisabling, bulkEnable(), bulkEnabling, columns, deleting, drawerOpen (+22 more)

### Community 17 - "core/index.ts"
Cohesion: 0.06
Nodes (25): AgentManager, AgentInfo, ApiTlsConfig, AzurePublishingConfig, IotisticaPublishingConfig, KeyExchangeRequest, KeyExchangeResponse, MqttBrokerConfig (+17 more)

### Community 18 - "collection-utils.ts"
Cohesion: 0.04
Nodes (52): dockerode, buildContainerSecurityOptions(), InvalidNetworkNameError, ResourceRecreationAttemptError, acquireNetworkLock(), checkNetworkCollisions(), create(), ensureAgentNetwork() (+44 more)

### Community 19 - "DataExplorer.vue"
Cohesion: 0.02
Nodes (99): mergePinnedDataExplorerPoints(), dataExplorerSourceName(), activateTab(), activeSavedView, activeTab, candidateDatasetPoints, candidateViewPoints, closeSavedView() (+91 more)

### Community 20 - ".warnSync"
Cohesion: 0.07
Nodes (18): getBufferStatusPayload(), detectOrchestrator(), attachLogsToContainer(), HealthArbiter, createLogger(), UPDATE_REQUEST_FILE, UPDATE_RUNNING_FILE, AgentUpdater (+10 more)

### Community 21 - "OPCUADeviceClient"
Cohesion: 0.05
Nodes (23): createOPCUASession(), OPCUADeviceClient, OPCUADeviceClientOptions, OPCUAAdapterConfigSchema, OPCUACertificateTrustMode, OPCUACertificateTrustModeSchema, OPCUAConnection, OPCUAConnectionSchema (+15 more)

### Community 22 - "ConfigManager"
Cohesion: 0.08
Nodes (5): ConfigManager, ConfigReconciliationResult, ConfigStep, DeviceConfig, ProtocolAdapterDevice

### Community 23 - "codec.ts"
Cohesion: 0.25
Nodes (15): clearCodecCaches(), decodeCache, decodeHexId(), decodeUuid(), deserializePayload(), encodeCache, encodeHexId(), encodeIfUuid() (+7 more)

### Community 24 - "EndpointModel"
Cohesion: 0.15
Nodes (10): Discovery and source configuration, addEndpoint(), applyConfigUpdate(), logEvent(), removeEndpoint(), replaceEndpoint(), updateEndpoint(), validateOpcuaIdentification() (+2 more)

### Community 25 - "SchemaDriftDetector"
Cohesion: 0.06
Nodes (37): asRecord(), DEFAULT_OPTIONS, DeviceDriftState, DeviceSchema, DriftAlertEvent, DriftDetectorOptions, DriftRule, DriftSeverity (+29 more)

### Community 27 - "logging/types.ts"
Cohesion: 0.04
Nodes (63): setDiscoveryRulesScheduler(), setLocalLogBackend(), DeviceAPI, registerRuntimeHealthSubsystems(), CommandFeature, normalizeValue(), stableStringify(), StateReconcilerEvents (+55 more)

### Community 28 - "plugins/index.ts"
Cohesion: 0.03
Nodes (78): 11. Proposed regression matrix, 12. Unresolved decisions and risks, 13. Explicit approval gates, 1. Executive summary, 3. Phase 2B execution verification, 6. Legacy reconciliation decision table, 8. Verified field flows and proposed attachment boundary, 9. Failure, compatibility and rollback (+70 more)

### Community 29 - "DestinationsView.vue"
Cohesion: 0.03
Nodes (71): destinationsApi, TestResult, settingsApi, ALL_DESTINATION_TYPES, canTest, close(), CONFIG_TEMPLATES, defaultType (+63 more)

### Community 30 - "LogsView.vue"
Cohesion: 0.09
Nodes (27): LogLevel, LogMessage, logsApi, LogsFilter, LogSourceType, autoRefresh, clearFilters(), componentOptions (+19 more)

### Community 31 - "detectors.ts"
Cohesion: 0.08
Nodes (44): binaryConfidence(), CONFIDENCE_STRATEGY, exponentialConfidence(), getConfidence(), sigmoid(), getMethodsToRun(), runDetectionMethods(), RunDetectionMethodsInput (+36 more)

### Community 32 - "points/catalog.ts"
Cohesion: 0.05
Nodes (53): 10. Regression plan and required fixtures, 11. Risks and unresolved decisions, 1. Executive summary, 2. Current lifecycle and findings, 3. Existing identity dependency map, 4. Proposed additive SQLite schema, 5. Canonical protocol addresses, 6. Legacy reconciliation (+45 more)

### Community 33 - "DriftRuleDrawer.vue"
Cohesion: 0.04
Nodes (51): adaptivePromotionBatches, adaptivePromotionMinElapsedMs, adaptiveRetireBatches, advancedActiveKey, alertCooldownMs, alertOnDriftTypes, alertSeverity, ALL_DRIFT_TYPES (+43 more)

### Community 35 - "PointPickerModal.vue"
Cohesion: 0.07
Nodes (35): pointCatalogApi, PointCatalogEntry, catalogPoints, checkedKeys, configuredPoints, devices, emit, expandedProtocols (+27 more)

### Community 37 - "SubscriptionDrawer.vue"
Cohesion: 0.04
Nodes (48): subscriptionsApi, blankForm(), blankRoute(), buildIotisticaTopic(), close(), COMPRESSIONS, connSummary(), customIntervalUnit (+40 more)

### Community 38 - "fixtures.ts"
Cohesion: 0.06
Nodes (29): sinon, AgentState, HttpResponse, StatePoller, createCompleteConfigScenario(), createConfigUpdateScenario(), createEmptyDeviceState(), createETagCachedScenario() (+21 more)

### Community 39 - "types/index.ts"
Cohesion: 0.03
Nodes (85): anomalyApi, BadActor, BaselineProgress, DriftAlertType, DriftOptions, driftRulesApi, ProtocolOutput, RESOLUTION_REASON_LABELS (+77 more)

### Community 40 - "CloudLogBackend"
Cohesion: 0.06
Nodes (22): CloudLogBackend, LogSampler, SamplingRates, LogSpool, SpoolConfig, AckCursor, CloudLogBackendConfig, DroppedLogSummary (+14 more)

### Community 41 - "OPCUAAdapter"
Cohesion: 0.09
Nodes (8): OPCUAAdapter, OPCUAConnectionGroup, OPCUASession, resolveDeviceDisplayNames(), fmt(), OpcuaStartupDiagnostics, OPCUADataPoint, OPCUADeviceConfig

### Community 44 - "container-manager.ts"
Cohesion: 0.04
Nodes (70): AppStep, ContainerManagerEvents, DeviceApp, DeviceState, ContainerSecurityPolicyError, DEFAULT_PIDS_LIMIT, hostConfigMatchesPolicy(), MAX_PIDS_LIMIT (+62 more)

### Community 45 - "Agent"
Cohesion: 0.09
Nodes (4): Agent, AgentLifecycle, setMemoryLogger(), stopMemoryLeakSimulation()

### Community 46 - "core/manager.ts"
Cohesion: 0.06
Nodes (19): PublishFormatter, cleanDriftFieldName(), cleanProtocolPipeName(), KNOWN_DEVICE_ACRONYMS, prettifyDriftDeviceId(), stripFieldDevicePrefix(), AccumulatedFeature, MAX_BATCH_BYTES (+11 more)

### Community 47 - "AlertsView.vue"
Cohesion: 0.05
Nodes (47): eventsApi, RESOLUTION_REASON_LABELS, ResolutionReason, AgentAlert, AgentEvent, AgentIncident, SOURCE_LABELS, SOURCE_OPTIONS (+39 more)

### Community 48 - "runtime.ts"
Cohesion: 0.09
Nodes (27): licenseService(), createHttpClient(), bootstrapLicense(), BootstrapOptions, EMBEDDED_LICENSE_PUBLIC_KEY, getLicensePublicKey(), envEnabled(), getLicenseService() (+19 more)

### Community 49 - "lib/errors.ts"
Cohesion: 0.09
Nodes (22): AppendDirectiveError, AppsJsonParseError, BackupError, CodedSysError, DatabaseParseError, DeltaStillProcessingError, DeviceNotFoundError, ExchangeKeyError (+14 more)

### Community 50 - "SourcesView.vue"
Cohesion: 0.04
Nodes (45): EndpointCommunicationQuality, activeProtocol, activeTab, bulkDisable(), bulkDisabling, bulkEnable(), bulkEnabling, columns (+37 more)

### Community 51 - "package.json"
Cohesion: 0.06
Nodes (46): author, description, devDependencies, eslint@^8.57.1, jest@^29.0.0, sinon@^21.0.0, ts-jest@^29.0.0, ts-node@^10.0.0 (+38 more)

### Community 52 - "CreateViewDrawer.vue"
Cohesion: 0.06
Nodes (32): CreateViewInput, SavedView, viewsApi, canSave, description, DisplayPoint, displayPoints, emit (+24 more)

### Community 53 - "maintenance/service.ts"
Cohesion: 0.06
Nodes (43): createBuffer(), continuousDurationMs(), getLatestSample(), onRatioWithinWindow(), Sample, DebounceTracker, evaluateCumulativeRuntime(), evaluateCycleCount() (+35 more)

### Community 54 - ".warn"
Cohesion: 0.09
Nodes (16): DeviceStateHistoryModel, Protocol, CanonicalDeviceState, extractRawDeviceState(), extractStateField(), fallbackStateForProtocol(), FAULT_TOKENS, IDLE_TOKENS (+8 more)

### Community 55 - "ContainerManager"
Cohesion: 0.06
Nodes (5): ContainerManager, ImageUpdateStatus, getManagerStatus(), StateManager, cloneDeep()

### Community 56 - "models/index.ts"
Cohesion: 0.05
Nodes (42): clearSchemaDriftBaselines(), BufferStats, MessageBufferRecord, CustomUnitAliasRecord, DataExplorerViewRecord, Device, DeviceStateHistoryRecord, DictionaryDelta (+34 more)

### Community 57 - "UsersView.vue"
Cohesion: 0.05
Nodes (43): UserRole, agentStarting, ApiError, client, Session, sessionsApi, User, { isDark } (+35 more)

### Community 58 - "MaintenanceRuleDrawer.vue"
Cohesion: 0.05
Nodes (41): assetsApi, addBinding(), addingBinding, bindingDeviceUuid, bindingMetric, close(), CRITICALITY_OPTIONS, emit (+33 more)

### Community 59 - "CloudSync"
Cohesion: 0.11
Nodes (17): MqttConnectOptions, PublishMode, BufferSyncConfig, StateReporterDeps, CloudTransport, AgentDeviceReport, AgentStateReport, CloudSyncConfig (+9 more)

### Community 60 - "DashboardView.vue"
Cohesion: 0.03
Nodes (63): CanonicalUnit, CustomUnitAlias, dashboardApi, DashboardStats, NetworkBandwidth, NormalizationHealth, NormalizationIssue, NormalizationIssueSummary (+55 more)

### Community 61 - "DiscoveryDrawer.vue"
Cohesion: 0.05
Nodes (42): addAll(), addDevice(), addedThisSession, adding, addingAll, awaitingBackgroundResult, backgroundRuleUuid, blockedFingerprints (+34 more)

### Community 62 - "CreateDatasetDrawer.vue"
Cohesion: 0.06
Nodes (37): CreateMlDatasetInput, datasetsApi, MlDataset, bestPointName(), canSave, description, DisplayPoint, displayPoints (+29 more)

### Community 63 - "steps"
Cohesion: 0.05
Nodes (41): description, value, description, TRIVY_VERSION, default, description, required, description (+33 more)

### Community 64 - "DeviceDrawer.vue"
Cohesion: 0.07
Nodes (27): deviceApi, DeviceInfo, WritablePoint, WriteResult, addEntry(), assetPath, close(), copiedUuid (+19 more)

### Community 65 - "docker-manager.ts"
Cohesion: 0.07
Nodes (33): DockerAuthConfig, DockerContainerInfo, DockerContainerInfo, DockerStateSyncContext, ManagedContainerSummary, mapDockerStateToServiceState(), syncStateFromDocker(), checkImageUpdate() (+25 more)

### Community 66 - "quality/index.ts"
Cohesion: 0.19
Nodes (19): sourceCheck(), CheckDefinition, CheckFn, valueCheck(), buildCompactIssueCodes(), CHECK_DEFINITIONS, createDataQualityInterceptor(), evaluateReading() (+11 more)

### Community 67 - "containers/types.ts"
Cohesion: 0.04
Nodes (34): SecurityPolicySummary, ServiceSecurityConfig, DockerDriver, createOrchestratorDriver(), DriverFactoryConfig, HealthCheckConfig, HealthCheckExecutor, HealthCheckManager (+26 more)

### Community 68 - "PrivateEvidenceRegistry"
Cohesion: 0.11
Nodes (27): Phase 2C-3A implementation status, AddressProtocol, Binding, copyObserved(), isObject(), isRecord(), Observation, PrivateEvidenceRegistry (+19 more)

### Community 69 - "buildCommands"
Cohesion: 0.17
Nodes (20): agentState(), showStatusEnhanced(), appsList(), configGet(), configGetApi(), configReset(), configSet(), configShow() (+12 more)

### Community 70 - "publish/src/lib.rs"
Cohesion: 0.14
Nodes (34): AnomalyFields, apply_enrichment_fields(), attach_ml_enrichment(), BatchConfig, BatchResult, BatchTiming, build_compact_issue_codes(), build_custom_envelope() (+26 more)

### Community 71 - "timescaledb.ts"
Cohesion: 0.07
Nodes (25): pg@^8.22.0, pg, coerceValue(), CustomPayload, detectProtocolFromTopic(), isTagsPayload(), isTransientError(), KNOWN_PROTOCOLS (+17 more)

### Community 72 - "sqlite.ts"
Cohesion: 0.06
Nodes (35): __dirname, STORAGE_STATE, 2. Verified implementation and baseline, 5. SQLite lifecycle, transaction and concurrency, { existsSync, readFileSync }, { join }, getDbStats(), close() (+27 more)

### Community 73 - "anomaly/types.ts"
Cohesion: 0.07
Nodes (26): AlertMetricState, loadSimulationConfig(), normalizeSimulationMetrics(), PatternEvolutionPhase, PatternEvolutionState, SimulationMetricContext, SimulationOrchestrator, AnomalyDefaults (+18 more)

### Community 74 - "BaseHttpClient"
Cohesion: 0.09
Nodes (4): BaseHttpClient, HttpClientConfig, fetchMock, TestHttpClient

### Community 75 - "memory.ts"
Cohesion: 0.08
Nodes (46): setHealthReporter(), agent, gracefulShutdown(), hasSystemdWatchdog(), health, markFatalAndRecover(), stopWatchdog, bytesToMB() (+38 more)

### Community 76 - "configured-point-resolver.ts"
Cohesion: 0.09
Nodes (22): OpcuaAddressInput, bacnetInput(), buildCanonicalInput(), createIdentities(), CreateIdentitiesResult, EndpointInput, EndpointResolution, findAmbiguousKeys() (+14 more)

### Community 77 - "system/metrics.ts"
Cohesion: 0.10
Nodes (34): systeminformation@^5.31.7, systeminformation, getFirewallInterfaceOptions(), getNetworkInterfaces(), NetworkInterfaceInfo, NetworkInterfaceOption, bytesToMb(), configureAnomalyFeed() (+26 more)

### Community 78 - "agent.model.ts"
Cohesion: 0.13
Nodes (12): getSettings(), Agent, AgentModel, AgentRow, decryptData(), decryptDeviceRecord(), encryptData(), encryptDeviceRecord() (+4 more)

### Community 79 - "credentials.ts"
Cohesion: 0.10
Nodes (13): DatabaseClient, DeviceRecord, SqliteDatabaseClient, ApiKeyRotatedEvent, CredentialManagerConfig, RotationReason, SubscriberResponse, buildAgentEndpoint() (+5 more)

### Community 80 - "data-explorer-point-key.ts"
Cohesion: 0.10
Nodes (32): ActivityEvent, pipelineApi, SubscriptionActivity, chart, emit, error, load(), loading (+24 more)

### Community 81 - "MarketplaceCatalog.vue"
Cohesion: 0.08
Nodes (31): addCategory(), categories, category, cleanPorts(), dbCategories, { dockerAvailable }, editingId, emit (+23 more)

### Community 82 - "opcua/src/lib.rs"
Cohesion: 0.07
Nodes (18): check_session_alive(), do_connect(), do_subscribe_arc(), do_teardown(), encode_batch(), MAX_RECONNECT_DELAY, MIN_RECONNECT_DELAY, NodeConfig (+10 more)

### Community 83 - "src/core.ts"
Cohesion: 0.11
Nodes (24): agentPullTargetState(), agentUpdate(), bufferStatus(), describeCloudFetchError(), formatMaybeAge(), formatMaybeTime(), memoryDiagnostics(), restart() (+16 more)

### Community 84 - "publish/core/types.ts"
Cohesion: 0.09
Nodes (16): DictionaryMetrics, IPublishClient, MessageBufferSyncOptions, DeviceConfigSchema, DevicePublishConfigSchema, DriftOptionsSchema, DriftRuleConfigSchema, DriftSeverityEnum (+8 more)

### Community 85 - "MqttAdapter"
Cohesion: 0.10
Nodes (5): MQTT filter provenance verification, Phase 2C-3C MQTT implementation status, MqttAdapter, MqttDevice, runtime()

### Community 87 - "AnomalyDetectionService"
Cohesion: 0.09
Nodes (8): MetricMatchContext, AlertMqttClient, AnomalyDetectionService, AnomalyMqttClient, AnomalyConfig, CanonicalDeviceState, DataPoint, MqttPayload

### Community 88 - "anomaly/service.ts"
Cohesion: 0.09
Nodes (29): resetBuffer(), extractRawDeviceState(), extractStateField(), fallbackStateForProtocol(), FAULT_TOKENS, IDLE_TOKENS, normalizeDeviceState(), normalizeNumericState() (+21 more)

### Community 89 - "MessageViewer.vue"
Cohesion: 0.08
Nodes (23): copyUuid(), activeTab, compression, compressionApplied, copied, copy(), displayMessage, effectiveText (+15 more)

### Community 90 - "CaptureTab.vue"
Cohesion: 0.05
Nodes (38): autoScroll, available, bpfFilter, columns, drawerOpen, fetchRetainedPackets(), filterDirection, filteredPackets (+30 more)

### Community 91 - "containers.ts"
Cohesion: 0.10
Nodes (24): categoriesApi, ContainerApp, ContainerMetricsResponse, containersApi, ContainerService, DeployAppForm, DeployServiceForm, DockerConfig (+16 more)

### Community 92 - "backup.ts"
Cohesion: 0.18
Nodes (20): createDbBackup(), DbBackupInfo, DbBackupMetadata, DbVerificationResult, ensureDir(), formatTimestampForFile(), getDefaultBackupDir(), getIntegrityCheck() (+12 more)

### Community 93 - "SourcePointsPanel.vue"
Cohesion: 0.07
Nodes (28): ConfiguredPoint, addressText(), allFiltered, browsePath(), columns, drawerOpen, emit, error (+20 more)

### Community 94 - "PointsTable.vue"
Cohesion: 0.10
Nodes (24): parsedPoints, columns, detailFor(), expandedKeys, filtered, loadPinned(), pinnedNames, pinnedStorageKey() (+16 more)

### Community 95 - "ipc/src/lib.rs"
Cohesion: 0.07
Nodes (23): broadcast_frame(), CLIENT_STALL_TIMEOUT, ClientState, create_listener(), enlarge_send_buffer(), flush_pending_buffers(), HEX, MAX_BATCH_AGE (+15 more)

### Community 96 - "point-identity-catalog.ts"
Cohesion: 0.16
Nodes (23): Phase 2C-2 implementation and review limits, MAX_MQTT_FIELD_IDENTITIES, AliasRow, CatalogReason, identity(), IdentityRow, isBusy(), isProtocol() (+15 more)

### Community 97 - "BackupsView.vue"
Cohesion: 0.08
Nodes (21): Backup, backups, BackupSchedule, columns, confirmDelete(), confirmRestore(), createBackup(), creating (+13 more)

### Community 98 - "startWatchdog"
Cohesion: 0.26
Nodes (9): execFileAsync, HealthCheckFn, HealthCheckResult, normalizeHealthResult(), notifyReady(), notifySystemd(), sendNotification(), startWatchdog() (+1 more)

### Community 99 - "MqttBrokerView.vue"
Cohesion: 0.08
Nodes (22): collapsedSet, emit, localCollapsed, props, sorted, toggle(), activeTab, connected (+14 more)

### Community 101 - "StateReporter"
Cohesion: 0.13
Nodes (7): StateReporter, AsyncLock, CircuitBreaker, isAuthError(), isRetryableHttpError(), RetryableError, RetryPolicyConfig

### Community 102 - "infra.ts"
Cohesion: 0.14
Nodes (20): getCaptureEngine(), attachCaptureHandler(), authenticate(), parseCookie(), decodePacket(), serializePacket(), attachShellHandler(), authenticate() (+12 more)

### Community 103 - ".discover"
Cohesion: 0.17
Nodes (4): node-opcua-client, browseHierarchicalReferences(), identifyDevices(), OPCUADiscovery

### Community 104 - "cli/package.json"
Cohesion: 0.09
Nodes (23): bin, iotctl, dependencies, undici@^7.28.0, description, devDependencies, @types/node@^22.19.7, typescript@^5.9.3 (+15 more)

### Community 105 - "compress.ts"
Cohesion: 0.09
Nodes (15): createJsonPayload(), createMsgpackPayload(), serializePayload(), CompressorOptions, deflateAsync, Payload, PayloadCompressor, shouldDeflate() (+7 more)

### Community 106 - "with"
Cohesion: 0.08
Nodes (26): with, build-args, cache-from, cache-to, cleanup, context, creds, driver-opts (+18 more)

### Community 107 - "units/catalog.ts"
Cohesion: 0.15
Nodes (10): CustomUnitAliasesModel, UnitAliasesModel, seedUnitCatalog(), suggestCanonicalUnits(), UnitSuggestion, SeedUnitAlias, SeedUnitDefinition, UNIT_ALIASES (+2 more)

### Community 108 - "mqtt/auth.ts"
Cohesion: 0.07
Nodes (27): BACnetConfig, ConfigManagerEvents, FeatureToggles, IntervalConfig, LoggingConfig, ModbusConfig, ModbusConnectionConfig, MQTTConfig (+19 more)

### Community 109 - "ModbusAdapter"
Cohesion: 0.06
Nodes (8): Phase 2C-3B final corrections, Phase 2C-3B OPC UA implementation status, BaseProtocolAdapter, DeviceMetrics, MetricsSummary, ModbusAdapter, ModbusDevice, IDeviceStatus

### Community 111 - "units/index.ts"
Cohesion: 0.25
Nodes (17): getUnitCatalog(), convertUnit(), ConvertUnitResult, createUnitNormalizationInterceptor(), unitNormalizationInterceptor(), NO_UNIT_PLACEHOLDERS, normalizeReadingInPlace(), ProtocolMessage (+9 more)

### Community 113 - "scripts"
Cohesion: 0.08
Nodes (25): scripts, build, build:admin, clean, copy:db-assets, copy:pipeline-assets, dev, dev:admin (+17 more)

### Community 114 - "lib/http-client.ts"
Cohesion: 0.05
Nodes (16): BatchConfig, BatchResult, BatchTiming, DatasetConfig, NativePublishFormatter, ProcessedChunk, SerializeResult, CompressionStats (+8 more)

### Community 115 - "RetryManager"
Cohesion: 0.09
Nodes (6): isRetryableError(), RetryManager, RetryStateModel, ContainerLogMonitor, ContainerLogAttachment, LogStreamOptions

### Community 116 - "DecodedPacket"
Cohesion: 0.07
Nodes (30): ABORT_REASONS, BacnetDecoder, BVLC_FUNCTIONS, CONFIRMED_SERVICES, decodeObjectIdentifier(), ERROR_CLASSES, ERROR_CODES, OBJECT_TYPES (+22 more)

### Community 117 - "init/agent.ts"
Cohesion: 0.14
Nodes (17): isOpcuaFlow, logger, initAgent(), initializeAgentManager(), initializeCloudLogging(), initializeVpnReconnection(), normalizeOptionalEnvValue(), getTenantId() (+9 more)

### Community 118 - "ActivityMonitor"
Cohesion: 0.08
Nodes (10): ActivityEvent, ActivityMonitor, activityMonitor, CompressionSnapshot, displayEndpointName(), displayNameCache, EventRing, PointHistorySample (+2 more)

### Community 119 - "NetworkView.vue"
Cohesion: 0.06
Nodes (35): activeTab, applyFirewallMode(), drawerOpen, editingRule, firewallColumns, firewallData, firewallDisableConfirmationOpen, firewallIsActive (+27 more)

### Community 120 - "express"
Cohesion: 0.14
Nodes (16): express, setLogger(), isHealthCheckPath(), isSilentDebugPath(), logging(), setLogger(), getClientIP(), isLocalhost() (+8 more)

### Community 121 - "DiscoveryRuleModel"
Cohesion: 0.24
Nodes (3): DiscoveryRuleModel, DiscoveryRulesScheduler, AgentEventInput

### Community 122 - "BaseFeature"
Cohesion: 0.15
Nodes (4): BaseFeature, FeatureConfig, FeatureLogger, MqttConnection

### Community 123 - "SourceDrawer.vue"
Cohesion: 0.03
Nodes (71): TopicNode, DeviceCandidateStrategy, DeviceDiscoveryPreview, OPCUABrowseNode, OPCUADeviceIdentification, sourcesApi, SourceTestRegisterResult, SourceTestResult (+63 more)

### Community 124 - "configured-points.ts"
Cohesion: 0.11
Nodes (24): getAdapterManager(), ConfiguredPointRow, findAssociatedDevice(), getConfiguredPointRows(), isDeferred(), isRecord(), mqttFieldName(), pointName() (+16 more)

### Community 125 - "steps"
Cohesion: 0.06
Nodes (34): concurrency, cancel-in-progress, group, env, ACCT, FORCE_JAVASCRIPT_ACTIONS_TO_NODE24, GH_REPO, GH_TOKEN (+26 more)

### Community 126 - "TcpAssembler"
Cohesion: 0.08
Nodes (19): ArpPacketInfo, CapturedPacket, CaptureFilter, CaptureStatus, IP_PROTOCOL_NAMES, ParsedCapturePayload, WELL_KNOWN_PORTS, FramedMessage (+11 more)

### Community 127 - "OpcUaReader"
Cohesion: 0.09
Nodes (16): ALLOWED_CHUNKS, OpcUaReader, CONNECTION_MSG_TYPES, MESSAGE_TYPE_NAMES, MIN_MESSAGE_SIZES, OpcuaDecoder, OpcuaDecoderConfig, STATUS_CODE_NAMES (+8 more)

### Community 128 - "forecaster.ts"
Cohesion: 0.08
Nodes (27): calculatePredictionConfidence(), calculateTrendDirection(), calculateTrendStrength(), calculateTrendThreshold(), EMA_PREDICTOR_LOOKBACK, EMAPredictor, estimateLinearTimeToThreshold(), estimateLinearTimeToThresholdResult() (+19 more)

### Community 129 - "MqttUsersTab.vue"
Cohesion: 0.10
Nodes (17): columns, confirmDelete(), createForm, createOpen, creating, deleteUser(), deleting, load() (+9 more)

### Community 130 - "CaptureEngine"
Cohesion: 0.09
Nodes (8): CaptureEngine, CaptureInterfaceError, CaptureStartOptions, createLogger(), createPcapHeader(), createPcapRecord(), decodeFrame(), packet29

### Community 131 - "pipeline.service.ts"
Cohesion: 0.11
Nodes (14): pendingTransforms, pipelineEvents, PipelineService, DeviceFilterConfig, PIPELINE_ALLOWED_NODE_TYPES, PipelineFlow, PipelineFlowNode, PipelineInConfig (+6 more)

### Community 132 - "DevicePublish"
Cohesion: 0.07
Nodes (4): DeviceContext, DevicePublishConfig, DriftOptions, DevicePublish

### Community 133 - "iotctl.ts"
Cohesion: 0.17
Nodes (17): CommandGroup, CommandHandler, CommandMap, humanBytes(), pipelineAdd(), pipelineList(), pipelineRemove(), pipelineSet() (+9 more)

### Community 134 - "compilerOptions"
Cohesion: 0.07
Nodes (26): compilerOptions, outDir, rootDir, exclude, extends, include, compilerOptions, allowJs (+18 more)

### Community 135 - "with"
Cohesion: 0.09
Nodes (23): with, build-args, cache-from, cache-to, context, creds, fetch-depth, file (+15 more)

### Community 136 - "dependencies"
Cohesion: 0.09
Nodes (23): dependencies, bcryptjs@^3.0.3, dockerode@^4.0.2, express@^4.18.2, @influxdata/influxdb-client@~1.33.2, mqtt@^5.14.1, mqtt-pattern@^2.0.0, msgpack-lite@^0.1.26 (+15 more)

### Community 137 - "SocketServer"
Cohesion: 0.13
Nodes (5): 10. Independently reviewable implementation plan, Phase 2C-2: isolated catalog service, Phase 2C-3: trusted protocol evidence, Phase 2C-4: internal resolution, SocketServer

### Community 138 - "jobs/types.ts"
Cohesion: 0.11
Nodes (20): ActionCommandInput, ActionCommandInputSchema, ActionHandlerInput, ActionHandlerInputSchema, ActionType, RUN_COMMAND, RUN_HANDLER, JobAction (+12 more)

### Community 139 - "opcua-shadow-evidence.unit.spec.ts"
Cohesion: 0.13
Nodes (6): DeviceModel, good, MockClient, start(), tick(), waitForCount()

### Community 140 - "DiscoveryService"
Cohesion: 0.04
Nodes (20): modbus-serial@^8.0.17, modbus-serial, withModbusFingerprint(), DiscoveryRule, DiscoveryOptionsBuilder, DiscoveryService, BACnetClientLike, BACnetDiscovery (+12 more)

### Community 141 - "BaseMqttClient"
Cohesion: 0.11
Nodes (3): BaseMqttClient, applyTopicTemplate(), AwsIotClient

### Community 142 - "normalizeSourceSystem"
Cohesion: 0.13
Nodes (10): UnitCatalog, getNormalizationHealthTracker(), keyFor(), NormalizationHealthSummary, NormalizationHealthTracker, NormalizationIssueSummary, resetNormalizationHealthTrackerForTests(), TrackedIssue (+2 more)

### Community 143 - "compilerOptions"
Cohesion: 0.05
Nodes (37): compilerOptions, isolatedModules, module, moduleResolution, noEmit, rootDir, types, exclude (+29 more)

### Community 144 - "useSystemStats.ts"
Cohesion: 0.15
Nodes (19): AppSystemStats, ContainerMetricsApp, appCpuHistories, appMetrics, cpuColor(), cpuHistory, cpuSamples, fmtMb() (+11 more)

### Community 145 - "compilerOptions"
Cohesion: 0.10
Nodes (19): compilerOptions, allowImportingTsExtensions, isolatedModules, jsx, lib, module, moduleDetection, moduleResolution (+11 more)

### Community 146 - "agent"
Cohesion: 0.08
Nodes (23): build, command, container_name, environment, networks, ports, restart, volumes (+15 more)

### Community 147 - "steps"
Cohesion: 0.10
Nodes (20): if, name, runs-on, steps, env, PLINK, PLINK_ARGS, jobs (+12 more)

### Community 148 - "DeviceDrawer.vue"
Cohesion: 0.07
Nodes (26): activeProtocol, bulkDisable(), bulkDisabling, bulkEnable(), bulkEnabling, columns, deleting, Device (+18 more)

### Community 149 - "MessageBatcher"
Cohesion: 0.13
Nodes (3): MessageBatcher, DeviceConfig, pushReading()

### Community 150 - "opcua/discovery.ts"
Cohesion: 0.13
Nodes (14): OPCUADeviceIdentification, cacheKey(), clearDiscoveryCache(), computeStructuralHash(), DiscoveryCache, DiscoveryCacheEntry, FolderCacheEntry, getDiscoveryCache() (+6 more)

### Community 151 - "AgentFirewall"
Cohesion: 0.08
Nodes (20): CreateFirewallRule, FirewallRule, FirewallRuleAction, FirewallRuleModel, FirewallRuleRow, UpdateFirewallRule, validateAction(), getDefaultRuleAdaptor() (+12 more)

### Community 152 - "FeatureInitializer"
Cohesion: 0.09
Nodes (8): setCaptureEngine(), setDevicePublish(), setFirewall(), AdapterInitializer, FeatureContext, FeatureInitializer, resumeLeakDetection(), suppressLeakDetection()

### Community 153 - "TerminalView.vue"
Cohesion: 0.04
Nodes (53): pages, dependencies, @ant-design/icons-vue@^7.0.1, ant-design-vue@^4.2.6, axios@^1.7.9, device-agent@file:.., vue@^3.5.13, vue-router@^4.5.0 (+45 more)

### Community 154 - "canonical-address.ts"
Cohesion: 0.11
Nodes (33): AddressProvenance, bacnet(), BacnetAddressInput, bacnetTypeNumbers, bacnetTypes, canonicalizeAddress(), canonicalizeModbusAddresses(), integer() (+25 more)

### Community 155 - "buildCommands"
Cohesion: 0.30
Nodes (17): adaptersAdd(), adaptersDisable(), adaptersEnable(), adaptersList(), adaptersRemove(), adaptersShow(), deriveState(), formatConnection() (+9 more)

### Community 156 - "build-agent-ci.yml"
Cohesion: 0.18
Nodes (10): concurrency, cancel-in-progress, group, env, FORCE_JAVASCRIPT_ACTIONS_TO_NODE24, name, on, push (+2 more)

### Community 157 - "asset.model.ts"
Cohesion: 0.07
Nodes (29): addAssetMetric(), createAsset(), createEnergyRule(), createMaintenanceRule(), deleteAsset(), deleteEnergyRule(), deleteMaintenanceRule(), getAsset() (+21 more)

### Community 158 - "src/api/network.ts"
Cohesion: 0.06
Nodes (35): getFirewall(), persistFirewallMode(), firewallModeUpdateQueue, getDockerPorts(), getSystemPorts(), isSystemFirewallRuleAction(), networkRouter, normalizeSystemFirewallRules() (+27 more)

### Community 159 - "native-migrations.ts"
Cohesion: 0.18
Nodes (11): columnExists(), loadSqlAsset(), loadTemplateSql(), tableExists(), NativeSqliteMigration, migration, up(), migration (+3 more)

### Community 160 - "BrokerMonitorService"
Cohesion: 0.09
Nodes (8): BrokerMetrics, BrokerMonitorService, BrokerStatus, JSONSchema, RateSample, SchemaGenerator, TopicHistoryEntry, TopicNode

### Community 161 - "Publish Pipeline Architecture"
Cohesion: 0.07
Nodes (27): Activity Monitor, Bounded Batch Size (Anti-Snowball), buildPayload() — CAUTION: Format Mismatch, Common Failure Modes, Compression Options, End-to-End Data Flow, IPC buffer-full disconnects, IPC Server (modules/ipc/) (+19 more)

### Community 162 - "JobsFeature"
Cohesion: 0.18
Nodes (3): JobsFeature, JobExecutionData, HttpClient

### Community 163 - "SocketConnection"
Cohesion: 0.18
Nodes (7): RuntimeSnapshot, SocketConnection, DeviceState, CONNECTED, CONNECTING, DISCONNECTED, ERROR

### Community 164 - "Phase 2C-3: Trusted Protocol Evidence Integration Design"
Cohesion: 0.12
Nodes (17): 10. Legacy compatibility and preservation, 11. Catalog, SQLite, admission and contention blockers, 12. Proposed test matrix, 13. Proposed implementation slices and review gates, 14. Operational risks, diagnostics and rollback, 15. Verification performed for this design, 16. Open decisions and explicit approval gate, 1. Executive summary and scope (+9 more)

### Community 165 - "getDatabase"
Cohesion: 0.08
Nodes (22): ANOMALY_SOURCES, eventsRouter, stripDeviceUuidSuffix(), VALID_RESOLUTION_REASONS, withPrettyDeviceName(), EventBus, ALERT_THRESHOLDS, escalateSeverity() (+14 more)

### Community 166 - "TailscaleManager"
Cohesion: 0.27
Nodes (4): initVpnActions(), execAsync, spawnAsync(), TailscaleManager

### Community 168 - "ShellHandler"
Cohesion: 0.24
Nodes (3): ShellMqttClient, ShellHandler, verifyCommandSignature()

### Community 169 - "WireGuardManager"
Cohesion: 0.24
Nodes (3): NetworkRouteManager, execAsync, WireGuardManager

### Community 170 - "Iotistic Agent"
Cohesion: 0.07
Nodes (28): Applications, Architecture, Basic Example, Building, Composition Steps, Contributing, Development, 🐳 Docker Integration (+20 more)

### Community 171 - "admin/src/api/network.ts"
Cohesion: 0.09
Nodes (22): ArpPacketInfo, CaptureCounters, CapturePacket, CapturePacketDetail, CapturePacketsResponse, CaptureStartResponse, CaptureStatusData, CaptureStatusResponse (+14 more)

### Community 172 - "commands/db.ts"
Cohesion: 0.26
Nodes (16): dbBackup(), DbBackupListEntry, DbBackupServiceModule, dbList(), dbPrune(), dbRestore(), dbStats(), dbVerify() (+8 more)

### Community 173 - "steps"
Cohesion: 0.34
Nodes (16): steps, steps, steps, E2E_ADMIN_PASSWORD_FILE, steps, steps, continue-on-error, env (+8 more)

### Community 174 - "package-cli"
Cohesion: 0.20
Nodes (11): arch, package-cli, include, strategy, if, name, needs, runs-on (+3 more)

### Community 175 - "logger"
Cohesion: 0.23
Nodes (10): devicesList(), discover(), endpointsClean(), formatConnection(), isModbusDiscoveryTarget(), parseConnectionValue(), showLogs(), showVersion() (+2 more)

### Community 176 - "anomaly-rule-template.model.ts"
Cohesion: 0.20
Nodes (8): createAnomalyTemplate(), deleteAnomalyTemplate(), listAnomalyTemplates(), updateAnomalyTemplate(), AnomalyRuleTemplate, AnomalyRuleTemplateCreateData, AnomalyRuleTemplateModel, AnomalyRuleTemplateRow

### Community 177 - "energy-recommendation.model.ts"
Cohesion: 0.23
Nodes (7): listEnergyRecommendations(), updateEnergyRecommendationStatus(), EnergyRecommendation, EnergyRecommendationEvalResult, EnergyRecommendationModel, EnergyRecommendationRow, EnergyRecommendationStatus

### Community 179 - "opcua/adapter.ts"
Cohesion: 0.05
Nodes (17): WorkerBackedSocketServer, ConsoleLogger, OpcuaReadingEvidence, resolveUnitFromDescription(), blankRecord(), DiagnosableSession, OpcuaDeviceDiagnosticRecord, looksLikeEngineeringUnit() (+9 more)

### Community 180 - "MessageBufferSync"
Cohesion: 0.15
Nodes (7): Design summary, Minimal implementation approach, Proposed control states, Proposed Solution, Why this fits existing code patterns, BufferAdmissionDecision, MessageBufferSync

### Community 181 - "anomaly/buffer.ts"
Cohesion: 0.13
Nodes (23): calculateConfidence(), calculateSeverity(), createAnomalyAlert(), createId(), generateSeverityReason(), addToBuffer(), addValue(), getBufferStats() (+15 more)

### Community 182 - "SourceConnectionFields.vue"
Cohesion: 0.13
Nodes (13): emit, get(), modelOptions, onModelChange(), props, selectedModel, selectedVendor, set() (+5 more)

### Community 183 - "setup_remote_access.sh"
Cohesion: 0.45
Nodes (14): check_requirements(), configure_cloud_server(), configure_cloud_sshd(), generate_ssh_key(), main(), print_banner(), print_error(), print_info() (+6 more)

### Community 184 - "src/api/ml-datasets.ts"
Cohesion: 0.12
Nodes (15): DatasetResponse, isValidPointKey(), mlDatasetsRouter, normalizeAndDedupKeys(), normalizePointKey(), VALID_MISSING_VALUES, VALID_NORMALIZATIONS, VALID_OUTLIER_METHODS (+7 more)

### Community 185 - "AppMarketplaceModel"
Cohesion: 0.24
Nodes (4): router, MarketplaceImage, AppMarketplaceModel, template

### Community 186 - "AnomalyInjectionSimulation"
Cohesion: 0.17
Nodes (3): AnomalyInjectionSimulation, AnomalyBaselineRecord, AnomalySimulationService

### Community 188 - "MqttBrokerClient"
Cohesion: 0.11
Nodes (3): MqttBrokerClient, MqttBrokerClientHandlers, IProtocolClient

### Community 189 - "install.sh"
Cohesion: 0.19
Nodes (21): configure_mosquitto_file_auth(), generate_password(), generate_systemd_unit(), has_interactive_tty(), install_docker_if_needed(), install_mosquitto_if_needed(), installer_exit(), installer_message() (+13 more)

### Community 191 - "MqttUserModel"
Cohesion: 0.27
Nodes (4): MqttUser, MqttUserModel, MqttUserRow, parseRow()

### Community 192 - "schema-drift-rule.model.ts"
Cohesion: 0.32
Nodes (4): DriftRuleRow, parseRow(), SchemaDriftRuleModel, DriftRuleConfig

### Community 194 - "RustOpcuaSubscriber"
Cohesion: 0.14
Nodes (3): NativeSubscriberInstance, RustOpcuaSubscriber, TransformPool

### Community 195 - "schema-drift-rule-template.model.ts"
Cohesion: 0.35
Nodes (4): DriftRuleTemplate, parseRow(), SchemaDriftRuleTemplateModel, TemplateRow

### Community 196 - "handleServiceMenu"
Cohesion: 0.13
Nodes (20): addService(), approveImageUpdate(), cloneService(), confirmRemoveService(), deployTemplate(), deployTemplateAsNewApp(), emptyService(), envToRows() (+12 more)

### Community 197 - "overrides"
Cohesion: 0.14
Nodes (14): overrides, brace-expansion, @grpc/grpc-js, handlebars, ip-address, jsrsasign, path-to-regexp, picomatch (+6 more)

### Community 198 - "anomaly/utils.ts"
Cohesion: 0.18
Nodes (4): RunDetectionMethodsResult, DetectionMethod, loadConfigFromEnv(), loadConfigFromTargetState()

### Community 199 - "endpoint-outputs.model.ts"
Cohesion: 0.29
Nodes (4): DeviceEndpointOutput, DriftOptions, EndpointOutputModel, EndpointOutputRow

### Community 200 - "docker"
Cohesion: 0.17
Nodes (12): name, needs, permissions, runs-on, docker, publish, permissions, contents (+4 more)

### Community 201 - "steps"
Cohesion: 0.30
Nodes (12): steps, steps, steps, id, if, name, run, shell (+4 more)

### Community 202 - "recommendation-publish-settings.model.ts"
Cohesion: 0.23
Nodes (7): getRecommendationPublishSettings(), updateRecommendationPublishSettings(), DEFAULTS, RecommendationPublishModule, RecommendationPublishSettings, RecommendationPublishSettingsModel, RecommendationPublishSettingsRow

### Community 203 - "transform-shared.ts"
Cohesion: 0.24
Nodes (9): buildPoint(), classifyQualityFromName(), mapQualityCode(), SyncMessage, TransformLookups, TransformRequest, WorkerInMessage, WorkerOutMessage (+1 more)

### Community 204 - "jobs/monitor.ts"
Cohesion: 0.25
Nodes (6): CloudJob, JobsConfig, JobsOptions, JobStatusUpdate, JobDocument, JobsMqttClient

### Community 205 - "validation.ts"
Cohesion: 0.19
Nodes (12): isEmpty(), isObject(), isHttpConflictError(), checkBooleanish(), checkFalsey(), checkInt(), CheckIntOptions, checkTruthy() (+4 more)

### Community 206 - "opcua/device-identity.ts"
Cohesion: 0.12
Nodes (18): 7. Protocol evidence matrix, DeviceCandidateResult, DeviceCandidateStrategy, DeviceCandidateStrategySchema, DiscoveryPoint, DiscoverySnapshot, generateDeviceCandidates(), objectPathKey() (+10 more)

### Community 207 - "load"
Cohesion: 0.40
Nodes (11): buildAdvancedConfig(), cleanPorts(), confirmDeployTarget(), deploy(), load(), parseLines(), rowsToEnv(), saveAppDetails() (+3 more)

### Community 208 - "Iotistica Agent"
Cohesion: 0.09
Nodes (23): Admin UI, Admin UI, Agent, Agent Startup Phases, Architecture, CLI (`iotctl`), Cloud-connected, Data Publishing Formats (+15 more)

### Community 209 - "AlertManager"
Cohesion: 0.13
Nodes (5): AlertManager, hash16(), AlertManager, AnomalyAlert, AnomalySeverity

### Community 210 - "api/mqtt.ts"
Cohesion: 0.13
Nodes (15): BrokerMetrics, BrokerStatus, CompressionSnapshot, FlatTopic, HistoryEntry, HistoryListEntry, mqttApi, emit (+7 more)

### Community 211 - "🔐 MQTTS/TLS Setup"
Cohesion: 0.09
Nodes (22): 1. Generate CA Certificate (Self-Signed), 2. Configure Mosquitto Broker, 3. Store CA Certificate in API Database, 4. Verify API Sends CA Certificate, 5. Agent Applies TLS Options, Architecture Flow, Check Agent Database, Check Agent Logs (+14 more)

### Community 214 - "graphify.yml"
Cohesion: 0.09
Nodes (22): concurrency, cancel-in-progress, group, env, GRAPHIFY_OUT, jobs, update-graph, name (+14 more)

### Community 215 - "AgentState"
Cohesion: 0.25
Nodes (8): AgentState, BOOT, ERROR, INIT, READY, RUNNING, STOPPED, STOPPING

### Community 216 - "doAction"
Cohesion: 0.67
Nodes (4): actionKey(), doAction(), isInFlight(), isServiceBusy()

### Community 217 - "drift-presets.ts"
Cohesion: 0.25
Nodes (7): ADVANCED_DRIFT_DEFAULTS, classifySensitivity(), DriftOptionsInner, SENSITIVITY_LEVELS, SENSITIVITY_PRESETS, SensitivityFields, SensitivityLevel

### Community 218 - "schema-drift.ts"
Cohesion: 0.31
Nodes (9): formatValue(), humanMs(), KNOWN_FIELDS, OPERATOR_FIELDS, printConfig(), schemaDriftGet(), schemaDriftResetAdvanced(), schemaDriftSet() (+1 more)

### Community 219 - "package"
Cohesion: 0.20
Nodes (10): arch, deb_arch, package, include, name, needs, runs-on, strategy (+2 more)

### Community 223 - "version"
Cohesion: 0.22
Nodes (9): version, on, push, workflow_dispatch, tags, description, required, type (+1 more)

### Community 224 - "maintenance-recommendation.model.ts"
Cohesion: 0.29
Nodes (6): listMaintenanceRecommendations(), updateMaintenanceRecommendationStatus(), MaintenanceRecommendation, MaintenanceRecommendationEvalResult, MaintenanceRecommendationRow, MaintenanceRecommendationStatus

### Community 225 - "BacnetPropertyId"
Cohesion: 0.22
Nodes (9): BacnetPropertyId, DESCRIPTION, MODEL_NAME, OBJECT_LIST, OBJECT_NAME, PRESENT_VALUE, PRIORITY_ARRAY, UNITS (+1 more)

### Community 226 - "connectLogs"
Cohesion: 0.25
Nodes (8): clearLogs(), connectLogs(), fullApp(), openAppLogs(), openLogs(), parseLogLine(), switchService(), toggleFollow()

### Community 227 - "CLIError"
Cohesion: 0.20
Nodes (24): appsInfo(), appsPurge(), appsRestart(), appsStart(), appsStop(), configSetApi(), deprovision(), factoryReset() (+16 more)

### Community 228 - "build"
Cohesion: 0.25
Nodes (8): name, needs, outputs, runs-on, build, agent_version, cli_version, sha_short

### Community 229 - "docker"
Cohesion: 0.25
Nodes (8): name, needs, permissions, runs-on, docker, actions, contents, security-events

### Community 230 - "jobs"
Cohesion: 0.25
Nodes (7): concurrency, cancel-in-progress, group, env, FORCE_JAVASCRIPT_ACTIONS_TO_NODE24, jobs, name

### Community 233 - "JobStatus"
Cohesion: 0.25
Nodes (8): JobStatus, CANCELED, FAILED, IN_PROGRESS, QUEUED, REJECTED, SUCCEEDED, TIMED_OUT

### Community 234 - "connectWs"
Cohesion: 0.24
Nodes (13): cancelPacketFlush(), captureWsUrl(), clearCapture(), connectWs(), disconnectWs(), formatCaptureInterface(), handleInterfaceChange(), loadInterfaces() (+5 more)

### Community 235 - "arbiter.ts"
Cohesion: 0.29
Nodes (4): HealthReport, SubsystemCheckFn, SubsystemHealth, SubsystemOptions

### Community 236 - "modbus/types.ts"
Cohesion: 0.06
Nodes (29): Endianness, BIG, LITTLE, ModbusAdapterConfigSchema, ModbusConnectionConfig, ModbusConnectionSchema, ModbusConnectionType, ASCII (+21 more)

### Community 237 - "StatusError"
Cohesion: 0.29
Nodes (4): BadRequestError, DeltaServerError, NotFoundError, StatusError

### Community 238 - "resolveState"
Cohesion: 0.33
Nodes (6): resolveState(), stateColor(), stateLabel(), summaryForApp(), totalRunning, totalStopped

### Community 239 - "🔍 Protocol Discovery"
Cohesion: 0.29
Nodes (7): Best Practices, Configuration, Discovered Device Storage, Discovery Features, Discovery Schedule, 🔍 Protocol Discovery, Two-Phase Discovery Architecture

### Community 240 - "version"
Cohesion: 0.33
Nodes (6): version, tag, version, name, outputs, runs-on

### Community 242 - "rule-resolver.ts"
Cohesion: 0.47
Nodes (5): DetectionRuleBase, DetectionRuleScope, globCache, matchGlob(), resolveRules()

### Community 243 - "OPC-UA Adapter"
Cohesion: 0.11
Nodes (18): CAN Bus Adapter (Planned), Configuration, Data Scaling, Database Configuration, Error Handling, File Locations, Key Features, Named Pipe Integration (+10 more)

### Community 244 - "Modbus TCP/RTU Adapter"
Cohesion: 0.12
Nodes (17): Batch Read Optimization, Concurrency Protection, Configuration, Data Quality Indicators, Data Types & Byte Ordering, Error Handling Examples, External Timeout Wrapper, File Locations (+9 more)

### Community 245 - "Iotistic Agent: Feature Overview"
Cohesion: 0.12
Nodes (17): 10) Update And Maintenance Workflows, 11) Observability And Diagnostics, 12) Simulation And Testing Support, 13) Extensibility, 1) Device Onboarding And Lifecycle, 2) Application And Service Management, 3) Industrial And IoT Protocol Coverage, 4) Data Collection And Telemetry (+9 more)

### Community 246 - "ref_node_assert"
Cohesion: 0.08
Nodes (10): builtInTabs, DataExplorerTabs, restoreDataExplorerTabs(), sampleApps, sampleConfig, sampleDisabledConfig, good, logger (+2 more)

### Community 247 - "cleanup.sh"
Cohesion: 0.70
Nodes (4): ok(), cleanup.sh script, skip(), warn()

### Community 248 - "smoke.sh"
Cohesion: 0.70
Nodes (4): auth(), fail(), smoke.sh script, step()

### Community 249 - "opcua-device-identification.test.ts"
Cohesion: 0.40
Nodes (4): config, good, makeSession(), ref()

### Community 250 - "upload-azure"
Cohesion: 0.40
Nodes (5): upload-azure, if, name, needs, runs-on

### Community 251 - "test-provisioning-skip.sh"
Cohesion: 0.90
Nodes (4): check_provisioning_status(), reset_provisioning(), test-provisioning-skip.sh script, simulate_provisioning()

### Community 253 - "SKILL.md"
Cohesion: 0.13
Nodes (14): Admin UI, Authenticate and call API, Build, CLI via docker exec, Deploy, Full smoke test, Gotchas, Key API endpoints (+6 more)

### Community 254 - "configured-points.unit.spec.ts"
Cohesion: 0.06
Nodes (18): ConfiguredEndpoint, configuredPointsRouter, dataExplorerViewsRouter, SavedViewResponse, parseCookie(), RANK, requireRole(), SESSION_COOKIE (+10 more)

### Community 255 - "install-unit-generation.unit.spec.ts"
Cohesion: 0.60
Nodes (5): buildTestPreamble(), generateUnit(), INSTALL_SH, runBash(), validateOnly()

### Community 256 - "write_reading_json"
Cohesion: 0.35
Nodes (7): BufReader, BufReader<'a>, decode_batch_to_json(), write_json_escaped(), write_json_key_str(), write_opt_field(), write_reading_json()

### Community 258 - "IPublishPlugin"
Cohesion: 0.05
Nodes (13): HostBinding, IPublishPlugin, PublishBatchItem, buildAuthorizationDetails(), DatabricksConfig, DatabricksPublishPlugin, isTagsPayload(), loadConfig() (+5 more)

### Community 259 - "🔀 IPC Pub/Sub Routing"
Cohesion: 0.14
Nodes (13): Alarm forwarder — BAD quality only across all protocols, Analytics sink — all protocols, light 500 ms throttle, Architecture, AWS sink — OPC-UA, exclude noisy test device, cap at 200 points/message, Azure sink — Modbus temperature/humidity, GOOD quality, 5 s throttle, Connection Lifecycle, Dashboard — GOOD quality only, named devices, multi-protocol, Examples (+5 more)

### Community 260 - "jobs"
Cohesion: 0.14
Nodes (14): if, name, needs, runs-on, jobs, e2e, package-agent, test (+6 more)

### Community 261 - "ipc/package.json"
Cohesion: 0.17
Nodes (12): devDependencies, @napi-rs/cli@^2.18.0, @napi-rs/cli, main, name, napi, name, private (+4 more)

### Community 262 - "Iotistica Agent — Troubleshooting"
Cohesion: 0.15
Nodes (8): Admin UI not reachable, Agent fails to start — module not found, Check agent status, Check first-run setup status, Iotistica Agent — Troubleshooting, Port 1883 conflict (Mosquitto), Reinstall / upgrade, Useful log commands

### Community 264 - "Transport Switch Buffering Review"
Cohesion: 0.17
Nodes (12): 1. Durable MQTT message spool, 2. Durable endpoint telemetry spool with claim-before-publish semantics, 3. Durable CloudSync report queue, 4. In-memory MQTT pending publish queue, 5. Cloud log buffering and disk spool, Bottom Line, Current State Transport Flow, Gap During Transport Switching (+4 more)

### Community 265 - "opcua/package.json"
Cohesion: 0.17
Nodes (12): devDependencies, @napi-rs/cli@^2.18.0, @napi-rs/cli, main, name, napi, name, private (+4 more)

### Community 266 - "publish/package.json"
Cohesion: 0.17
Nodes (12): devDependencies, @napi-rs/cli@^2.18.0, @napi-rs/cli, main, name, napi, name, private (+4 more)

### Community 278 - "isCodedSysError"
Cohesion: 0.50
Nodes (4): isCodedSysError(), isEEXIST(), isEISDIR(), isEPERM()

### Community 288 - "Main Functions"
Cohesion: 0.20
Nodes (10): API Reference, Events, `executeStep(step, options?): Promise<void>`, `getCurrentApps(): Promise<InstancedAppState>`, `getRequiredSteps(currentApps, targetApps, keepImages?, keepVolumes?, force?): Promise<CompositionStep[]>`, `getState(): Promise<AppState>`, `getTargetApps(): Promise<TargetApps>`, `initialized(): Promise<void>` (+2 more)

### Community 290 - "🔄 Cloud Sync Reliability"
Cohesion: 0.25
Nodes (8): Circuit Breaker Protection, 🔄 Cloud Sync Reliability, Combined Protection, Configuration, Error Counter Capping, Monitoring, Request Deduplication, Utilities

### Community 292 - "Unified Event System"
Cohesion: 0.13
Nodes (14): API endpoints (`src/api/events.ts`), Codebase Intelligence and Token Optimization, Convenience helper, Database / migrations, End-of-task maintenance, Event sources, Frontend, graphify (+6 more)

### Community 293 - "verify_ci"
Cohesion: 0.22
Nodes (9): verify_ci, promote_latest, sha, actions, name, needs, outputs, permissions (+1 more)

### Community 295 - "IoTistic CPU profiling — Raspberry Pi to Windows"
Cohesion: 0.25
Nodes (7): 1. On Raspberry Pi: verify watchdog is off, 2. On Raspberry Pi: create profiler script (once), 3. On Raspberry Pi: enable Inspector and capture, 4. On Windows PowerShell: copy to Downloads, 5. On Windows: verify and upload, 6. Restore watchdog after testing, IoTistic CPU profiling — Raspberry Pi to Windows

### Community 301 - "commands/license.ts"
Cohesion: 0.52
Nodes (6): licenseActivate(), licenseApplyToken(), licenseStatus(), licenseTrial(), post(), printStatus()

### Community 303 - "GitHub Actions → Raspberry Pi deployment"
Cohesion: 0.29
Nodes (6): 1. Prepare the Raspberry Pi, 2. Get the Pi's SSH host key fingerprint, 3. Configure GitHub Actions secrets, 4. Deploy with the Windows self-hosted runner, 5. Verify and troubleshoot, GitHub Actions → Raspberry Pi deployment

### Community 304 - "PULL_REQUEST_TEMPLATE.md"
Cohesion: 0.29
Nodes (6): Notes, Screenshots, Summary, Testing, Type of change, What to review

### Community 305 - "env"
Cohesion: 0.29
Nodes (7): CI_WORKFLOW, GH_REPO, GH_TOKEN, RELEASE_BRANCH, RELEASE_TAG, env, env

### Community 307 - "DestinationConfigFields.vue"
Cohesion: 0.27
Nodes (9): cfg, emit, getMaxPayloadSizeValue(), handleUnitChange(), maxPayloadSizeUnit, props, set(), setIn() (+1 more)

### Community 308 - "confidence-policy.ts"
Cohesion: 0.39
Nodes (4): unitCheck(), assessUnitConfidence(), UNIT_PROVENANCE_CONFIDENCE, UnitProvenance

### Community 310 - "docker-image-usage.ts"
Cohesion: 0.47
Nodes (4): AppWithServices, DockerImageUsage, getDockerImageUsageByApp(), normalizeImageReference()

### Community 311 - "MarketplaceCategoriesModel"
Cohesion: 0.31
Nodes (4): getMarketplaceCategories(), CategoryRow, MarketplaceCategoriesModel, MarketplaceCategory

### Community 314 - "cgroups.sh"
Cohesion: 0.83
Nodes (3): die(), say(), cgroups.sh script

### Community 315 - "services"
Cohesion: 0.50
Nodes (3): command, services, agent

### Community 316 - "Security Policy"
Cohesion: 0.50
Nodes (3): Reporting a Vulnerability, Security Policy, Supported Versions

### Community 320 - "influxdb.ts"
Cohesion: 0.13
Nodes (8): applyNumericField(), CustomPayload, InfluxDbConfig, InfluxDbNoopClient, InfluxDbPublishPlugin, isTagsPayload(), loadConfig(), TagsPayload

### Community 323 - "SchemaViewer.vue"
Cohesion: 0.24
Nodes (7): JSONSchema, fieldCount, fields, flattenSchema(), props, SchemaField, TYPE_COLORS

### Community 332 - "mqtt/adapter.ts"
Cohesion: 0.08
Nodes (26): mqtt-pattern, AUTO_METRICS_SKIP_KEYS, MQTT_UNIT_TO_CANONICAL, MqttSelectorToken, MqttShadowOptions, MqttTraversal, coerceType(), isBinaryPayload() (+18 more)

### Community 337 - "getHealthPayload"
Cohesion: 0.60
Nodes (6): getHealthPayload(), getHealthReportPayload(), getHealthReportSafe(), getLifecycleStateSafe(), getReadinessPayload(), getReadinessSafe()

### Community 340 - "schema.ts"
Cohesion: 0.60
Nodes (4): effectiveSchema, generateArraySchema(), generateObjectSchema(), generateSchema()

### Community 341 - "🎯 Quick Start"
Cohesion: 0.50
Nodes (4): Anomaly Detection (Edge AI), CLI Tool - iotctl, 🎯 Quick Start, Simulation Mode

## Knowledge Gaps
- **85 isolated node(s):** `ANALOG_INPUT`, `ANALOG_OUTPUT`, `ANALOG_VALUE`, `BINARY_INPUT`, `BINARY_OUTPUT` (+80 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 3663 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **73 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `AgentLogger` connect `AgentLogger` to `publish/core/types.ts`, `actions.ts`, `CaptureEngine`, `DevicePublish`, `CloudSync`, `commands-e2e.integration.spec.ts`, `DiscoveryService`, `jobs/types.ts`, `plugins/index.ts`, `discovery/db.ts`, `BaseMqttClient`, `core/index.ts`, `AzureIotClient`, `.warnSync`, `ConfigManager`, `codec.ts`, `FeatureInitializer`, `AgentFirewall`, `opcua/discovery.ts`, `logging/types.ts`, `plugins/index.ts`, `shell-handler.ts`, `src/api/network.ts`, `detectors.ts`, `.infoSync`, `JobsFeature`, `TailscaleManager`, `CloudLogBackend`, `WireGuardManager`, `CloudMqttClient`, `ShellHandler`, `container-manager.ts`, `Agent`, `runtime.ts`, `MessageBufferSync`, `anomaly/buffer.ts`, `maintenance/service.ts`, `ContainerManager`, `models/index.ts`, `AnomalyInjectionSimulation`, `CloudSync`, `docker-manager.ts`, `JobEngine`, `containers/types.ts`, `sqlite.ts`, `anomaly/types.ts`, `BaseHttpClient`, `memory.ts`, `jobs/monitor.ts`, `agent.model.ts`, `credentials.ts`, `publish/core/types.ts`, `OfflineQueue`, `AnomalyDetectionService`, `anomaly/service.ts`, `backup.ts`, `CredentialManager`, `startWatchdog`, `BaseOrchestratorDriver`, `StateReporter`, `infra.ts`, `.discover`, `arbiter.ts`, `mqtt/auth.ts`, `AnomalyStorageService`, `RetryManager`, `init/agent.ts`, `express`, `DiscoveryRuleModel`, `BaseFeature`, `TcpAssembler`?**
  _High betweenness centrality (0.128) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `getDatabase()` (e.g. with `2. Verified implementation and baseline` and `4. Proposed internal catalog contract`) actually correct?**
  _`getDatabase()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `ANALOG_INPUT`, `ANALOG_OUTPUT`, `ANALOG_VALUE` to the rest of the system?**
  _85 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `AgentLogger` be split into smaller, more focused modules?**
  _Cohesion score 0.05660377358490566 - nodes in this community are weakly interconnected._
- **Why does `vue` connect `AppLayout.vue` to `MqttUsersTab.vue`, `AnomalyView.vue`, `ContainersView.vue`, `AssetsView.vue`, `SettingsView.vue`, `useSystemStats.ts`, `DiscoveryRulesView.vue`, `DataExplorer.vue`, `DeviceDrawer.vue`, `TerminalView.vue`, `DestinationsView.vue`, `LogsView.vue`, `DriftRuleDrawer.vue`, `PointPickerModal.vue`, `SubscriptionDrawer.vue`, `types/index.ts`, `AlertsView.vue`, `SourcesView.vue`, `DestinationConfigFields.vue`, `CreateViewDrawer.vue`, `SourceConnectionFields.vue`, `UsersView.vue`, `MaintenanceRuleDrawer.vue`, `DashboardView.vue`, `DiscoveryDrawer.vue`, `CreateDatasetDrawer.vue`, `DeviceDrawer.vue`, `SchemaViewer.vue`, `data-explorer-point-key.ts`, `MarketplaceCatalog.vue`, `api/mqtt.ts`, `MessageViewer.vue`, `CaptureTab.vue`, `containers.ts`, `SourcePointsPanel.vue`, `PointsTable.vue`, `BackupsView.vue`, `MqttBrokerView.vue`, `NetworkView.vue`, `SourceDrawer.vue`?**
  _High betweenness centrality (0.059) - this node is a cross-community bridge._
- **Are the 4 inferred relationships involving `PublishManager` (e.g. with `Anomaly, persistence, publishing and views` and `Phase 2C-4: internal resolution`) actually correct?**
  _`PublishManager` has 4 INFERRED edges - model-reasoned connections that need verification._
- **Should `publish/core/types.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.043468313886982385 - nodes in this community are weakly interconnected._