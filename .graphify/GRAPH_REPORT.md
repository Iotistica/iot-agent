# Graph Report - iot-agent  (2026-11-26)

## Corpus Check
- 739 files · ~729,243 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 21 file(s) not represented in the graph (top: (none) 11, .tmp-shm 2, .tmp-wal 2)

## Summary
- 9729 nodes · 22826 edges · 347 communities (274 shown, 73 thin omitted)
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 1771 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `45dd91d0`
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
- NormalizationHealthDrawer.vue
- DiscoveryRuleDrawer.vue
- core/index.ts
- collection-utils.ts
- DataExplorer.vue
- .warnSync
- OPCUADeviceClient
- ConfigManager
- codec.ts
- MqttDiscovery
- SchemaDriftDetector
- DictionaryManager
- LogComponents
- plugins/index.ts
- DestinationsView.vue
- LogsView.vue
- detectors.ts
- PointNameCatalog
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
- containers/types.ts
- docker-manager.ts
- quality/index.ts
- DockerDriver
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
- AgentModel
- ContainerService
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
- deviceName
- PointsTable.vue
- ipc/src/lib.rs
- point-identity-catalog.ts
- BackupsView.vue
- startWatchdog
- PublishDestinationsModel
- BaseOrchestratorDriver
- BaseProtocolAdapter
- IOrchestratorDriver
- .discover
- cli/package.json
- compress.ts
- with
- units/catalog.ts
- mqtt/auth.ts
- ModbusAdapter
- JobsFeature
- units/index.ts
- StateManager
- scripts
- lib/http-client.ts
- RetryManager
- DecodedPacket
- Logger
- ActivityMonitor
- NetworkView.vue
- infra.ts
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
- DeviceDataPoint
- jobs/types.ts
- device.model.ts
- BACnetDiscovery
- BaseMqttClient
- normalization-health-tracker.ts
- compilerOptions
- useSystemStats.ts
- compilerOptions
- agent
- steps
- DeviceDrawer.vue
- Phase 2C-1: durable point identity integration design
- opcua/discovery.ts
- AgentFirewall
- FeatureInitializer
- TerminalView.vue
- canonical-address.ts
- buildCommands
- build-agent-ci.yml
- asset.model.ts
- src/api/network.ts
- startMemoryMonitoring
- BrokerMonitorService
- Publish Pipeline Architecture
- FetchHttpClient
- SocketConnection
- .debug
- getDatabase
- volume-manager.ts
- UnitDefinitionsModel
- ShellHandler
- WireGuardManager
- Iotistic Agent
- admin/src/api/network.ts
- commands/db.ts
- steps
- package-cli
- decoders/index.ts
- AnomalyRuleTemplateModel
- energy-recommendation.model.ts
- MaintenanceRecommendationModel
- opcua/adapter.ts
- MessageBufferSync
- anomaly/buffer.ts
- SourceConnectionFields.vue
- setup_remote_access.sh
- publish-subscriptions.model.ts
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
- ShellMqttClient
- AdapterInitializer
- docker
- steps
- recommendation-publish-settings.model.ts
- iptables.ts
- jobs/monitor.ts
- validation.ts
- opcua/device-identity.ts
- load
- Iotistica Agent
- AlertManager
- api/mqtt.ts
- 🔐 MQTTS/TLS Setup
- Phase 2 design: durable source-scoped point identity
- plugin-loader.ts
- graphify.yml
- OpcuaPerfMonitor
- doAction
- publish.ts
- schema-drift.ts
- package
- EnergyRuleModel
- CredentialManager
- MaintenanceRuleModel
- version
- app.ts
- BacnetPropertyId
- connectLogs
- CLIError
- build
- docker
- jobs
- AssetModel
- shared/http-client.ts
- JobStatus
- connectWs
- admin/package.json
- modbus/types.ts
- OpcUaFramer
- resolveState
- 🔍 Protocol Discovery
- version
- dependencies
- rule-resolver.ts
- OPC-UA Adapter
- Modbus TCP/RTU Adapter
- Iotistic Agent: Feature Overview
- ref_node_assert
- cleanup.sh
- smoke.sh
- identity.ts
- upload-azure
- test-provisioning-skip.sh
- .resolveMqttPointIdentities
- SKILL.md
- UserModel
- MqttPublishPlugin
- write_reading_json
- @playwright/test
- ExternalMqttFlushProxy
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
- api/license.ts
- restartAgent
- test-install-with-vpn.sh
- test-wireguard-client.sh
- Main Functions
- 🔄 Cloud Sync Reliability
- CLILogger
- Unified Event System
- verify_ci
- points/interceptor.ts
- IoTistic CPU profiling — Raspberry Pi to Windows
- update.ts
- SparklineChart.vue
- submitEditAlias
- NativeIpcServer
- NativeIpcServer
- commands/license.ts
- QuarantineStore
- GitHub Actions → Raspberry Pi deployment
- PULL_REQUEST_TEMPLATE.md
- env
- opcua-decoder.unit.spec.ts
- DestinationConfigFields.vue
- confidence-policy.ts
- MQTT Device-Write Commands
- docker-image-usage.ts
- MarketplaceCategoriesModel
- MqttRouter
- points/catalog.ts
- cgroups.sh
- services
- Security Policy
- utils/network.ts
- src/api/anomaly.ts
- influxdb.ts
- update-runner.sh
- opcua-shadow-evidence.unit.spec.ts
- SchemaViewer.vue
- ipc
- opcua-subscriber
- discovery-blocklist.model.ts
- MessageIdGenerator
- mqtt-shadow-evidence.unit.spec.ts
- interfaces.ts
- DataExplorerViewModel
- DiscoveryRunModel
- scripts
- getHealthPayload
- CustomUnitAliasesModel
- PointNameMappingsModel
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
6. `ContainerManager` - 77 edges
7. `ConfigManager` - 76 edges
8. `OPCUAAdapter` - 76 edges
9. `AdapterManager` - 74 edges
10. `buildCommands()` - 71 edges

## Surprising Connections (you probably didn't know these)
- `Phase 2C-3: trusted protocol evidence` --references--> `SocketServer`  [INFERRED]
  docs/phase2c-point-identity-integration-design.md → src/core/socket-server.ts
- `Transactions and concurrency` --references--> `transact()`  [INFERRED]
  docs/phase2-point-identity-design.md → src/db/sqlite.ts
- `Event sources` --references--> `EventSource`  [INFERRED]
  CLAUDE.md → src/events/types.ts
- `1. Executive summary` --references--> `PointNameCatalog`  [INFERRED]
  docs/phase2-point-identity-design.md → src/points/catalog.ts
- `Gap During Transport Switching` --references--> `MessageBufferSync`  [INFERRED]
  docs/transport-switch-buffering-review.md → src/publish/core/buffer.ts

## Import Cycles
- 2-file cycle: `src/containers/container-manager.ts -> src/containers/docker-manager.ts -> src/containers/container-manager.ts`

## Communities (347 total, 73 thin omitted)

### Community 0 - "AgentLogger"
Cohesion: 0.04
Nodes (38): DeviceAPIConstructOpts, AgentRow, PublishDestinationRow, SubsystemCheckFn, SubsystemHealth, SubsystemOptions, ALLOWED_TRANSITIONS, ErrorLifecycleHook (+30 more)

### Community 1 - "publish/core/types.ts"
Cohesion: 0.04
Nodes (29): BasePublishPlugin, IPublishClient, IPublishPlugin, Logger, PublishBatchItem, PublishMode, AwsIotConfig, AwsPublishPlugin (+21 more)

### Community 2 - "actions.ts"
Cohesion: 0.03
Nodes (137): addEndpoint(), addService(), AgentInstance, applyConfigUpdate(), approveImageUpdate(), browseOPCUAAddressSpace(), buildDockerOptions(), checkForUpdate() (+129 more)

### Community 3 - "PublishManager"
Cohesion: 0.05
Nodes (5): Payload Formats, Endpoint telemetry, PublishDestinationRecord, MessageBatcher, PublishManager

### Community 4 - "AnomalyView.vue"
Cohesion: 0.02
Nodes (115): BUILTIN_ANOMALY_TEMPLATES, BuiltinAnomalyTemplate, DetectionMethod, SeasonalityPattern, activeCategories, activeTab, advancedOpen, badActors (+107 more)

### Community 5 - "AppLayout.vue"
Cohesion: 0.03
Nodes (91): authApi, AuthUser, agentStarting, ApiError, client, MarketplaceImage, deviceApi, DeviceInfo (+83 more)

### Community 6 - "ContainersView.vue"
Cohesion: 0.02
Nodes (85): actionInFlight, addSvcDrawerOpen, addSvcForm, addSvcSaving, addSvcSelectedImage, addSvcTargetApp, appDetailsName, appDetailsOpen (+77 more)

### Community 7 - "AssetsView.vue"
Cohesion: 0.02
Nodes (80): energyApi, maintenanceApi, assets, availableMetricOptions, buildConfig(), close(), DAYS, dutyCycle (+72 more)

### Community 8 - "SettingsView.vue"
Cohesion: 0.02
Nodes (81): activeTab, ALERT_FREQUENCY_OPTIONS, alertConfig, alertConfigLoading, alertConfigSaving, alertFrequencyOptions, alertMqttDestinations, canonicalUnitOptions (+73 more)

### Community 9 - "device-resolution-store.ts"
Cohesion: 0.15
Nodes (18): previewOPCUADevices(), addOwner(), confirmDeviceResolution(), ConfirmedDeviceIdentity, ConfirmedDeviceResolution, DeviceResolutionCandidate, DeviceResolutionKey, DeviceResolutionPreview (+10 more)

### Community 10 - "CloudSync"
Cohesion: 0.06
Nodes (8): Dynamic Configuration Updates, How It Works, Supported Dynamic Updates, ConnectionMonitor, CloudSync, StatePoller, AsyncLock, CircuitBreaker

### Community 11 - "commands-e2e.integration.spec.ts"
Cohesion: 0.06
Nodes (40): CommandDeduplicator, DedupEntry, CommandDestination, CommandError, createCommandFeature(), readConfigFromEnv(), MqttCommandConsumer, CommandResultPublisher (+32 more)

### Community 12 - "BACnetAdapter"
Cohesion: 0.04
Nodes (39): BACnet write data types, Protocol support, Writable-point allowlist, bacstack@^0.0.1-beta.14, bacstack, pLimit(), BACnetAdapter, BACnetClient (+31 more)

### Community 14 - "plugins/index.ts"
Cohesion: 0.08
Nodes (12): Phase 2B standalone version 1 contract, ISocketServer, Endpoint, AdapterFeatures, AdapterManager, groupFieldNamesByOwningDevice(), hasOpcuaReadingEvidence(), resolveEnrichedDeviceName() (+4 more)

### Community 15 - "NormalizationHealthDrawer.vue"
Cohesion: 0.08
Nodes (26): CanonicalUnit, CustomUnitAlias, dashboardApi, DashboardStats, NetworkBandwidth, NormalizationHealth, NormalizationIssue, NormalizationIssueSummary (+18 more)

### Community 16 - "DiscoveryRuleDrawer.vue"
Cohesion: 0.03
Nodes (65): discoveryApi, discoveryBlocklistApi, DiscoveryOptions, discoveryRulesApi, bacnet, BACnetParams, buildParamsJson(), close() (+57 more)

### Community 17 - "core/index.ts"
Cohesion: 0.04
Nodes (41): AgentManager, AgentInfo, ApiTlsConfig, AzurePublishingConfig, ConfigStep, IotisticaPublishingConfig, KeyExchangeRequest, KeyExchangeResponse (+33 more)

### Community 18 - "collection-utils.ts"
Cohesion: 0.05
Nodes (24): dockerode, InvalidNetworkNameError, Network, NetworkImpl, ComposeNetworkConfig, ComposeVolumeConfig, DockerNetwork, DockerNetworkConfig (+16 more)

### Community 19 - "DataExplorer.vue"
Cohesion: 0.02
Nodes (96): dataExplorerSourceName(), activateTab(), activeSavedView, activeTab, candidateDatasetPoints, candidateViewPoints, closeSavedView(), columns (+88 more)

### Community 20 - ".warnSync"
Cohesion: 0.06
Nodes (16): modbus-serial@^8.0.17, modbus-serial, registerRuntimeHealthSubsystems(), detectOrchestrator(), HealthArbiter, createLogger(), execFileAsync, ModbusDiscovery (+8 more)

### Community 21 - "OPCUADeviceClient"
Cohesion: 0.04
Nodes (26): 7. Protocol evidence matrix, createOPCUASession(), OPCUADeviceClient, OPCUAAdapterConfigSchema, OPCUACertificateTrustMode, OPCUACertificateTrustModeSchema, OPCUAConnection, OPCUADataPoint (+18 more)

### Community 22 - "ConfigManager"
Cohesion: 0.05
Nodes (7): Discovery and source configuration, ConfigManager, ConfigReconciliationResult, DeviceConfig, ProtocolAdapterDevice, EndpointModel, DiscoveryOptionsBuilder

### Community 23 - "codec.ts"
Cohesion: 0.25
Nodes (15): clearCodecCaches(), decodeCache, decodeHexId(), decodeUuid(), deserializePayload(), encodeCache, encodeHexId(), encodeIfUuid() (+7 more)

### Community 25 - "SchemaDriftDetector"
Cohesion: 0.06
Nodes (37): asRecord(), DEFAULT_OPTIONS, DeviceDriftState, DeviceSchema, DriftAlertEvent, DriftDetectorOptions, DriftRule, DriftSeverity (+29 more)

### Community 27 - "LogComponents"
Cohesion: 0.05
Nodes (59): setDiscoveryRulesScheduler(), DeviceAPI, CommandFeature, StateReconcilerEvents, BackupScheduler, DiscoveryRulesScheduler, initAgent(), initializeAgentManager() (+51 more)

### Community 28 - "plugins/index.ts"
Cohesion: 0.03
Nodes (54): mqtt, ClientRoutingRules, ClientSubscription, DiscoveryRule, DuplicateEndpointConnectionError, EndpointRow, bacnetObjectTypes, discoveryPointKey() (+46 more)

### Community 29 - "DestinationsView.vue"
Cohesion: 0.03
Nodes (76): destinationsApi, TestResult, settingsApi, ALL_DESTINATION_TYPES, canTest, close(), CONFIG_TEMPLATES, defaultType (+68 more)

### Community 30 - "LogsView.vue"
Cohesion: 0.09
Nodes (27): LogLevel, LogMessage, logsApi, LogsFilter, LogSourceType, autoRefresh, clearFilters(), componentOptions (+19 more)

### Community 31 - "detectors.ts"
Cohesion: 0.07
Nodes (46): binaryConfidence(), CONFIDENCE_STRATEGY, exponentialConfidence(), getConfidence(), sigmoid(), getMethodsToRun(), runDetectionMethods(), RunDetectionMethodsInput (+38 more)

### Community 32 - "PointNameCatalog"
Cohesion: 0.20
Nodes (4): baseKey(), PointNameCatalog, Logger, PointIdentity

### Community 33 - "DriftRuleDrawer.vue"
Cohesion: 0.04
Nodes (51): adaptivePromotionBatches, adaptivePromotionMinElapsedMs, adaptiveRetireBatches, advancedActiveKey, alertCooldownMs, alertOnDriftTypes, alertSeverity, ALL_DRIFT_TYPES (+43 more)

### Community 34 - ".infoSync"
Cohesion: 0.06
Nodes (6): initVpnActions(), DockerManager, createOrchestratorDriver(), execAsync, spawnAsync(), TailscaleManager

### Community 35 - "PointPickerModal.vue"
Cohesion: 0.05
Nodes (50): pointCatalogApi, PointCatalogEntry, ConfiguredPoint, catalogPoints, checkedKeys, configuredPoints, devices, emit (+42 more)

### Community 36 - "MessageBufferModel"
Cohesion: 0.17
Nodes (3): Durable Buffer (Message Retry), getBufferStatusPayload(), MessageBufferModel

### Community 37 - "SubscriptionDrawer.vue"
Cohesion: 0.04
Nodes (48): subscriptionsApi, blankForm(), blankRoute(), buildIotisticaTopic(), close(), COMPRESSIONS, connSummary(), customIntervalUnit (+40 more)

### Community 38 - "fixtures.ts"
Cohesion: 0.06
Nodes (27): sinon, HttpResponse, createCompleteConfigScenario(), createConfigUpdateScenario(), createEmptyDeviceState(), createETagCachedScenario(), createFirstBootScenario(), createMockAgentInfo() (+19 more)

### Community 39 - "types/index.ts"
Cohesion: 0.05
Nodes (49): anomalyApi, BadActor, BaselineProgress, DriftAlertType, DriftOptions, driftRulesApi, ProtocolOutput, RESOLUTION_REASON_LABELS (+41 more)

### Community 40 - "CloudLogBackend"
Cohesion: 0.04
Nodes (26): setLocalLogBackend(), DEFAULT_POLICY, DOCKER_POLICY, RetryPolicy, RetryState, initLogging(), CloudLogBackend, ContainerLogMonitor (+18 more)

### Community 41 - "OPCUAAdapter"
Cohesion: 0.11
Nodes (5): OPCUAAdapter, OPCUAConnectionGroup, OPCUASession, resolveDeviceDisplayNames(), OPCUADeviceConfig

### Community 44 - "container-manager.ts"
Cohesion: 0.06
Nodes (49): AppStep, ContainerManagerEvents, ContainerService, DeviceApp, DeviceState, SecurityPolicySummary, createNetwork(), createVolume() (+41 more)

### Community 45 - "Agent"
Cohesion: 0.07
Nodes (11): Agent, AgentLifecycle, AgentState, BOOT, ERROR, INIT, READY, RUNNING (+3 more)

### Community 46 - "core/manager.ts"
Cohesion: 0.05
Nodes (29): BatchConfig, BatchResult, BatchTiming, DatasetConfig, NativePublishFormatter, ProcessedChunk, SerializeResult, cleanDriftFieldName() (+21 more)

### Community 47 - "AlertsView.vue"
Cohesion: 0.05
Nodes (47): eventsApi, RESOLUTION_REASON_LABELS, ResolutionReason, AgentAlert, AgentEvent, AgentIncident, SOURCE_LABELS, SOURCE_OPTIONS (+39 more)

### Community 48 - "runtime.ts"
Cohesion: 0.10
Nodes (25): bootstrapLicense(), BootstrapOptions, EMBEDDED_LICENSE_PUBLIC_KEY, getLicensePublicKey(), envEnabled(), initLicensing(), isProLicensed(), PRO_STATES (+17 more)

### Community 49 - "lib/errors.ts"
Cohesion: 0.06
Nodes (32): AppendDirectiveError, AppsJsonParseError, BackupError, BadRequestError, CodedSysError, ConfigurationValidationError, DatabaseParseError, DeltaApplyError (+24 more)

### Community 50 - "SourcesView.vue"
Cohesion: 0.04
Nodes (45): EndpointCommunicationQuality, activeProtocol, activeTab, bulkDisable(), bulkDisabling, bulkEnable(), bulkEnabling, columns (+37 more)

### Community 51 - "package.json"
Cohesion: 0.05
Nodes (52): author, description, devDependencies, eslint@^8.57.1, jest@^29.0.0, rimraf@^5.0.10, sinon@^21.0.0, ts-jest@^29.0.0 (+44 more)

### Community 52 - "CreateViewDrawer.vue"
Cohesion: 0.07
Nodes (27): CreateViewInput, SavedView, viewsApi, canSave, description, DisplayPoint, displayPoints, emit (+19 more)

### Community 53 - "maintenance/service.ts"
Cohesion: 0.06
Nodes (44): addValue(), createBuffer(), continuousDurationMs(), getLatestSample(), onRatioWithinWindow(), Sample, DebounceTracker, evaluateCumulativeRuntime() (+36 more)

### Community 54 - ".warn"
Cohesion: 0.09
Nodes (18): 2. Current lifecycle and findings, Anomaly, persistence, publishing and views, DeviceStateHistoryModel, Protocol, CanonicalDeviceState, extractRawDeviceState(), extractStateField(), fallbackStateForProtocol() (+10 more)

### Community 56 - "models/index.ts"
Cohesion: 0.05
Nodes (36): 5. SQLite lifecycle, transaction and concurrency, clearSchemaDriftBaselines(), BufferStats, MessageBufferRecord, MessageBufferRow, DataExplorerViewRecord, DatabaseModel, DeviceStateHistoryRecord (+28 more)

### Community 57 - "UsersView.vue"
Cohesion: 0.06
Nodes (36): UserRole, Session, sessionsApi, User, usersApi, activeTab, bulkActivate(), bulkActivating (+28 more)

### Community 58 - "MaintenanceRuleDrawer.vue"
Cohesion: 0.05
Nodes (41): assetsApi, addBinding(), addingBinding, bindingDeviceUuid, bindingMetric, close(), CRITICALITY_OPTIONS, emit (+33 more)

### Community 59 - "CloudSync"
Cohesion: 0.06
Nodes (30): AgentState, ConnectionHealth, ConnectionMonitorEvents, ConnectionState, CompressionStats, HttpClient, HttpClientOptions, MqttConnectOptions (+22 more)

### Community 60 - "DashboardView.vue"
Cohesion: 0.05
Nodes (35): PipelineOverview, alertColumns, alertsTotal, cpuHistory, error, fmtCompact(), fmtThroughput(), incidentStats (+27 more)

### Community 61 - "DiscoveryDrawer.vue"
Cohesion: 0.05
Nodes (42): addAll(), addDevice(), addedThisSession, adding, addingAll, awaitingBackgroundResult, backgroundRuleUuid, blockedFingerprints (+34 more)

### Community 62 - "CreateDatasetDrawer.vue"
Cohesion: 0.06
Nodes (37): CreateMlDatasetInput, datasetsApi, MlDataset, bestPointName(), canSave, description, DisplayPoint, displayPoints (+29 more)

### Community 63 - "steps"
Cohesion: 0.05
Nodes (41): description, value, description, TRIVY_VERSION, default, description, required, description (+33 more)

### Community 64 - "containers/types.ts"
Cohesion: 0.11
Nodes (13): HealthCheckConfig, HealthCheckExecutor, HealthCheckManager, ContainerHealth, ContainerHealthProbe, ExecHealthCheck, HealthCheck, HealthCheckResult (+5 more)

### Community 65 - "docker-manager.ts"
Cohesion: 0.10
Nodes (24): DockerAuthConfig, DockerContainerInfo, DockerContainerInfo, DockerStateSyncContext, ManagedContainerSummary, mapDockerStateToServiceState(), syncStateFromDocker(), checkImageUpdate() (+16 more)

### Community 66 - "quality/index.ts"
Cohesion: 0.15
Nodes (20): sourceCheck(), CheckDefinition, CheckFn, valueCheck(), buildCompactIssueCodes(), CHECK_DEFINITIONS, createDataQualityInterceptor(), evaluateReading() (+12 more)

### Community 67 - "DockerDriver"
Cohesion: 0.08
Nodes (14): DockerDriver, DriverFactoryConfig, AppConfig, ContainerMetrics, CurrentState, HealthCheckType, HealthProbe, LogStreamOptions (+6 more)

### Community 68 - "PrivateEvidenceRegistry"
Cohesion: 0.10
Nodes (30): Phase 2C-3A implementation status, AddressProtocol, Binding, copyObserved(), isObject(), isRecord(), Observation, PrivateEvidenceRegistry (+22 more)

### Community 69 - "buildCommands"
Cohesion: 0.26
Nodes (19): showStatusEnhanced(), appsList(), configGet(), configGetApi(), configReset(), configSet(), configShow(), provisionStatus() (+11 more)

### Community 70 - "publish/src/lib.rs"
Cohesion: 0.14
Nodes (34): AnomalyFields, apply_enrichment_fields(), attach_ml_enrichment(), BatchConfig, BatchResult, BatchTiming, build_compact_issue_codes(), build_custom_envelope() (+26 more)

### Community 71 - "timescaledb.ts"
Cohesion: 0.07
Nodes (28): pg@^8.22.0, pg, toDeviceUuid(), uuidv5(), coerceValue(), CustomPayload, detectProtocolFromTopic(), isTagsPayload() (+20 more)

### Community 72 - "sqlite.ts"
Cohesion: 0.06
Nodes (36): __dirname, STORAGE_STATE, { existsSync, readFileSync }, { join }, close(), factoryReset(), gracefulShutdown(), dataDir (+28 more)

### Community 73 - "anomaly/types.ts"
Cohesion: 0.06
Nodes (27): AlertMetricState, loadSimulationConfig(), normalizeSimulationMetrics(), PatternEvolutionPhase, PatternEvolutionState, SimulationMetricContext, SimulationOrchestrator, AnomalyDefaults (+19 more)

### Community 74 - "BaseHttpClient"
Cohesion: 0.09
Nodes (4): BaseHttpClient, HttpClientConfig, fetchMock, TestHttpClient

### Community 75 - "memory.ts"
Cohesion: 0.11
Nodes (20): canAttemptRestart(), gcMetrics, getEventLoopDelayMs(), getGCTypeName(), getLeakConfig(), getRestartPolicyStatus(), getSimulationStatus(), heapSamples (+12 more)

### Community 76 - "configured-point-resolver.ts"
Cohesion: 0.08
Nodes (23): OpcuaAddressInput, bacnetInput(), buildCanonicalInput(), createIdentities(), CreateIdentitiesResult, EndpointInput, EndpointResolution, findAmbiguousKeys() (+15 more)

### Community 77 - "system/metrics.ts"
Cohesion: 0.13
Nodes (28): bytesToMb(), configureAnomalyFeed(), exec, ExtendedMetrics, getContainerMemory(), getCpuCores(), getCpuTemp(), getCpuUsage() (+20 more)

### Community 79 - "ContainerService"
Cohesion: 0.11
Nodes (24): ContainerSecurityPolicyError, DEFAULT_PIDS_LIMIT, hostConfigMatchesPolicy(), MAX_PIDS_LIMIT, permissionFailureHint(), resolveContainerSecurityPolicy(), ResolvedSecurityPolicy, ServiceSecurityConfig (+16 more)

### Community 80 - "data-explorer-point-key.ts"
Cohesion: 0.10
Nodes (33): ActivityEvent, pipelineApi, SubscriptionActivity, chart, emit, error, load(), loading (+25 more)

### Community 81 - "MarketplaceCatalog.vue"
Cohesion: 0.08
Nodes (31): addCategory(), categories, category, cleanPorts(), dbCategories, { dockerAvailable }, editingId, emit (+23 more)

### Community 82 - "opcua/src/lib.rs"
Cohesion: 0.07
Nodes (18): check_session_alive(), do_connect(), do_subscribe_arc(), do_teardown(), encode_batch(), MAX_RECONNECT_DELAY, MIN_RECONNECT_DELAY, NodeConfig (+10 more)

### Community 83 - "src/core.ts"
Cohesion: 0.12
Nodes (26): agentPullTargetState(), agentState(), agentUpdate(), bufferStatus(), describeCloudFetchError(), formatMaybeAge(), formatMaybeTime(), memoryDiagnostics() (+18 more)

### Community 84 - "publish/core/types.ts"
Cohesion: 0.07
Nodes (22): ADVANCED_DRIFT_DEFAULTS, classifySensitivity(), DriftOptionsInner, SENSITIVITY_LEVELS, SENSITIVITY_PRESETS, SensitivityFields, SensitivityLevel, DeviceConfig (+14 more)

### Community 85 - "MqttAdapter"
Cohesion: 0.08
Nodes (15): AUTO_METRICS_SKIP_KEYS, MQTT_UNIT_TO_CANONICAL, MqttAdapter, MqttSelectorToken, MqttTraversal, coerceType(), isBinaryPayload(), isUtf8() (+7 more)

### Community 86 - "OfflineQueue"
Cohesion: 0.15
Nodes (3): OfflineQueueModel, OfflineQueueRecord, OfflineQueue

### Community 87 - "AnomalyDetectionService"
Cohesion: 0.06
Nodes (7): MetricMatchContext, AnomalyDetectionService, mapDbBaselineToDetectorBaseline(), AnomalyStorageService, AnomalyConfig, CanonicalDeviceState, DataPoint

### Community 88 - "anomaly/service.ts"
Cohesion: 0.07
Nodes (32): calculateConfidence(), generateSeverityReason(), extractRawDeviceState(), extractStateField(), fallbackStateForProtocol(), FAULT_TOKENS, IDLE_TOKENS, normalizeDeviceState() (+24 more)

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

### Community 93 - "deviceName"
Cohesion: 0.15
Nodes (14): browsePath(), deviceName(), friendlyDevice(), Routing Rules (`route` object), Compatibility Notes, Current State, Level 1 — Per-Point Publish Mode, Level 2 — Browse Path as Topic Placeholder (+6 more)

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
Cohesion: 0.20
Nodes (8): execFileAsync, HealthCheckResult, normalizeHealthResult(), notifyReady(), notifySystemd(), sendNotification(), startWatchdog(), mockExecFile

### Community 99 - "PublishDestinationsModel"
Cohesion: 0.19
Nodes (11): updatePublisher(), ensureSocketDestination(), removeSocketDestination(), socketDestinationName(), socketPath(), PublishDestinationsModel, mockCreate, mockGetById (+3 more)

### Community 101 - "BaseProtocolAdapter"
Cohesion: 0.11
Nodes (5): Phase 2C-3B final corrections, Phase 2C-3B OPC UA implementation status, BaseProtocolAdapter, GenericDeviceConfig, TestAdapter

### Community 103 - ".discover"
Cohesion: 0.15
Nodes (6): node-opcua-client@^2.170.1, node-opcua-client, browseHierarchicalReferences(), collectOpcuaDeviceSnapshot(), identifyDevices(), OPCUADiscovery

### Community 104 - "cli/package.json"
Cohesion: 0.09
Nodes (23): bin, iotctl, dependencies, undici@^7.28.0, description, devDependencies, @types/node@^22.19.7, typescript@^5.9.3 (+15 more)

### Community 105 - "compress.ts"
Cohesion: 0.07
Nodes (18): PublishFormatter, MlDatasetRecord, createJsonPayload(), createMsgpackPayload(), serializePayload(), compressionToOpts(), CompressorOptions, deflateAsync (+10 more)

### Community 106 - "with"
Cohesion: 0.08
Nodes (26): with, build-args, cache-from, cache-to, cleanup, context, creds, driver-opts (+18 more)

### Community 107 - "units/catalog.ts"
Cohesion: 0.11
Nodes (15): CustomUnitAliasRecord, UnitAliasesModel, UnitAliasRecord, UnitDefinitionRecord, seedUnitCatalog(), UnitCatalog, normalizeSourceSystem(), suggestCanonicalUnits() (+7 more)

### Community 108 - "mqtt/auth.ts"
Cohesion: 0.08
Nodes (26): BACnetConfig, ConfigManagerEvents, FeatureToggles, IntervalConfig, LoggingConfig, ModbusConfig, ModbusConnectionConfig, MQTTConfig (+18 more)

### Community 109 - "ModbusAdapter"
Cohesion: 0.08
Nodes (7): DeviceMetrics, MetricsConfig, MetricsSummary, ModbusAdapter, ModbusAdapterConfig, ModbusDevice, IDeviceStatus

### Community 110 - "JobsFeature"
Cohesion: 0.22
Nodes (3): FeatureLogger, JobsFeature, JobExecutionData

### Community 111 - "units/index.ts"
Cohesion: 0.24
Nodes (18): getUnitCatalog(), convertUnit(), ConvertUnitResult, createUnitNormalizationInterceptor(), unitNormalizationInterceptor(), NO_UNIT_PLACEHOLDERS, normalizeReadingInPlace(), ProtocolMessage (+10 more)

### Community 112 - "StateManager"
Cohesion: 0.11
Nodes (5): getManagerStatus(), normalizeValue(), stableStringify(), StateManager, cloneDeep()

### Community 113 - "scripts"
Cohesion: 0.08
Nodes (25): scripts, build, build:admin, clean, copy:db-assets, copy:pipeline-assets, dev, dev:admin (+17 more)

### Community 115 - "RetryManager"
Cohesion: 0.12
Nodes (4): isRetryableError(), RetryManager, StateHelpersContext, RetryStateModel

### Community 116 - "DecodedPacket"
Cohesion: 0.11
Nodes (19): ABORT_REASONS, BacnetDecoder, BVLC_FUNCTIONS, CONFIRMED_SERVICES, decodeObjectIdentifier(), ERROR_CLASSES, ERROR_CODES, OBJECT_TYPES (+11 more)

### Community 117 - "Logger"
Cohesion: 0.09
Nodes (8): loadNativeBinding(), NativeIpcBinding, NativeIpcInstance, RustSocketServer, writeStr(), WorkerBackedSocketServer, Logger, SocketOutput

### Community 118 - "ActivityMonitor"
Cohesion: 0.08
Nodes (10): ActivityEvent, ActivityMonitor, activityMonitor, CompressionSnapshot, displayEndpointName(), displayNameCache, EventRing, PointHistorySample (+2 more)

### Community 119 - "NetworkView.vue"
Cohesion: 0.06
Nodes (35): activeTab, applyFirewallMode(), drawerOpen, editingRule, firewallColumns, firewallData, firewallDisableConfirmationOpen, firewallIsActive (+27 more)

### Community 120 - "infra.ts"
Cohesion: 0.05
Nodes (53): express, authenticate(), parseCookie(), dataExplorerViewsRouter, SavedViewResponse, setLogger(), isHealthCheckPath(), isSilentDebugPath() (+45 more)

### Community 122 - "BaseFeature"
Cohesion: 0.14
Nodes (4): BaseFeature, FeatureConfig, FeatureLogger, MqttConnection

### Community 123 - "SourceDrawer.vue"
Cohesion: 0.03
Nodes (77): TopicNode, DeviceCandidateStrategy, DeviceDiscoveryPreview, OPCUABrowseNode, OPCUADeviceIdentification, sourcesApi, SourceTestRegisterResult, SourceTestResult (+69 more)

### Community 124 - "configured-points.ts"
Cohesion: 0.07
Nodes (30): ConfiguredEndpoint, ConfiguredPointRow, configuredPointsRouter, findAssociatedDevice(), getConfiguredPointRows(), isDeferred(), isRecord(), mqttFieldName() (+22 more)

### Community 125 - "steps"
Cohesion: 0.06
Nodes (34): concurrency, cancel-in-progress, group, env, ACCT, FORCE_JAVASCRIPT_ACTIONS_TO_NODE24, GH_REPO, GH_TOKEN (+26 more)

### Community 126 - "TcpAssembler"
Cohesion: 0.16
Nodes (9): CapturedPacket, FlowId, FlowState, TcpAssembler, TcpAssemblerOptions, TcpStreamHandler, CloseEvent, DataEvent (+1 more)

### Community 127 - "OpcUaReader"
Cohesion: 0.13
Nodes (9): ALLOWED_CHUNKS, OpcUaReader, CONNECTION_MSG_TYPES, MESSAGE_TYPE_NAMES, MIN_MESSAGE_SIZES, OpcuaDecoder, OpcuaDecoderConfig, STATUS_CODE_NAMES (+1 more)

### Community 128 - "forecaster.ts"
Cohesion: 0.08
Nodes (27): calculatePredictionConfidence(), calculateTrendDirection(), calculateTrendStrength(), calculateTrendThreshold(), EMA_PREDICTOR_LOOKBACK, EMAPredictor, estimateLinearTimeToThreshold(), estimateLinearTimeToThresholdResult() (+19 more)

### Community 129 - "MqttUsersTab.vue"
Cohesion: 0.06
Nodes (33): columns, confirmDelete(), createForm, createOpen, creating, deleteUser(), deleting, load() (+25 more)

### Community 130 - "CaptureEngine"
Cohesion: 0.09
Nodes (8): CaptureEngine, CaptureInterfaceError, CaptureStartOptions, createLogger(), createPcapHeader(), createPcapRecord(), decodeFrame(), packet29

### Community 131 - "pipeline.service.ts"
Cohesion: 0.10
Nodes (17): pendingTransforms, pipelineEvents, PipelineService, DeviceFilterConfig, PIPELINE_ALLOWED_NODE_TYPES, PipelineFlow, PipelineFlowNode, PipelineInConfig (+9 more)

### Community 132 - "DevicePublish"
Cohesion: 0.08
Nodes (4): AgentEventInput, DeviceContext, DevicePublishConfig, DevicePublish

### Community 133 - "iotctl.ts"
Cohesion: 0.15
Nodes (20): CommandGroup, CommandHandler, CommandMap, humanBytes(), pipelineAdd(), pipelineList(), pipelineRemove(), pipelineSet() (+12 more)

### Community 134 - "compilerOptions"
Cohesion: 0.07
Nodes (26): compilerOptions, outDir, rootDir, exclude, extends, include, compilerOptions, allowJs (+18 more)

### Community 135 - "with"
Cohesion: 0.09
Nodes (23): with, build-args, cache-from, cache-to, context, creds, fetch-depth, file (+15 more)

### Community 136 - "dependencies"
Cohesion: 0.09
Nodes (22): dependencies, bcryptjs@^3.0.3, dockerode@^4.0.2, express@^4.18.2, @influxdata/influxdb-client@~1.33.2, mqtt@^5.14.1, mqtt-pattern@^2.0.0, msgpack-lite@^0.1.26 (+14 more)

### Community 137 - "DeviceDataPoint"
Cohesion: 0.05
Nodes (39): 10. Legacy compatibility and preservation, 11. Catalog, SQLite, admission and contention blockers, 12. Proposed test matrix, 13. Proposed implementation slices and review gates, 14. Operational risks, diagnostics and rollback, 15. Verification performed for this design, 16. Open decisions and explicit approval gate, 1. Executive summary and scope (+31 more)

### Community 138 - "jobs/types.ts"
Cohesion: 0.12
Nodes (16): ActionCommandInputSchema, ActionHandlerInputSchema, ActionType, RUN_COMMAND, RUN_HANDLER, JobActionSchema, JobCondition, JobConditionSchema (+8 more)

### Community 139 - "device.model.ts"
Cohesion: 0.14
Nodes (14): anomalyMetricResultKey(), deleteDevice(), getAvailableAnomalyMetrics(), getDevice(), getDevices(), setDeviceEnabled(), updateDevice(), Device (+6 more)

### Community 141 - "BaseMqttClient"
Cohesion: 0.08
Nodes (5): BaseMqttClient, applyTopicTemplate(), AwsIotClient, applyTopicTemplate(), GcpIotClient

### Community 142 - "normalization-health-tracker.ts"
Cohesion: 0.20
Nodes (7): getNormalizationHealthTracker(), keyFor(), NormalizationHealthSummary, NormalizationHealthTracker, NormalizationIssueSummary, resetNormalizationHealthTrackerForTests(), TrackedIssue

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
Cohesion: 0.04
Nodes (48): addEntry(), assetPath, close(), copiedUuid, Device, emit, loadingPoints, metadataEntries (+40 more)

### Community 149 - "Phase 2C-1: durable point identity integration design"
Cohesion: 0.14
Nodes (14): 10. Independently reviewable implementation plan, 11. Proposed regression matrix, 12. Unresolved decisions and risks, 13. Explicit approval gates, 1. Executive summary, 3. Phase 2B execution verification, 4. Proposed internal catalog contract, 6. Legacy reconciliation decision table (+6 more)

### Community 150 - "opcua/discovery.ts"
Cohesion: 0.09
Nodes (18): MetadataModel, resolveUnitFromDescription(), OPCUADeviceIdentification, cacheKey(), clearDiscoveryCache(), computeStructuralHash(), DiscoveryCache, DiscoveryCacheEntry (+10 more)

### Community 151 - "AgentFirewall"
Cohesion: 0.12
Nodes (10): CreateFirewallRule, FirewallRule, FirewallRuleAction, FirewallRuleModel, FirewallRuleRow, UpdateFirewallRule, validateAction(), Rule (+2 more)

### Community 152 - "FeatureInitializer"
Cohesion: 0.13
Nodes (4): setCaptureEngine(), setDevicePublish(), setFirewall(), FeatureInitializer

### Community 153 - "TerminalView.vue"
Cohesion: 0.14
Nodes (15): CLI_COMMANDS, Cmd, CmdGroup, cmdSearch, connect(), ConnState, connState, containerEl (+7 more)

### Community 154 - "canonical-address.ts"
Cohesion: 0.13
Nodes (30): AddressProvenance, bacnet(), BacnetAddressInput, bacnetTypeNumbers, bacnetTypes, canonicalizeAddress(), canonicalizeModbusAddresses(), integer() (+22 more)

### Community 155 - "buildCommands"
Cohesion: 0.26
Nodes (16): adaptersAdd(), adaptersDisable(), adaptersEnable(), adaptersList(), adaptersRemove(), adaptersShow(), deriveState(), formatConnection() (+8 more)

### Community 156 - "build-agent-ci.yml"
Cohesion: 0.18
Nodes (10): concurrency, cancel-in-progress, group, env, FORCE_JAVASCRIPT_ACTIONS_TO_NODE24, name, on, push (+2 more)

### Community 157 - "asset.model.ts"
Cohesion: 0.14
Nodes (13): addAssetMetric(), createAsset(), deleteAsset(), getAsset(), listAssets(), removeAssetMetric(), updateAsset(), AssetMetric (+5 more)

### Community 158 - "src/api/network.ts"
Cohesion: 0.08
Nodes (23): getCaptureEngine(), getFirewall(), persistFirewallMode(), attachCaptureHandler(), decodePacket(), firewallModeUpdateQueue, getDockerPorts(), getSystemPorts() (+15 more)

### Community 159 - "startMemoryMonitoring"
Cohesion: 0.28
Nodes (20): bytesToMB(), calculateExternalGrowthRate(), calculateHeapGrowthRate(), calculateHeapTotalGrowthRate(), calculateMallocedGrowthRate(), calculateSurvivorGrowthRate(), detectLeakPattern(), getAdaptiveExternalThreshold() (+12 more)

### Community 160 - "BrokerMonitorService"
Cohesion: 0.09
Nodes (8): BrokerMetrics, BrokerMonitorService, BrokerStatus, JSONSchema, RateSample, SchemaGenerator, TopicHistoryEntry, TopicNode

### Community 161 - "Publish Pipeline Architecture"
Cohesion: 0.07
Nodes (26): Activity Monitor, Bounded Batch Size (Anti-Snowball), buildPayload() — CAUTION: Format Mismatch, Common Failure Modes, Compression Options, End-to-End Data Flow, IPC buffer-full disconnects, IPC Server (modules/ipc/) (+18 more)

### Community 163 - "SocketConnection"
Cohesion: 0.18
Nodes (7): RuntimeSnapshot, SocketConnection, DeviceState, CONNECTED, CONNECTING, DISCONNECTED, ERROR

### Community 164 - ".debug"
Cohesion: 0.18
Nodes (5): blankRecord(), DiagnosableSession, fmt(), OpcuaDeviceDiagnosticRecord, OpcuaStartupDiagnostics

### Community 165 - "getDatabase"
Cohesion: 0.06
Nodes (34): 2. Verified implementation and baseline, clearAnomalyBaselines(), getAnomalyBaselines(), getDbStats(), ANOMALY_SOURCES, eventsRouter, stripDeviceUuidSuffix(), VALID_RESOLUTION_REASONS (+26 more)

### Community 166 - "volume-manager.ts"
Cohesion: 0.10
Nodes (31): buildContainerSecurityOptions(), ResourceRecreationAttemptError, acquireNetworkLock(), checkNetworkCollisions(), create(), ensureAgentNetwork(), get(), getAll() (+23 more)

### Community 168 - "ShellHandler"
Cohesion: 0.26
Nodes (4): ShellCommand, ShellHandler, ShellHandlerOptions, verifyCommandSignature()

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

### Community 175 - "decoders/index.ts"
Cohesion: 0.15
Nodes (11): DnsDecoder, RCODES, RECORD_TYPES, HttpDecoder, DecoderRegistry, getDecoderRegistry(), PacketMeta, ProtocolDecoder (+3 more)

### Community 177 - "energy-recommendation.model.ts"
Cohesion: 0.23
Nodes (7): listEnergyRecommendations(), updateEnergyRecommendationStatus(), EnergyRecommendation, EnergyRecommendationEvalResult, EnergyRecommendationModel, EnergyRecommendationRow, EnergyRecommendationStatus

### Community 180 - "MessageBufferSync"
Cohesion: 0.15
Nodes (7): Design summary, Minimal implementation approach, Proposed control states, Proposed Solution, Why this fits existing code patterns, BufferAdmissionDecision, MessageBufferSync

### Community 181 - "anomaly/buffer.ts"
Cohesion: 0.13
Nodes (21): calculateSeverity(), createAnomalyAlert(), createId(), addToBuffer(), getBufferStats(), getIQR(), getMAD(), getMedian() (+13 more)

### Community 182 - "SourceConnectionFields.vue"
Cohesion: 0.13
Nodes (13): emit, get(), modelOptions, onModelChange(), props, selectedModel, selectedVendor, set() (+5 more)

### Community 183 - "setup_remote_access.sh"
Cohesion: 0.45
Nodes (14): check_requirements(), configure_cloud_server(), configure_cloud_sshd(), generate_ssh_key(), main(), print_banner(), print_error(), print_info() (+6 more)

### Community 184 - "publish-subscriptions.model.ts"
Cohesion: 0.12
Nodes (12): createPublishSubscription(), deletePublishSubscription(), listPublishSubscriptions(), updatePublishSubscription(), MlDatasetModel, PublishPayloadFormat, PublishSubscriptionRoute, PublishSubscriptionRow (+4 more)

### Community 185 - "AppMarketplaceModel"
Cohesion: 0.26
Nodes (4): MarketplaceImage, AppMarketplaceModel, TemplateRow, template

### Community 186 - "AnomalyInjectionSimulation"
Cohesion: 0.15
Nodes (4): AnomalyInjectionSimulation, AnomalyBaselineRecord, AnomalySimulationConfig, AnomalySimulationService

### Community 189 - "install.sh"
Cohesion: 0.19
Nodes (21): configure_mosquitto_file_auth(), generate_password(), generate_systemd_unit(), has_interactive_tty(), install_docker_if_needed(), install_mosquitto_if_needed(), installer_exit(), installer_message() (+13 more)

### Community 191 - "MqttUserModel"
Cohesion: 0.27
Nodes (4): MqttUser, MqttUserModel, MqttUserRow, parseRow()

### Community 192 - "schema-drift-rule.model.ts"
Cohesion: 0.29
Nodes (4): DriftRuleRow, parseRow(), SchemaDriftRuleModel, DriftRuleConfig

### Community 193 - "JobEngine"
Cohesion: 0.22
Nodes (6): JobEngine, ActionCommandInput, ActionHandlerInput, ActionResult, JobAction, JobResult

### Community 194 - "RustOpcuaSubscriber"
Cohesion: 0.13
Nodes (7): isRustOpcuaAvailable(), loadNativeBinding(), NativeSubscriberBinding, NativeSubscriberInstance, NodeConfig, RustOpcuaSubscriber, SubscriberConfig

### Community 195 - "schema-drift-rule-template.model.ts"
Cohesion: 0.35
Nodes (4): DriftRuleTemplate, parseRow(), SchemaDriftRuleTemplateModel, TemplateRow

### Community 196 - "handleServiceMenu"
Cohesion: 0.13
Nodes (20): addService(), approveImageUpdate(), cloneService(), confirmRemoveService(), deployTemplate(), deployTemplateAsNewApp(), emptyService(), envToRows() (+12 more)

### Community 197 - "overrides"
Cohesion: 0.14
Nodes (14): overrides, brace-expansion, @grpc/grpc-js, handlebars, ip-address, jsrsasign, path-to-regexp, picomatch (+6 more)

### Community 199 - "AdapterInitializer"
Cohesion: 0.24
Nodes (3): AdapterInitializer, resumeLeakDetection(), suppressLeakDetection()

### Community 200 - "docker"
Cohesion: 0.17
Nodes (12): name, needs, permissions, runs-on, docker, publish, permissions, contents (+4 more)

### Community 201 - "steps"
Cohesion: 0.30
Nodes (12): steps, steps, steps, id, if, name, run, shell (+4 more)

### Community 202 - "recommendation-publish-settings.model.ts"
Cohesion: 0.23
Nodes (7): getRecommendationPublishSettings(), updateRecommendationPublishSettings(), DEFAULTS, RecommendationPublishModule, RecommendationPublishSettings, RecommendationPublishSettingsModel, RecommendationPublishSettingsRow

### Community 203 - "iptables.ts"
Cohesion: 0.13
Nodes (18): castArray(), applyRules(), build(), ChainBuilder, convertToRestoreRulesFormat(), getDefaultRuleAdaptor(), getRulePosition(), iptablesRestoreAdaptor() (+10 more)

### Community 204 - "jobs/monitor.ts"
Cohesion: 0.25
Nodes (6): CloudJob, JobsConfig, JobsOptions, JobStatusUpdate, JobDocument, JobsMqttClient

### Community 205 - "validation.ts"
Cohesion: 0.23
Nodes (10): isEmpty(), isObject(), checkBooleanish(), checkFalsey(), CheckIntOptions, checkTruthy(), FALSEY, TRUTHY (+2 more)

### Community 206 - "opcua/device-identity.ts"
Cohesion: 0.13
Nodes (16): DeviceCandidateResult, DeviceCandidateStrategy, DeviceCandidateStrategySchema, DiscoveryPoint, DiscoverySnapshot, generateDeviceCandidates(), objectPathKey(), parseTemplate() (+8 more)

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

### Community 212 - "Phase 2 design: durable source-scoped point identity"
Cohesion: 0.12
Nodes (17): 10. Regression plan and required fixtures, 11. Risks and unresolved decisions, 1. Executive summary, 3. Existing identity dependency map, 4. Proposed additive SQLite schema, 5. Canonical protocol addresses, 6. Legacy reconciliation, 7. Migration, lifecycle and rollback (+9 more)

### Community 213 - "plugin-loader.ts"
Cohesion: 0.16
Nodes (8): BUILT_IN_PROTOCOLS, EXTERNAL_PLUGIN_API_VERSION, ExternalPluginContext, ExternalPluginDefinition, ExternalPluginModule, PluginLoader, ExternalPluginManifest, ProtocolAdapterStarter

### Community 214 - "graphify.yml"
Cohesion: 0.09
Nodes (22): concurrency, cancel-in-progress, group, env, GRAPHIFY_OUT, jobs, update-graph, name (+14 more)

### Community 215 - "OpcuaPerfMonitor"
Cohesion: 0.22
Nodes (4): batchStats(), EndpointCounters, OpcuaPerfMonitor, rate()

### Community 216 - "doAction"
Cohesion: 0.67
Nodes (4): actionKey(), doAction(), isInFlight(), isServiceBusy()

### Community 217 - "publish.ts"
Cohesion: 0.42
Nodes (9): getFlag(), hasFlag(), normalizeTopicsForDisplay(), parseCsv(), publishDestinationsList(), publishMqttAdd(), publishSubscriptionsAdd(), publishSubscriptionsList() (+1 more)

### Community 218 - "schema-drift.ts"
Cohesion: 0.27
Nodes (10): formatValue(), humanMs(), KNOWN_FIELDS, OPERATOR_FIELDS, printConfig(), schemaDriftGet(), schemaDriftResetAdvanced(), schemaDriftSet() (+2 more)

### Community 219 - "package"
Cohesion: 0.20
Nodes (10): arch, deb_arch, package, include, name, needs, runs-on, strategy (+2 more)

### Community 223 - "version"
Cohesion: 0.22
Nodes (9): version, on, push, workflow_dispatch, tags, description, required, type (+1 more)

### Community 224 - "app.ts"
Cohesion: 0.24
Nodes (7): setHealthReporter(), agent, gracefulShutdown(), hasSystemdWatchdog(), health, markFatalAndRecover(), stopWatchdog

### Community 225 - "BacnetPropertyId"
Cohesion: 0.22
Nodes (9): BacnetPropertyId, DESCRIPTION, MODEL_NAME, OBJECT_LIST, OBJECT_NAME, PRESENT_VALUE, PRIORITY_ARRAY, UNITS (+1 more)

### Community 226 - "connectLogs"
Cohesion: 0.25
Nodes (8): clearLogs(), connectLogs(), fullApp(), openAppLogs(), openLogs(), parseLogLine(), switchService(), toggleFollow()

### Community 227 - "CLIError"
Cohesion: 0.22
Nodes (20): appsInfo(), appsPurge(), appsRestart(), appsStart(), appsStop(), configSetApi(), devicesList(), discover() (+12 more)

### Community 228 - "build"
Cohesion: 0.25
Nodes (8): name, needs, outputs, runs-on, build, agent_version, cli_version, sha_short

### Community 229 - "docker"
Cohesion: 0.25
Nodes (8): name, needs, permissions, runs-on, docker, actions, contents, security-events

### Community 230 - "jobs"
Cohesion: 0.25
Nodes (7): concurrency, cancel-in-progress, group, env, FORCE_JAVASCRIPT_ACTIONS_TO_NODE24, jobs, name

### Community 232 - "shared/http-client.ts"
Cohesion: 0.18
Nodes (4): CompressionStats, HttpClientOptions, HttpError, HttpResponse

### Community 233 - "JobStatus"
Cohesion: 0.25
Nodes (8): JobStatus, CANCELED, FAILED, IN_PROGRESS, QUEUED, REJECTED, SUCCEEDED, TIMED_OUT

### Community 234 - "connectWs"
Cohesion: 0.24
Nodes (13): cancelPacketFlush(), captureWsUrl(), clearCapture(), connectWs(), disconnectWs(), formatCaptureInterface(), handleInterfaceChange(), loadInterfaces() (+5 more)

### Community 235 - "admin/package.json"
Cohesion: 0.17
Nodes (14): devDependencies, @playwright/test@^1.65.0, typescript@^5.7.2, vite@^6.0.11, @vitejs/plugin-vue@^5.2.1, vue-tsc@^2.2.0, typescript, name (+6 more)

### Community 236 - "modbus/types.ts"
Cohesion: 0.05
Nodes (36): zod@^3.22.0, zod, ByteOrder, ABCD, BADC, CDAB, DCBA, Endianness (+28 more)

### Community 237 - "OpcUaFramer"
Cohesion: 0.18
Nodes (4): FramedMessage, ProtocolFramer, OpcUaFramer, VALID_MSG_TYPES

### Community 238 - "resolveState"
Cohesion: 0.33
Nodes (6): resolveState(), stateColor(), stateLabel(), summaryForApp(), totalRunning, totalStopped

### Community 239 - "🔍 Protocol Discovery"
Cohesion: 0.29
Nodes (7): Best Practices, Configuration, Discovered Device Storage, Discovery Features, Discovery Schedule, 🔍 Protocol Discovery, Two-Phase Discovery Architecture

### Community 240 - "version"
Cohesion: 0.33
Nodes (6): version, tag, version, name, outputs, runs-on

### Community 241 - "dependencies"
Cohesion: 0.13
Nodes (15): dependencies, @ant-design/icons-vue@^7.0.1, ant-design-vue@^4.2.6, axios@^1.7.9, device-agent@file:.., vue@^3.5.13, vue-router@^4.5.0, @xterm/addon-fit@^0.11.0 (+7 more)

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
Cohesion: 0.06
Nodes (19): mergePinnedDataExplorerPoints(), builtInTabs, DataExplorerTabs, restoreDataExplorerTabs(), getLocalLanNetworks(), ipv6NetworkCidr(), LocalLanNetworks, RFC-1918 (+11 more)

### Community 247 - "cleanup.sh"
Cohesion: 0.70
Nodes (4): ok(), cleanup.sh script, skip(), warn()

### Community 248 - "smoke.sh"
Cohesion: 0.70
Nodes (4): auth(), fail(), smoke.sh script, step()

### Community 249 - "identity.ts"
Cohesion: 0.21
Nodes (10): Ingestion, naming and enrichment, Backend limitations and follow-up, Point picker identity limitations, computeProvisionalPointId(), computeShortHash(), naturalKey(), RFC-4122, uuidv5() (+2 more)

### Community 250 - "upload-azure"
Cohesion: 0.40
Nodes (5): upload-azure, if, name, needs, runs-on

### Community 251 - "test-provisioning-skip.sh"
Cohesion: 0.90
Nodes (4): check_provisioning_status(), reset_provisioning(), test-provisioning-skip.sh script, simulate_provisioning()

### Community 252 - ".resolveMqttPointIdentities"
Cohesion: 0.24
Nodes (5): matchesOpcuaConfiguration(), OpcuaIdentityState, MqttReadingEvidence, OpcuaNamespaceEvidence, MqttSelector

### Community 253 - "SKILL.md"
Cohesion: 0.13
Nodes (14): Admin UI, Authenticate and call API, Build, CLI via docker exec, Deploy, Full smoke test, Gotchas, Key API endpoints (+6 more)

### Community 254 - "UserModel"
Cohesion: 0.25
Nodes (5): parseRow(), User, UserModel, UserRole, UserRow

### Community 255 - "MqttPublishPlugin"
Cohesion: 0.20
Nodes (3): R3 MQTT Publisher (src/publish/plugins/mqtt.ts), PayloadChunkCalculator, MqttPublishPlugin

### Community 256 - "write_reading_json"
Cohesion: 0.35
Nodes (7): BufReader, BufReader<'a>, decode_batch_to_json(), write_json_escaped(), write_json_key_str(), write_opt_field(), write_reading_json()

### Community 257 - "@playwright/test"
Cohesion: 0.15
Nodes (3): pages, adminPassword, @playwright/test

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
Cohesion: 0.13
Nodes (14): 1. Durable MQTT message spool, 2. Durable endpoint telemetry spool with claim-before-publish semantics, 3. Durable CloudSync report queue, 4. In-memory MQTT pending publish queue, 5. Cloud log buffering and disk spool, Bottom Line, CloudSync state reports, Current State Transport Flow (+6 more)

### Community 265 - "opcua/package.json"
Cohesion: 0.17
Nodes (12): devDependencies, @napi-rs/cli@^2.18.0, @napi-rs/cli, main, name, napi, name, private (+4 more)

### Community 266 - "publish/package.json"
Cohesion: 0.17
Nodes (12): devDependencies, @napi-rs/cli@^2.18.0, @napi-rs/cli, main, name, napi, name, private (+4 more)

### Community 278 - "api/license.ts"
Cohesion: 0.40
Nodes (4): licenseApi, LicenseState, LicenseStatus, LicenseTier

### Community 279 - "restartAgent"
Cohesion: 0.40
Nodes (5): confirmRestart(), load(), pollReadiness(), provision(), restartAgent()

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

### Community 294 - "points/interceptor.ts"
Cohesion: 0.22
Nodes (9): getPointNameCatalog(), resetPointNameCatalogForTests(), attachIdentity(), createPointNameNormalizationInterceptor(), pointNameNormalizationInterceptor(), ProtocolMessage, mockedModel, mockedModel (+1 more)

### Community 295 - "IoTistic CPU profiling — Raspberry Pi to Windows"
Cohesion: 0.25
Nodes (7): 1. On Raspberry Pi: verify watchdog is off, 2. On Raspberry Pi: create profiler script (once), 3. On Raspberry Pi: enable Inspector and capture, 4. On Windows PowerShell: copy to Downloads, 5. On Windows: verify and upload, 6. Restore watchdog after testing, IoTistic CPU profiling — Raspberry Pi to Windows

### Community 296 - "update.ts"
Cohesion: 0.50
Nodes (3): updateApi, UpdateCheckResult, UpdateTriggerResult

### Community 298 - "submitEditAlias"
Cohesion: 0.67
Nodes (3): closeEditAlias(), loadCustomAliases(), submitEditAlias()

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

### Community 306 - "opcua-decoder.unit.spec.ts"
Cohesion: 0.24
Nodes (7): buildAbort(), buildERR(), buildHEL(), buildOPN(), buildRHE(), META, writeOpcUaString()

### Community 307 - "DestinationConfigFields.vue"
Cohesion: 0.27
Nodes (9): cfg, emit, getMaxPayloadSizeValue(), handleUnitChange(), maxPayloadSizeUnit, props, set(), setIn() (+1 more)

### Community 308 - "confidence-policy.ts"
Cohesion: 0.46
Nodes (3): unitCheck(), assessUnitConfidence(), UNIT_PROVENANCE_CONFIDENCE

### Community 309 - "MQTT Device-Write Commands"
Cohesion: 0.18
Nodes (10): Architecture, Command schema, Enabling it, MQTT Device-Write Commands, MQTT topics, Point name rules, Result schema, Security note (+2 more)

### Community 310 - "docker-image-usage.ts"
Cohesion: 0.47
Nodes (4): AppWithServices, DockerImageUsage, getDockerImageUsageByApp(), normalizeImageReference()

### Community 313 - "points/catalog.ts"
Cohesion: 0.35
Nodes (7): CatalogMetrics, InternalMapping, buildNormalizedPointName(), COMBINING_MARKS, normalizePointName(), CURRENT_POINT_NAME_RULES_VERSION, PointNameProvenance

### Community 314 - "cgroups.sh"
Cohesion: 0.83
Nodes (3): die(), say(), cgroups.sh script

### Community 315 - "services"
Cohesion: 0.50
Nodes (3): command, services, agent

### Community 316 - "Security Policy"
Cohesion: 0.50
Nodes (3): Reporting a Vulnerability, Security Policy, Supported Versions

### Community 317 - "utils/network.ts"
Cohesion: 0.38
Nodes (10): autoDetectLocalSubnets(), getNetworkErrorType(), intToIpv4(), ipv4ToInt(), isConnectionRefused(), isDnsError(), isNetworkUnreachable(), isRetryableNetworkError() (+2 more)

### Community 320 - "influxdb.ts"
Cohesion: 0.13
Nodes (8): applyNumericField(), CustomPayload, InfluxDbConfig, InfluxDbNoopClient, InfluxDbPublishPlugin, isTagsPayload(), loadConfig(), TagsPayload

### Community 322 - "opcua-shadow-evidence.unit.spec.ts"
Cohesion: 0.20
Nodes (5): good, MockClient, start(), tick(), waitForCount()

### Community 323 - "SchemaViewer.vue"
Cohesion: 0.24
Nodes (7): JSONSchema, fieldCount, fields, flattenSchema(), props, SchemaField, TYPE_COLORS

### Community 330 - "discovery-blocklist.model.ts"
Cohesion: 0.33
Nodes (3): runDiscoveryWithPruneResult(), BlockedDevice, DiscoveryBlocklistModel

### Community 332 - "mqtt-shadow-evidence.unit.spec.ts"
Cohesion: 0.31
Nodes (7): agentLogger, config(), create(), inspect(), logger, send(), tick()

### Community 333 - "interfaces.ts"
Cohesion: 0.29
Nodes (7): systeminformation@^5.31.7, systeminformation, getFirewallInterfaceOptions(), getNetworkInterfaces(), NetworkInterfaceInfo, NetworkInterfaceOption, SystemMetrics

### Community 336 - "scripts"
Cohesion: 0.33
Nodes (6): scripts, build, dev, preview, test:e2e, test:e2e:ui

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
- **85 isolated node(s):** `PATH`, `ipc`, `Data`, `Stop`, `opcua-subscriber` (+80 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 3640 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **73 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `AgentLogger` connect `AgentLogger` to `publish/core/types.ts`, `actions.ts`, `pipeline.service.ts`, `CaptureEngine`, `DevicePublish`, `CloudSync`, `commands-e2e.integration.spec.ts`, `BACnetDiscovery`, `BaseMqttClient`, `plugins/index.ts`, `AzureIotClient`, `core/index.ts`, `.warnSync`, `ConfigManager`, `codec.ts`, `AgentFirewall`, `MqttDiscovery`, `opcua/discovery.ts`, `LogComponents`, `plugins/index.ts`, `detectors.ts`, `.infoSync`, `FetchHttpClient`, `CloudLogBackend`, `WireGuardManager`, `CloudMqttClient`, `ShellHandler`, `container-manager.ts`, `Agent`, `QuarantineStore`, `runtime.ts`, `MessageBufferSync`, `anomaly/buffer.ts`, `maintenance/service.ts`, `ContainerManager`, `AnomalyInjectionSimulation`, `CloudSync`, `docker-manager.ts`, `JobEngine`, `DockerDriver`, `ShellMqttClient`, `sqlite.ts`, `anomaly/types.ts`, `BaseHttpClient`, `memory.ts`, `jobs/monitor.ts`, `ContainerService`, `plugin-loader.ts`, `OfflineQueue`, `AnomalyDetectionService`, `anomaly/service.ts`, `CredentialManager`, `PublishDestinationsModel`, `BaseOrchestratorDriver`, `.discover`, `compress.ts`, `mqtt/auth.ts`, `StateManager`, `RetryManager`, `infra.ts`, `BaseFeature`, `MqttPublishPlugin`?**
  _High betweenness centrality (0.137) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `getDatabase()` (e.g. with `2. Verified implementation and baseline` and `4. Proposed internal catalog contract`) actually correct?**
  _`getDatabase()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `PATH`, `ipc`, `Data` to the rest of the system?**
  _85 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `AgentLogger` be split into smaller, more focused modules?**
  _Cohesion score 0.04202174551866 - nodes in this community are weakly interconnected._
- **Why does `vue` connect `AppLayout.vue` to `MqttUsersTab.vue`, `AnomalyView.vue`, `ContainersView.vue`, `AssetsView.vue`, `SettingsView.vue`, `NormalizationHealthDrawer.vue`, `DiscoveryRuleDrawer.vue`, `useSystemStats.ts`, `DataExplorer.vue`, `DeviceDrawer.vue`, `TerminalView.vue`, `DestinationsView.vue`, `LogsView.vue`, `DriftRuleDrawer.vue`, `PointPickerModal.vue`, `SubscriptionDrawer.vue`, `SparklineChart.vue`, `AlertsView.vue`, `SourcesView.vue`, `DestinationConfigFields.vue`, `CreateViewDrawer.vue`, `SourceConnectionFields.vue`, `UsersView.vue`, `MaintenanceRuleDrawer.vue`, `DashboardView.vue`, `DiscoveryDrawer.vue`, `CreateDatasetDrawer.vue`, `SchemaViewer.vue`, `data-explorer-point-key.ts`, `MarketplaceCatalog.vue`, `api/mqtt.ts`, `MessageViewer.vue`, `CaptureTab.vue`, `containers.ts`, `PointsTable.vue`, `BackupsView.vue`, `admin/package.json`, `dependencies`, `NetworkView.vue`, `SourceDrawer.vue`?**
  _High betweenness centrality (0.079) - this node is a cross-community bridge._
- **Are the 4 inferred relationships involving `PublishManager` (e.g. with `Anomaly, persistence, publishing and views` and `Phase 2C-4: internal resolution`) actually correct?**
  _`PublishManager` has 4 INFERRED edges - model-reasoned connections that need verification._
- **Should `publish/core/types.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.03686396677050883 - nodes in this community are weakly interconnected._