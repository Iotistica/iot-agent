# Graph Report - iot-agent  (2026-11-09)

## Corpus Check
- Large corpus: 703 files · ~616,187 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder.

## Summary
- 8298 nodes · 19508 edges · 290 communities (232 shown, 58 thin omitted)
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 1550 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `065b8182`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- AgentLogger
- Logger
- actions.ts
- PublishManager
- AnomalyView.vue
- vue
- ContainersView.vue
- AssetsView.vue
- SettingsView.vue
- SchemaDriftDetector
- capture.ts
- commands-e2e.integration.spec.ts
- BACnetAdapter
- .debug
- plugins/index.ts
- types/index.ts
- DiscoveryRulesView.vue
- core/index.ts
- volume-manager.ts
- DataExplorer.vue
- .warnSync
- OPCUADeviceClient
- ConfigManager
- mqtt/manager.ts
- DiscoveryService
- detectors.ts
- DictionaryManager
- features.ts
- modbus/adapter.ts
- DestinationsView.vue
- DeviceDrawer.vue
- AnomalyInjectionSimulation
- points/catalog.ts
- DriftRuleDrawer.vue
- .infoSync
- PointPickerModal.vue
- MessageBufferModel
- SubscriptionDrawer.vue
- fixtures.ts
- MqttAdapter
- CloudLogBackend
- OPCUAAdapter
- CloudMqttClient
- models/index.ts
- container-manager.ts
- Agent
- core/manager.ts
- AnomalyDetectionService
- licensing/service.ts
- lib/errors.ts
- SourcesView.vue
- package.json
- DevicesView.vue
- maintenance/service.ts
- AnomalyFeed
- ContainerManager
- anomaly/service.ts
- UsersView.vue
- getDatabase
- CloudSync
- DashboardView.vue
- DiscoveryDrawer.vue
- CreateDatasetDrawer.vue
- steps
- containers/types.ts
- docker-manager.ts
- quality/index.ts
- DockerDriver
- forecaster.ts
- buildCommands
- MaintenanceEnergyService
- timescaledb.ts
- sqlite.ts
- StateManager
- BaseHttpClient
- memory.ts
- SubscriptionsView.vue
- system/metrics.ts
- publish-destinations.model.ts
- state-helpers.ts
- PointHistoryModal.vue
- MarketplaceCatalog.vue
- native-migrations.ts
- src/core.ts
- v1.ts
- migration-helpers.ts
- OfflineQueue
- BaseMqttClient
- containers.ts
- MessageViewer.vue
- CaptureTab.vue
- pipeline.service.ts
- backup.ts
- sync/index.ts
- PointsTable.vue
- anomaly/buffer.ts
- StateReporter
- BackupsView.vue
- app.ts
- PublishDestinationsModel
- BaseOrchestratorDriver
- BaseProtocolAdapter
- IOrchestratorDriver
- decoders/index.ts
- cli/package.json
- compilerOptions
- with
- AnomalyStorageService
- mqtt/auth.ts
- device-manager.unit.spec.ts
- JobsFeature
- units/index.ts
- MaintenanceRuleDrawer.vue
- scripts
- lib/http-client.ts
- RetryManager
- DecodedPacket
- MqttBrokerClient
- ActivityMonitor
- NetworkView.vue
- src/api/ml-datasets.ts
- DiscoveryRulesScheduler
- BaseFeature
- ModbusRegisterMapEditor.vue
- generate-agents.ps1
- AlertManager
- TcpAssembler
- OpcUaReader
- NormalizationHealthDrawer.vue
- MqttUsersTab.vue
- CaptureEngine
- units/catalog.ts
- admin/src/api/anomaly.ts
- iotctl.ts
- compilerOptions
- with
- dependencies
- SocketServer
- jobs/types.ts
- BrokerMonitorService
- BACnetDiscovery
- BaseMqttClient
- normalizeSourceSystem
- compilerOptions
- useSystemStats.ts
- compilerOptions
- agent
- deploy
- node-opcua-client.js
- OPCUADiscovery
- tableExists
- AgentFirewall
- opcua-decoder.unit.spec.ts
- admin/package.json
- api/mqtt.ts
- CLIError
- jobs
- FeatureInitializer
- iptables.ts
- MqttBrokerView.vue
- TerminalView.vue
- bacnet/discovery.ts
- FetchHttpClient
- SocketPublishClient
- SourceConnectionFields.vue
- 20260620010000_add_admin_users.ts
- network-manager.ts
- CustomUnitAliasesModel
- ShellHandler
- WireGuardManager
- SampleAdapter
- admin/src/api/network.ts
- commands/db.ts
- steps
- package-agent
- ref_node_sqlite
- anomaly-rule-template.model.ts
- energy-recommendation.model.ts
- maintenance-recommendation.model.ts
- Logger
- migration-types.ts
- NativeSqliteMigration
- OpcUaFramer
- setup_remote_access.sh
- PublishSubscriptionsModel
- AppMarketplaceModel
- UserModel
- broker-monitor.ts
- downloadCsv
- install.sh
- MqttUserModel
- schema-drift-rule.model.ts
- JobEngine
- MqttDecoder
- onTabChange
- imageToServiceForm
- overrides
- TopicTree.vue
- friendlyLabel
- docker
- steps
- recommendation-publish-settings.model.ts
- LocalLogBackend
- monitor.ts
- validation.ts
- @playwright/test
- load
- schema-drift-rule-template.model.ts
- AdapterInitializer
- CredentialManager
- utils/network.ts
- RetryPolicy
- devDependencies
- dashboard.ts
- SchemaViewer.vue
- handleServiceMenu
- publish.ts
- schema-drift.ts
- package
- EnergyRuleModel
- FirewallRuleModel
- MaintenanceRuleModel
- version
- drift-labels.ts
- BacnetPropertyId
- connectLogs
- logger
- build
- docker
- build-agent-release.yml
- AssetModel
- EndpointOutputModel
- JobStatus
- connectWs
- AssetMetricModel
- DataExplorerViewModel
- scripts
- resolveState
- poll
- version
- DockerNetwork
- rule-resolver.ts
- manifest.json
- timescaledb.unit.spec.ts
- anomalyTemplates.ts
- data-explorer-tabs.ts
- cleanup.sh
- smoke.sh
- CLILogger
- upload-azure
- test-provisioning-skip.sh
- DockerVolume
- RuleAction
- Logger
- loadTemplates
- saveConfig
- enable-memory-cgroups.sh
- add_certificate.sh
- cloud-sync/sync.ts
- 20260728030000_rename_opcua_alarms_to_protocol_alarms.ts
- SparklineChart.vue
- uniqueCategoryLabels
- update.sh
- 20260629000000_add_backup_schedule.ts
- 20260729000000_add_device_id_to_observed_metrics.ts
- 20260802000000_add_use_for_commands_to_publish_destinations.ts
- 20261012000000_add_data_explorer_views.ts
- external-modules.d.ts
- uninstall.sh
- cli-install.sh
- docker-entrypoint.sh
- build-deb.sh
- enable_ssl.sh
- install-dbus.sh
- start_wifi_connect.sh
- test-install-with-vpn.sh
- test-wireguard-client.sh

## God Nodes (most connected - your core abstractions)
1. `AgentLogger` - 251 edges
2. `getDatabase()` - 126 edges
3. `PublishManager` - 102 edges
4. `LogComponents` - 87 edges
5. `ContainerManager` - 79 edges
6. `CLIError` - 78 edges
7. `ConfigManager` - 76 edges
8. `buildCommands()` - 66 edges
9. `vue` - 61 edges
10. `AnomalyDetectionService` - 61 edges

## Surprising Connections (you probably didn't know these)
- `typescript@^5.7.2` --declares--> `typescript`  [EXTRACTED]
  admin/package.json → package.json
- `typescript@^5.9.3` --declares--> `typescript`  [EXTRACTED]
  cli/package.json → package.json
- `MockHttpClient` --implements--> `HttpClient`  [EXTRACTED]
  test/helpers/mock-http-client.ts → src/lib/http-client.ts
- `CloseEvent` --references--> `FlowId`  [EXTRACTED]
  test/unit/network/tcp-assembler.unit.spec.ts → src/network/tcp-assembler.ts
- `DataEvent` --references--> `FlowId`  [EXTRACTED]
  test/unit/network/tcp-assembler.unit.spec.ts → src/network/tcp-assembler.ts

## Import Cycles
- 2-file cycle: `src/containers/container-manager.ts -> src/containers/docker-manager.ts -> src/containers/container-manager.ts`

## Communities (290 total, 58 thin omitted)

### Community 0 - "AgentLogger"
Cohesion: 0.02
Nodes (85): DeviceAPI, DeviceAPIConstructOpts, DEFAULT_POLICY, DOCKER_POLICY, RetryPolicy, RetryState, RuntimeHealthContext, BACnetConfig (+77 more)

### Community 1 - "Logger"
Cohesion: 0.03
Nodes (59): mqtt, applyTopicTemplate(), AwsIotClient, AwsIotConfig, AwsPublishPlugin, loadAwsConfigFromEnv(), AzureIotConfig, AzurePublishPlugin (+51 more)

### Community 2 - "actions.ts"
Cohesion: 0.02
Nodes (108): addAssetMetric(), addEndpoint(), addService(), AgentInstance, anomalyMetricResultKey(), applyConfigUpdate(), approveImageUpdate(), buildDockerOptions() (+100 more)

### Community 3 - "PublishManager"
Cohesion: 0.03
Nodes (12): MlDatasetRecord, PublishDestinationRecord, MessageBatcher, CompressionInfo, compressionToOpts(), DeviceContext, HostBinding, PublishManager (+4 more)

### Community 4 - "AnomalyView.vue"
Cohesion: 0.02
Nodes (103): activeCategories, activeTab, advancedOpen, badActors, badActorsLoading, badActorsWindowDays, baselineColumns, BaselineRow (+95 more)

### Community 5 - "vue"
Cohesion: 0.03
Nodes (79): vue-router@^4.5.0, authApi, AuthUser, deviceApi, DeviceInfo, WritablePoint, WriteResult, { isDark } (+71 more)

### Community 6 - "ContainersView.vue"
Cohesion: 0.02
Nodes (85): actionInFlight, addSvcDrawerOpen, addSvcForm, addSvcSaving, addSvcSelectedImage, addSvcTargetApp, appDetailsName, appDetailsOpen (+77 more)

### Community 7 - "AssetsView.vue"
Cohesion: 0.02
Nodes (80): energyApi, maintenanceApi, assets, availableMetricOptions, buildConfig(), close(), DAYS, dutyCycle (+72 more)

### Community 8 - "SettingsView.vue"
Cohesion: 0.02
Nodes (83): licenseApi, LicenseState, LicenseStatus, LicenseTier, updateApi, UpdateCheckResult, UpdateTriggerResult, activeTab (+75 more)

### Community 9 - "SchemaDriftDetector"
Cohesion: 0.06
Nodes (37): collapseRedundantSuffix(), KNOWN_DEVICE_ACRONYMS, normalizeDeviceId(), normalizeSlug(), asRecord(), DEFAULT_OPTIONS, DeviceDriftState, DeviceSchema (+29 more)

### Community 10 - "capture.ts"
Cohesion: 0.04
Nodes (63): RFC-1918, express, ALERT_THRESHOLDS, SEVERITY_RANK, getCaptureEngine(), anomalyRouter, stripDeviceUuidSuffix(), stripMetricUuidPrefix() (+55 more)

### Community 11 - "commands-e2e.integration.spec.ts"
Cohesion: 0.06
Nodes (36): CommandDeduplicator, DedupEntry, CommandDestination, CommandError, createCommandFeature(), readConfigFromEnv(), MqttCommandConsumer, CommandResultPublisher (+28 more)

### Community 12 - "BACnetAdapter"
Cohesion: 0.04
Nodes (39): bacstack@^0.0.1-beta.14, zod@^3.22.0, bacstack, zod, BACnetAdapter, BACnetClient, BACnetReadResult, OBJECT_TYPE_MAP (+31 more)

### Community 13 - ".debug"
Cohesion: 0.07
Nodes (5): ModbusAdapter, ModbusClient, ModbusDevice, ModbusRegister, DeviceDataPoint

### Community 14 - "plugins/index.ts"
Cohesion: 0.06
Nodes (23): ClientRoutingRules, ClientSubscription, toDeviceUuid(), AdapterFeatures, AdapterConfig, AdapterManager, groupFieldNamesByOwningDevice(), resolveEnrichedDeviceName() (+15 more)

### Community 15 - "types/index.ts"
Cohesion: 0.03
Nodes (72): assetsApi, sourcesApi, SourceTestRegisterResult, SourceTestResult, addBinding(), addingBinding, bindingDeviceUuid, bindingMetric (+64 more)

### Community 16 - "DiscoveryRulesView.vue"
Cohesion: 0.03
Nodes (60): discoveryApi, DiscoveryOptions, discoveryRulesApi, bacnet, BACnetParams, buildParamsJson(), close(), DiscoveryRulePrefill (+52 more)

### Community 17 - "core/index.ts"
Cohesion: 0.06
Nodes (30): AgentManager, AgentInfo, ApiTlsConfig, AzurePublishingConfig, ConfigStep, IotisticaPublishingConfig, KeyExchangeRequest, KeyExchangeResponse (+22 more)

### Community 18 - "volume-manager.ts"
Cohesion: 0.05
Nodes (36): dockerode, InvalidNetworkNameError, ResourceRecreationAttemptError, Network, NetworkImpl, ComposeNetworkConfig, ComposeVolumeConfig, DockerNetworkConfig (+28 more)

### Community 19 - "DataExplorer.vue"
Cohesion: 0.03
Nodes (61): activateTab(), activeSavedView, activeTab, badCount, candidateDatasetPoints, candidateViewPoints, closeSavedView(), columns (+53 more)

### Community 20 - ".warnSync"
Cohesion: 0.08
Nodes (17): initVpnActions(), registerRuntimeHealthSubsystems(), detectOrchestrator(), attachLogsToContainer(), factoryReset(), initialized(), createLogger(), logSystemEvent() (+9 more)

### Community 21 - "OPCUADeviceClient"
Cohesion: 0.05
Nodes (26): ProtocolAlarmModel, ProtocolAlarmRow, createOPCUASession(), OPCUADeviceClient, OPCUADeviceClientOptions, OPCUAAdapterConfigSchema, OPCUACertificateTrustMode, OPCUACertificateTrustModeSchema (+18 more)

### Community 22 - "ConfigManager"
Cohesion: 0.07
Nodes (6): ConfigManager, ConfigReconciliationResult, DeviceConfig, ProtocolAdapterDevice, EndpointModel, cloneDeep()

### Community 23 - "mqtt/manager.ts"
Cohesion: 0.06
Nodes (43): msgpack-lite@^0.1.26, msgpack-lite, clearCodecCaches(), createJsonPayload(), createMsgpackPayload(), decodeCache, decodeHexId(), decodeUuid() (+35 more)

### Community 24 - "DiscoveryService"
Cohesion: 0.05
Nodes (10): modbus-serial@^8.0.17, modbus-serial, MetadataModel, DiscoveryStore, DiscoveryOptionsBuilder, DiscoveryService, ModbusDiscovery, MqttDiscovery (+2 more)

### Community 25 - "detectors.ts"
Cohesion: 0.08
Nodes (44): binaryConfidence(), CONFIDENCE_STRATEGY, exponentialConfidence(), getConfidence(), sigmoid(), getMethodsToRun(), runDetectionMethods(), RunDetectionMethodsInput (+36 more)

### Community 27 - "features.ts"
Cohesion: 0.07
Nodes (39): IncidentCorrelator, AnomalyOptions, loadSimulationConfig(), loadConfigFromTargetState(), setDiscoveryRulesScheduler(), BackupScheduler, isOpcuaFlow, logger (+31 more)

### Community 28 - "modbus/adapter.ts"
Cohesion: 0.04
Nodes (39): pLimit(), DeviceMetrics, MetricsConfig, MetricsSummary, ByteOrder, ABCD, BADC, CDAB (+31 more)

### Community 29 - "DestinationsView.vue"
Cohesion: 0.04
Nodes (50): destinationsApi, TestResult, settingsApi, cfg, emit, props, set(), setIn() (+42 more)

### Community 30 - "DeviceDrawer.vue"
Cohesion: 0.04
Nodes (53): LogLevel, LogMessage, logsApi, LogsFilter, LogSourceType, addEntry(), assetPath, close() (+45 more)

### Community 31 - "AnomalyInjectionSimulation"
Cohesion: 0.07
Nodes (17): AlertMetricState, AnomalyInjectionSimulation, normalizeSimulationMetrics(), PatternEvolutionPhase, PatternEvolutionState, SimulationMetricContext, SimulationOrchestrator, AnomalyBaselineRecord (+9 more)

### Community 32 - "points/catalog.ts"
Cohesion: 0.08
Nodes (31): mapRow(), PointNameMappingRecord, PointNameMappingRow, PointNameMappingsModel, baseKey(), CatalogMetrics, getPointNameCatalog(), InternalMapping (+23 more)

### Community 33 - "DriftRuleDrawer.vue"
Cohesion: 0.04
Nodes (50): adaptivePromotionBatches, adaptivePromotionMinElapsedMs, adaptiveRetireBatches, advancedActiveKey, alertCooldownMs, alertOnDriftTypes, alertSeverity, ALL_DRIFT_TYPES (+42 more)

### Community 35 - "PointPickerModal.vue"
Cohesion: 0.05
Nodes (47): ApiError, client, pointCatalogApi, PointCatalogEntry, CreateViewInput, SavedView, viewsApi, canSave (+39 more)

### Community 36 - "MessageBufferModel"
Cohesion: 0.08
Nodes (5): getBufferStatusPayload(), BufferAdmissionDecision, MessageBufferModel, MessageBufferSync, ExternalMqttFlushProxy

### Community 37 - "SubscriptionDrawer.vue"
Cohesion: 0.04
Nodes (47): subscriptionsApi, blankForm(), blankRoute(), buildIotisticaTopic(), close(), COMPRESSIONS, connSummary(), customIntervalUnit (+39 more)

### Community 38 - "fixtures.ts"
Cohesion: 0.06
Nodes (30): sinon, AgentState, HttpResponse, StatePoller, TargetStateResponse, createCompleteConfigScenario(), createConfigUpdateScenario(), createEmptyDeviceState() (+22 more)

### Community 39 - "MqttAdapter"
Cohesion: 0.08
Nodes (17): MQTT_UNIT_TO_CANONICAL, MqttAdapter, coerceType(), isBinaryPayload(), isUtf8(), parsePayload(), MqttAdapterConfig, MqttBrokerConfig (+9 more)

### Community 40 - "CloudLogBackend"
Cohesion: 0.08
Nodes (11): CloudLogBackend, LogSampler, SamplingRates, LogSpool, SpoolConfig, AckCursor, CloudLogBackendConfig, DroppedLogSummary (+3 more)

### Community 41 - "OPCUAAdapter"
Cohesion: 0.09
Nodes (12): OPCUAAdapter, OPCUAConnectionGroup, resolveUnitFromDescription(), OPCUASession, blankRecord(), DiagnosableSession, fmt(), OpcuaDeviceDiagnosticRecord (+4 more)

### Community 42 - "CloudMqttClient"
Cohesion: 0.08
Nodes (4): MqttPayload, CloudMqttClient, MqttRouter, SubscriptionHandler

### Community 43 - "models/index.ts"
Cohesion: 0.06
Nodes (33): clearSchemaDriftBaselines(), BufferStats, MessageBufferRecord, MessageBufferRow, DataExplorerViewRecord, DeviceStateHistoryRecord, DictionaryDelta, DictionaryDeltaRow (+25 more)

### Community 44 - "container-manager.ts"
Cohesion: 0.06
Nodes (44): AppStep, ContainerManagerEvents, DeviceApp, DeviceState, createNetwork(), createVolume(), DockerOpsContext, downloadImage() (+36 more)

### Community 45 - "Agent"
Cohesion: 0.06
Nodes (12): Agent, AgentLifecycle, AgentState, BOOT, ERROR, INIT, READY, RUNNING (+4 more)

### Community 46 - "core/manager.ts"
Cohesion: 0.05
Nodes (26): HeartbeatManager, AccumulatedFeature, DatasetAccumulatorEntry, MAX_BATCH_BYTES, MlDtype, MlFeaturePayload, PayloadFormat, ProtocolMessage (+18 more)

### Community 47 - "AnomalyDetectionService"
Cohesion: 0.07
Nodes (9): RunDetectionMethodsResult, MetricMatchContext, AlertMqttClient, AnomalyDetectionService, AnomalyMqttClient, AnomalyConfig, DataPoint, DetectionMethod (+1 more)

### Community 48 - "licensing/service.ts"
Cohesion: 0.10
Nodes (25): licenseService(), bootstrapLicense(), BootstrapOptions, EMBEDDED_LICENSE_PUBLIC_KEY, getLicensePublicKey(), envEnabled(), getLicenseService(), initLicensing() (+17 more)

### Community 49 - "lib/errors.ts"
Cohesion: 0.05
Nodes (37): AppendDirectiveError, AppsJsonParseError, BackupError, BadRequestError, CodedSysError, ConfigurationValidationError, DatabaseParseError, DeltaApplyError (+29 more)

### Community 50 - "SourcesView.vue"
Cohesion: 0.05
Nodes (38): activeProtocol, bulkDisable(), bulkDisabling, bulkEnable(), bulkEnabling, columns, connSummary(), createRuleOpen (+30 more)

### Community 51 - "package.json"
Cohesion: 0.06
Nodes (48): author, description, devDependencies, eslint@^8.57.1, jest@^29.0.0, rimraf@^5.0.10, sinon@^21.0.0, ts-jest@^29.0.0 (+40 more)

### Community 52 - "DevicesView.vue"
Cohesion: 0.05
Nodes (34): close(), emit, Point, protocolOptions, DESTINATION_COLORS, destinationColor(), METHOD_COLORS, PROTOCOL_COLORS (+26 more)

### Community 53 - "maintenance/service.ts"
Cohesion: 0.11
Nodes (33): createBuffer(), continuousDurationMs(), getLatestSample(), onRatioWithinWindow(), Sample, DebounceTracker, evaluateCumulativeRuntime(), evaluateCycleCount() (+25 more)

### Community 54 - "AnomalyFeed"
Cohesion: 0.10
Nodes (16): DeviceStateHistoryModel, Protocol, CanonicalDeviceState, extractRawDeviceState(), extractStateField(), fallbackStateForProtocol(), FAULT_TOKENS, IDLE_TOKENS (+8 more)

### Community 56 - "anomaly/service.ts"
Cohesion: 0.08
Nodes (37): extractRawDeviceState(), extractStateField(), fallbackStateForProtocol(), FAULT_TOKENS, IDLE_TOKENS, normalizeDeviceState(), normalizeNumericState(), normalizeStringState() (+29 more)

### Community 57 - "UsersView.vue"
Cohesion: 0.06
Nodes (36): UserRole, Session, sessionsApi, User, usersApi, activeTab, bulkActivate(), bulkActivating (+28 more)

### Community 58 - "getDatabase"
Cohesion: 0.08
Nodes (12): escalateSeverity(), clearAnomalyBaselines(), getAnomalyBaselines(), getDbStats(), AdminSessionModel, AnomalyAlertModel, AnomalyEventModel, AnomalyEventPayload (+4 more)

### Community 59 - "CloudSync"
Cohesion: 0.08
Nodes (3): ConnectionMonitor, CloudSync, CloudSyncMqttManager

### Community 60 - "DashboardView.vue"
Cohesion: 0.05
Nodes (29): PipelineOverview, alertColumns, alertsTotal, cpuHistory, error, fmtCompact(), fmtThroughput(), incidentStats (+21 more)

### Community 61 - "DiscoveryDrawer.vue"
Cohesion: 0.06
Nodes (38): addAll(), addDevice(), addedThisSession, adding, addingAll, awaitingBackgroundResult, backgroundRuleUuid, cancelPrune() (+30 more)

### Community 62 - "CreateDatasetDrawer.vue"
Cohesion: 0.06
Nodes (37): CreateMlDatasetInput, datasetsApi, MlDataset, bestPointName(), canSave, description, DisplayPoint, displayPoints (+29 more)

### Community 63 - "steps"
Cohesion: 0.05
Nodes (41): description, value, description, TRIVY_VERSION, default, description, required, description (+33 more)

### Community 64 - "containers/types.ts"
Cohesion: 0.10
Nodes (18): SecurityPolicySummary, HealthCheckConfig, HealthCheckExecutor, HealthCheckManager, AppConfig, ContainerHealth, ContainerHealthProbe, ExecHealthCheck (+10 more)

### Community 65 - "docker-manager.ts"
Cohesion: 0.10
Nodes (24): DockerAuthConfig, DockerContainerInfo, DockerContainerInfo, DockerStateSyncContext, ManagedContainerSummary, mapDockerStateToServiceState(), syncStateFromDocker(), checkImageUpdate() (+16 more)

### Community 66 - "quality/index.ts"
Cohesion: 0.15
Nodes (22): sourceCheck(), CheckDefinition, CheckFn, unitCheck(), valueCheck(), assessUnitConfidence(), UNIT_PROVENANCE_CONFIDENCE, buildCompactIssueCodes() (+14 more)

### Community 67 - "DockerDriver"
Cohesion: 0.08
Nodes (13): ServiceSecurityConfig, DockerDriver, createOrchestratorDriver(), DriverFactoryConfig, ContainerMetrics, CurrentState, LogStreamOptions, NetworkConfig (+5 more)

### Community 68 - "forecaster.ts"
Cohesion: 0.08
Nodes (27): calculatePredictionConfidence(), calculateTrendDirection(), calculateTrendStrength(), calculateTrendThreshold(), EMA_PREDICTOR_LOOKBACK, EMAPredictor, estimateLinearTimeToThreshold(), estimateLinearTimeToThresholdResult() (+19 more)

### Community 69 - "buildCommands"
Cohesion: 0.16
Nodes (34): agentState(), memoryDiagnostics(), appsInfo(), appsList(), appsPurge(), appsRestart(), appsStart(), appsStop() (+26 more)

### Community 70 - "MaintenanceEnergyService"
Cohesion: 0.09
Nodes (11): AgentDatabase, MaintenanceEnergyService, AssetMetricBinding, AssetRecord, EnergyRecommendationUpsert, EnergyRuleRecord, MaintenanceEnergyStorageService, MaintenanceRecommendationUpsert (+3 more)

### Community 71 - "timescaledb.ts"
Cohesion: 0.08
Nodes (22): pg@^8.22.0, pg, coerceValue(), CustomPayload, detectProtocolFromTopic(), isTagsPayload(), isTransientError(), KNOWN_PROTOCOLS (+14 more)

### Community 72 - "sqlite.ts"
Cohesion: 0.13
Nodes (20): __dirname, STORAGE_STATE, triggerUpdate(), close(), gracefulShutdown(), acquireMigrationLock(), ensureLockRow(), ensureMigrationTables() (+12 more)

### Community 73 - "StateManager"
Cohesion: 0.10
Nodes (5): getManagerStatus(), normalizeValue(), stableStringify(), StateManager, StateSnapshotModel

### Community 74 - "BaseHttpClient"
Cohesion: 0.09
Nodes (4): BaseHttpClient, HttpClientConfig, fetchMock, TestHttpClient

### Community 75 - "memory.ts"
Cohesion: 0.15
Nodes (32): bytesToMB(), calculateExternalGrowthRate(), calculateHeapGrowthRate(), calculateHeapTotalGrowthRate(), calculateMallocedGrowthRate(), calculateSurvivorGrowthRate(), canAttemptRestart(), detectLeakPattern() (+24 more)

### Community 76 - "SubscriptionsView.vue"
Cohesion: 0.07
Nodes (26): b64url(), buildIotisticaTopicBase(), encodeIfUuid(), allEndpoints, bulkDisable(), bulkDisabling, bulkEnable(), bulkEnabling (+18 more)

### Community 77 - "system/metrics.ts"
Cohesion: 0.11
Nodes (30): bytesToMb(), configureAnomalyFeed(), exec, ExtendedMetrics, getContainerMemory(), getCpuCores(), getCpuTemp(), getExtendedMetrics() (+22 more)

### Community 78 - "publish-destinations.model.ts"
Cohesion: 0.13
Nodes (13): getSettings(), AgentModel, AgentRow, DestinationType, PublishDestinationRow, decryptData(), decryptDeviceRecord(), encryptData() (+5 more)

### Community 79 - "state-helpers.ts"
Cohesion: 0.11
Nodes (25): buildContainerSecurityOptions(), ContainerSecurityPolicyError, DEFAULT_PIDS_LIMIT, hostConfigMatchesPolicy(), MAX_PIDS_LIMIT, permissionFailureHint(), resolveContainerSecurityPolicy(), ResolvedSecurityPolicy (+17 more)

### Community 80 - "PointHistoryModal.vue"
Cohesion: 0.12
Nodes (27): ActivityEvent, pipelineApi, SubscriptionActivity, chart, emit, error, load(), loading (+19 more)

### Community 81 - "MarketplaceCatalog.vue"
Cohesion: 0.08
Nodes (31): addCategory(), categories, category, cleanPorts(), dbCategories, { dockerAvailable }, editingId, emit (+23 more)

### Community 82 - "native-migrations.ts"
Cohesion: 0.08
Nodes (11): migration, migration, migration, migration, migration, migration, migration, migration (+3 more)

### Community 83 - "src/core.ts"
Cohesion: 0.12
Nodes (27): agentPullTargetState(), agentUpdate(), bufferStatus(), describeCloudFetchError(), formatMaybeAge(), formatMaybeTime(), restart(), runDiagnostics() (+19 more)

### Community 84 - "v1.ts"
Cohesion: 0.08
Nodes (18): AppWithServices, DockerImageUsage, getDockerImageUsageByApp(), normalizeImageReference(), getMarketplaceCategories(), router, testConnectionLogger, VALID_ROLES (+10 more)

### Community 85 - "migration-helpers.ts"
Cohesion: 0.10
Nodes (22): columnExists(), loadMarketplaceSeedSql(), loadSqlAsset(), loadTemplateSql(), migration, up(), migration, up() (+14 more)

### Community 86 - "OfflineQueue"
Cohesion: 0.15
Nodes (3): OfflineQueueModel, OfflineQueueRecord, OfflineQueue

### Community 88 - "containers.ts"
Cohesion: 0.08
Nodes (26): categoriesApi, ContainerApp, ContainerMetricsResponse, containersApi, ContainerService, DeployAppForm, DeployServiceForm, DockerConfig (+18 more)

### Community 89 - "MessageViewer.vue"
Cohesion: 0.09
Nodes (23): activeTab, compression, compressionApplied, copied, displayMessage, effectiveSchema, effectiveText, effectiveTruncated (+15 more)

### Community 90 - "CaptureTab.vue"
Cohesion: 0.07
Nodes (23): autoScroll, available, bpfFilter, columns, drawerOpen, filterDirection, filteredPackets, filterProtocol (+15 more)

### Community 91 - "pipeline.service.ts"
Cohesion: 0.11
Nodes (15): pendingTransforms, pipelineEvents, PipelineService, DeviceFilterConfig, PIPELINE_ALLOWED_NODE_TYPES, PipelineFlow, PipelineFlowNode, PipelineInConfig (+7 more)

### Community 92 - "backup.ts"
Cohesion: 0.15
Nodes (22): createDbBackup(), DbBackupInfo, DbBackupMetadata, DbVerificationResult, ensureDir(), formatTimestampForFile(), getDefaultBackupDir(), getIntegrityCheck() (+14 more)

### Community 93 - "sync/index.ts"
Cohesion: 0.16
Nodes (13): PublishMode, StateReporterDeps, CloudTransport, AgentDeviceReport, AgentStateReport, CloudSyncConfig, CloudTransportBufferedError, CurrentStateVersionSource (+5 more)

### Community 94 - "PointsTable.vue"
Cohesion: 0.10
Nodes (24): parsedPoints, columns, detailFor(), expandedKeys, filtered, loadPinned(), pinnedNames, pinnedStorageKey() (+16 more)

### Community 95 - "anomaly/buffer.ts"
Cohesion: 0.12
Nodes (24): calculateConfidence(), calculateSeverity(), createAnomalyAlert(), createId(), generateSeverityReason(), addToBuffer(), addValue(), getBufferStats() (+16 more)

### Community 96 - "StateReporter"
Cohesion: 0.13
Nodes (7): StateReporter, AsyncLock, CircuitBreaker, isAuthError(), isRetryableHttpError(), RetryableError, RetryPolicyConfig

### Community 97 - "BackupsView.vue"
Cohesion: 0.08
Nodes (21): Backup, backups, BackupSchedule, columns, confirmDelete(), confirmRestore(), createBackup(), creating (+13 more)

### Community 98 - "app.ts"
Cohesion: 0.11
Nodes (15): setHealthReporter(), agent, gracefulShutdown(), hasSystemdWatchdog(), health, markFatalAndRecover(), stopWatchdog, HealthArbiter (+7 more)

### Community 99 - "PublishDestinationsModel"
Cohesion: 0.15
Nodes (15): createPublisher(), deletePublisher(), listPublishDestinations(), updateApp(), updatePublisher(), ensureSocketDestination(), removeSocketDestination(), socketDestinationName() (+7 more)

### Community 101 - "BaseProtocolAdapter"
Cohesion: 0.13
Nodes (3): BaseProtocolAdapter, GenericDeviceConfig, TestAdapter

### Community 103 - "decoders/index.ts"
Cohesion: 0.15
Nodes (11): DnsDecoder, RCODES, RECORD_TYPES, HttpDecoder, DecoderRegistry, getDecoderRegistry(), PacketMeta, ProtocolDecoder (+3 more)

### Community 104 - "cli/package.json"
Cohesion: 0.09
Nodes (25): bin, iotctl, dependencies, undici@^7.28.0, description, devDependencies, @types/node@^22.19.7, typescript@^5.9.3 (+17 more)

### Community 105 - "compilerOptions"
Cohesion: 0.08
Nodes (23): compilerOptions, outDir, rootDir, exclude, extends, include, compilerOptions, isolatedModules (+15 more)

### Community 106 - "with"
Cohesion: 0.08
Nodes (26): with, build-args, cache-from, cache-to, cleanup, context, creds, driver-opts (+18 more)

### Community 108 - "mqtt/auth.ts"
Cohesion: 0.13
Nodes (15): AclEntry, buildAclContent(), buildPasswdContent(), ContainerManager, contentHash(), EndpointMqttAuth, execFileAsync, FileAuthOptions (+7 more)

### Community 109 - "device-manager.unit.spec.ts"
Cohesion: 0.11
Nodes (6): DatabaseClient, DeviceRecord, SqliteDatabaseClient, Agent, MockDatabaseClient, MockUuidGenerator

### Community 110 - "JobsFeature"
Cohesion: 0.19
Nodes (3): FeatureLogger, JobsFeature, JobExecutionData

### Community 111 - "units/index.ts"
Cohesion: 0.24
Nodes (18): getUnitCatalog(), convertUnit(), ConvertUnitResult, createUnitNormalizationInterceptor(), unitNormalizationInterceptor(), NO_UNIT_PLACEHOLDERS, normalizeReadingInPlace(), ProtocolMessage (+10 more)

### Community 112 - "MaintenanceRuleDrawer.vue"
Cohesion: 0.09
Nodes (20): assets, availableMetricOptions, buildConfig(), buildWindowGating(), close(), cumulativeRuntime, CumulativeRuntimeForm, cycleCount (+12 more)

### Community 113 - "scripts"
Cohesion: 0.08
Nodes (25): scripts, build, build:admin, clean, copy:db-assets, copy:pipeline-assets, dev, dev:admin (+17 more)

### Community 114 - "lib/http-client.ts"
Cohesion: 0.11
Nodes (7): CompressionStats, FetchHttpClient, HttpClientOptions, HttpError, CompressionStats, HttpClientOptions, HttpResponse

### Community 115 - "RetryManager"
Cohesion: 0.14
Nodes (3): isRetryableError(), RetryManager, RetryStateModel

### Community 116 - "DecodedPacket"
Cohesion: 0.16
Nodes (14): ABORT_REASONS, BacnetDecoder, BVLC_FUNCTIONS, CONFIRMED_SERVICES, decodeObjectIdentifier(), ERROR_CLASSES, ERROR_CODES, OBJECT_TYPES (+6 more)

### Community 118 - "ActivityMonitor"
Cohesion: 0.12
Nodes (9): ActivityEvent, ActivityMonitor, activityMonitor, CompressionSnapshot, displayEndpointName(), pointHistoryKey(), PointHistorySample, RecordParams (+1 more)

### Community 119 - "NetworkView.vue"
Cohesion: 0.09
Nodes (18): activeTab, drawerOpen, editingRule, firewallColumns, firewallData, firewallLoading, loadFirewall(), ports (+10 more)

### Community 120 - "src/api/ml-datasets.ts"
Cohesion: 0.12
Nodes (14): DatasetResponse, isValidPointKey(), mlDatasetsRouter, normalizeAndDedupKeys(), normalizePointKey(), VALID_MISSING_VALUES, VALID_NORMALIZATIONS, VALID_OUTLIER_METHODS (+6 more)

### Community 121 - "DiscoveryRulesScheduler"
Cohesion: 0.17
Nodes (4): DiscoveryRule, DiscoveryRuleModel, DiscoveryRunModel, DiscoveryRulesScheduler

### Community 122 - "BaseFeature"
Cohesion: 0.14
Nodes (4): BaseFeature, FeatureConfig, FeatureLogger, MqttConnection

### Community 123 - "ModbusRegisterMapEditor.vue"
Cohesion: 0.13
Nodes (22): addRow(), applyCsv(), columns, csvOpen, csvText, DATA_TYPE_OPTIONS, emit, emitRows() (+14 more)

### Community 124 - "generate-agents.ps1"
Cohesion: 0.13
Nodes (16): Apply-AnomalySimulationOverrides(), Apply-EnvironmentProfile(), Convert-SimulationScenariosToJson(), ConvertTo-NullableBool(), ConvertTo-StringList(), Get-AgentContainerName(), Get-AgentContainerPrefix(), Get-NextAvailableAgentIndex() (+8 more)

### Community 125 - "AlertManager"
Cohesion: 0.13
Nodes (5): AlertManager, hash16(), AlertManager, AnomalyAlert, AnomalySeverity

### Community 126 - "TcpAssembler"
Cohesion: 0.15
Nodes (8): FlowId, FlowState, TcpAssembler, TcpAssemblerOptions, TcpStreamHandler, CloseEvent, DataEvent, GapEvent

### Community 127 - "OpcUaReader"
Cohesion: 0.20
Nodes (3): OpcUaReader, OpcuaDecoder, statusCodeName()

### Community 128 - "NormalizationHealthDrawer.vue"
Cohesion: 0.10
Nodes (17): canonicalUnitOptions, canonicalUnits, canonicalUnitsLoaded, closeResolve(), conversionFailureColumns, emit, isNewUnit, props (+9 more)

### Community 129 - "MqttUsersTab.vue"
Cohesion: 0.10
Nodes (17): columns, confirmDelete(), createForm, createOpen, creating, deleteUser(), deleting, load() (+9 more)

### Community 130 - "CaptureEngine"
Cohesion: 0.13
Nodes (3): CommandFeature, InitializedFeatures, CaptureEngine

### Community 131 - "units/catalog.ts"
Cohesion: 0.17
Nodes (12): SeedUnitAlias, SeedUnitDefinition, UNIT_ALIASES, UNIT_DEFINITIONS, validateUnitCatalogSeed(), CustomUnitAliasRecord, mapDefinitionRow(), UnitAliasRecord (+4 more)

### Community 132 - "admin/src/api/anomaly.ts"
Cohesion: 0.10
Nodes (20): anomalyApi, BadActor, BaselineProgress, DriftAlertType, DriftOptions, driftRulesApi, ProtocolOutput, RESOLUTION_REASON_LABELS (+12 more)

### Community 133 - "iotctl.ts"
Cohesion: 0.18
Nodes (16): CommandGroup, CommandHandler, CommandMap, dbStats(), licenseActivate(), licenseApplyToken(), licenseStatus(), licenseTrial() (+8 more)

### Community 134 - "compilerOptions"
Cohesion: 0.10
Nodes (20): compilerOptions, allowJs, declaration, declarationMap, esModuleInterop, forceConsistentCasingInFileNames, lib, module (+12 more)

### Community 135 - "with"
Cohesion: 0.10
Nodes (21): with, build-args, cache-from, cache-to, context, creds, fetch-depth, file (+13 more)

### Community 136 - "dependencies"
Cohesion: 0.10
Nodes (21): dependencies, bcryptjs@^3.0.3, dockerode@^4.0.2, express@^4.18.2, @influxdata/influxdb-client@~1.33.2, mqtt@^5.14.1, mqtt-pattern@^2.0.0, net-snmp@^3.26.0 (+13 more)

### Community 138 - "jobs/types.ts"
Cohesion: 0.11
Nodes (19): ActionCommandInputSchema, ActionHandlerInput, ActionHandlerInputSchema, ActionType, RUN_COMMAND, RUN_HANDLER, JobAction, JobActionSchema (+11 more)

### Community 142 - "normalizeSourceSystem"
Cohesion: 0.17
Nodes (5): UnitCatalog, keyFor(), NormalizationHealthTracker, normalizeSourceSystem(), Logger

### Community 143 - "compilerOptions"
Cohesion: 0.10
Nodes (20): compilerOptions, allowJs, declaration, declarationMap, esModuleInterop, forceConsistentCasingInFileNames, lib, module (+12 more)

### Community 144 - "useSystemStats.ts"
Cohesion: 0.15
Nodes (19): AppSystemStats, ContainerMetricsApp, appCpuHistories, appMetrics, cpuColor(), cpuHistory, cpuSamples, fmtMb() (+11 more)

### Community 145 - "compilerOptions"
Cohesion: 0.10
Nodes (19): compilerOptions, allowImportingTsExtensions, isolatedModules, jsx, lib, module, moduleDetection, moduleResolution (+11 more)

### Community 146 - "agent"
Cohesion: 0.10
Nodes (19): build, container_name, environment, networks, ports, restart, volumes, API_SECURITY_MODE (+11 more)

### Community 147 - "deploy"
Cohesion: 0.10
Nodes (19): if, name, runs-on, steps, env, PLINK, PLINK_ARGS, jobs (+11 more)

### Community 148 - "node-opcua-client.js"
Cohesion: 0.11
Nodes (11): AttributeIds, BrowsePath, ClientMonitoredItemGroup, DataType, makeBrowsePath(), MessageSecurityMode, OPCUACertificateManager, SecurityPolicy (+3 more)

### Community 149 - "OPCUADiscovery"
Cohesion: 0.19
Nodes (3): node-opcua-client@^2.170.1, node-opcua-client, OPCUADiscovery

### Community 150 - "tableExists"
Cohesion: 0.14
Nodes (14): tableExists(), migration, up(), migration, up(), migration, up(), indexExists() (+6 more)

### Community 151 - "AgentFirewall"
Cohesion: 0.19
Nodes (3): FirewallRule, Rule, AgentFirewall

### Community 152 - "opcua-decoder.unit.spec.ts"
Cohesion: 0.13
Nodes (13): ALLOWED_CHUNKS, CONNECTION_MSG_TYPES, MESSAGE_TYPE_NAMES, MIN_MESSAGE_SIZES, OpcuaDecoderConfig, STATUS_CODE_NAMES, buildAbort(), buildERR() (+5 more)

### Community 153 - "admin/package.json"
Cohesion: 0.13
Nodes (18): dependencies, @ant-design/icons-vue@^7.0.1, ant-design-vue@^4.2.6, axios@^1.7.9, device-agent@file:.., vue@^3.5.13, @xterm/addon-fit@^0.11.0, @xterm/addon-web-links@^0.12.0 (+10 more)

### Community 154 - "api/mqtt.ts"
Cohesion: 0.13
Nodes (15): BrokerMetrics, BrokerStatus, CompressionSnapshot, FlatTopic, HistoryEntry, HistoryListEntry, mqttApi, emit (+7 more)

### Community 155 - "CLIError"
Cohesion: 0.28
Nodes (17): adaptersAdd(), adaptersDisable(), adaptersEnable(), adaptersList(), adaptersRemove(), adaptersShow(), deriveState(), formatConnection() (+9 more)

### Community 156 - "jobs"
Cohesion: 0.11
Nodes (18): concurrency, cancel-in-progress, group, name, needs, runs-on, env, FORCE_JAVASCRIPT_ACTIONS_TO_NODE24 (+10 more)

### Community 157 - "FeatureInitializer"
Cohesion: 0.15
Nodes (4): setCaptureEngine(), setDevicePublish(), setFirewall(), FeatureInitializer

### Community 158 - "iptables.ts"
Cohesion: 0.16
Nodes (15): getSystemPorts(), castArray(), exec, applyRules(), build(), ChainBuilder, convertToRestoreRulesFormat(), getDefaultRuleAdaptor() (+7 more)

### Community 159 - "MqttBrokerView.vue"
Cohesion: 0.13
Nodes (16): activeTab, connected, countTopics(), filteredTree, filterText, filterTree(), findNode(), loading (+8 more)

### Community 160 - "TerminalView.vue"
Cohesion: 0.14
Nodes (15): CLI_COMMANDS, Cmd, CmdGroup, cmdSearch, connect(), ConnState, connState, containerEl (+7 more)

### Community 161 - "bacnet/discovery.ts"
Cohesion: 0.11
Nodes (14): BACNET_INPUT_OBJECT_TYPES, BACNET_OBJECT_TYPES, BACNET_POSSIBLY_COMMANDABLE_OBJECT_TYPES, BACNET_UNITS_CODE_TO_NAME, BACNET_UNITS_SYMBOLS, BACnetArrayElement, BACnetDeviceInfo, BACnetDiscoveryOptions (+6 more)

### Community 162 - "FetchHttpClient"
Cohesion: 0.16
Nodes (3): FetchHttpClient, HttpClient, HttpError

### Community 163 - "SocketPublishClient"
Cohesion: 0.14
Nodes (3): IPublishClient, PublishMode, SocketPublishClient

### Community 164 - "SourceConnectionFields.vue"
Cohesion: 0.13
Nodes (13): emit, get(), modelOptions, onModelChange(), props, selectedModel, selectedVendor, set() (+5 more)

### Community 165 - "20260620010000_add_admin_users.ts"
Cohesion: 0.12
Nodes (9): bcryptjs, generateRandomPassword(), migration, up(), migration, CATEGORY_SEEDS, migration, OldTemplate (+1 more)

### Community 166 - "network-manager.ts"
Cohesion: 0.18
Nodes (13): acquireNetworkLock(), checkNetworkCollisions(), create(), ensureAgentNetwork(), get(), getAll(), getWithBothLabels(), releaseNetworkLock() (+5 more)

### Community 167 - "CustomUnitAliasesModel"
Cohesion: 0.21
Nodes (4): CustomUnitAliasesModel, UnitAliasesModel, suggestCanonicalUnits(), UnitSuggestion

### Community 169 - "WireGuardManager"
Cohesion: 0.24
Nodes (3): NetworkRouteManager, execAsync, WireGuardManager

### Community 170 - "SampleAdapter"
Cohesion: 0.18
Nodes (4): createPlugin(), loadManifest(), SampleAdapter, SampleClient

### Community 171 - "admin/src/api/network.ts"
Cohesion: 0.13
Nodes (15): CaptureCounters, CapturePacket, CapturePacketDetail, CapturePacketsResponse, CaptureStatusData, CaptureStatusResponse, DecodedInfo, FirewallResponse (+7 more)

### Community 172 - "commands/db.ts"
Cohesion: 0.29
Nodes (15): dbBackup(), DbBackupListEntry, DbBackupServiceModule, dbList(), dbPrune(), dbRestore(), dbVerify(), getFallbackBackupDir() (+7 more)

### Community 173 - "steps"
Cohesion: 0.34
Nodes (16): steps, steps, steps, E2E_ADMIN_PASSWORD_FILE, steps, steps, continue-on-error, env (+8 more)

### Community 174 - "package-agent"
Cohesion: 0.13
Nodes (16): arch, package-agent, package-cli, include, if, name, needs, runs-on (+8 more)

### Community 175 - "ref_node_sqlite"
Cohesion: 0.12
Nodes (5): migration, migration, migration, migration, migration

### Community 176 - "anomaly-rule-template.model.ts"
Cohesion: 0.20
Nodes (8): createAnomalyTemplate(), deleteAnomalyTemplate(), listAnomalyTemplates(), updateAnomalyTemplate(), AnomalyRuleTemplate, AnomalyRuleTemplateCreateData, AnomalyRuleTemplateModel, AnomalyRuleTemplateRow

### Community 177 - "energy-recommendation.model.ts"
Cohesion: 0.23
Nodes (7): listEnergyRecommendations(), updateEnergyRecommendationStatus(), EnergyRecommendation, EnergyRecommendationEvalResult, EnergyRecommendationModel, EnergyRecommendationRow, EnergyRecommendationStatus

### Community 178 - "maintenance-recommendation.model.ts"
Cohesion: 0.23
Nodes (7): listMaintenanceRecommendations(), updateMaintenanceRecommendationStatus(), MaintenanceRecommendation, MaintenanceRecommendationEvalResult, MaintenanceRecommendationModel, MaintenanceRecommendationRow, MaintenanceRecommendationStatus

### Community 180 - "migration-types.ts"
Cohesion: 0.12
Nodes (5): migration, migration, migration, migration, migration

### Community 181 - "NativeSqliteMigration"
Cohesion: 0.12
Nodes (6): NativeSqliteMigration, migration, migration, migration, migration, migration

### Community 182 - "OpcUaFramer"
Cohesion: 0.18
Nodes (4): FramedMessage, ProtocolFramer, OpcUaFramer, VALID_MSG_TYPES

### Community 183 - "setup_remote_access.sh"
Cohesion: 0.45
Nodes (14): check_requirements(), configure_cloud_server(), configure_cloud_sshd(), generate_ssh_key(), main(), print_banner(), print_error(), print_info() (+6 more)

### Community 184 - "PublishSubscriptionsModel"
Cohesion: 0.28
Nodes (5): createPublishSubscription(), deletePublishSubscription(), listPublishSubscriptions(), updatePublishSubscription(), PublishSubscriptionsModel

### Community 185 - "AppMarketplaceModel"
Cohesion: 0.25
Nodes (4): MarketplaceImage, AppMarketplaceModel, TemplateRow, template

### Community 186 - "UserModel"
Cohesion: 0.25
Nodes (5): parseRow(), User, UserModel, UserRole, UserRow

### Community 187 - "broker-monitor.ts"
Cohesion: 0.16
Nodes (7): BrokerMetrics, BrokerStatus, JSONSchema, RateSample, SchemaGenerator, TopicHistoryEntry, TopicNode

### Community 188 - "downloadCsv"
Cohesion: 0.19
Nodes (14): columnSort(), downloadCsv(), favKey(), filteredPoints, friendlySource(), isStale(), originalName(), persistFavorites() (+6 more)

### Community 189 - "install.sh"
Cohesion: 0.24
Nodes (12): configure_mosquitto_file_auth(), generate_password(), install_docker_if_needed(), install_mosquitto_if_needed(), is_debian_family(), is_port_in_use(), normalize_api_endpoint(), PATH (+4 more)

### Community 191 - "MqttUserModel"
Cohesion: 0.27
Nodes (4): MqttUser, MqttUserModel, MqttUserRow, parseRow()

### Community 192 - "schema-drift-rule.model.ts"
Cohesion: 0.29
Nodes (4): DriftRuleRow, parseRow(), SchemaDriftRuleModel, DriftRuleConfig

### Community 193 - "JobEngine"
Cohesion: 0.30
Nodes (3): JobEngine, ActionCommandInput, ActionResult

### Community 194 - "MqttDecoder"
Cohesion: 0.27
Nodes (5): CONNACK_CODES, MqttDecoder, PACKET_TYPES, readMqttString(), readRemainingLength()

### Community 195 - "onTabChange"
Cohesion: 0.22
Nodes (13): confirmResolve(), deleteDriftRule(), ensureEndpointMaps(), loadBadActors(), loadBaselines(), loadConfig(), loadDriftRules(), loadEdgeAlerts() (+5 more)

### Community 196 - "imageToServiceForm"
Cohesion: 0.17
Nodes (13): addService(), deployTemplate(), deployTemplateAsNewApp(), emptyService(), envToRows(), formatLines(), imageToServiceForm(), loadMarketplaceImages() (+5 more)

### Community 197 - "overrides"
Cohesion: 0.15
Nodes (13): overrides, brace-expansion, @grpc/grpc-js, ip-address, jsrsasign, path-to-regexp, picomatch, protobufjs (+5 more)

### Community 198 - "TopicTree.vue"
Cohesion: 0.18
Nodes (7): TopicNode, collapsedSet, emit, localCollapsed, props, sorted, toggle()

### Community 199 - "friendlyLabel"
Cohesion: 0.17
Nodes (12): blankMetric(), canonicalBareMetricName(), ensureScopeDevices(), extractDeviceUuid(), friendlyLabel(), hyphenateField(), metricLeaf(), openAddMetric() (+4 more)

### Community 200 - "docker"
Cohesion: 0.17
Nodes (12): name, needs, permissions, runs-on, docker, publish, permissions, contents (+4 more)

### Community 201 - "steps"
Cohesion: 0.26
Nodes (12): steps, GH_TOKEN, steps, steps, env, id, if, name (+4 more)

### Community 202 - "recommendation-publish-settings.model.ts"
Cohesion: 0.23
Nodes (7): getRecommendationPublishSettings(), updateRecommendationPublishSettings(), DEFAULTS, RecommendationPublishModule, RecommendationPublishSettings, RecommendationPublishSettingsModel, RecommendationPublishSettingsRow

### Community 203 - "LocalLogBackend"
Cohesion: 0.26
Nodes (3): setLocalLogBackend(), initLogging(), LocalLogBackend

### Community 204 - "monitor.ts"
Cohesion: 0.23
Nodes (7): CloudJob, JobsConfig, JobsOptions, JobStatusUpdate, JobDocument, JobsMqttClient, MqttPayload

### Community 205 - "validation.ts"
Cohesion: 0.23
Nodes (10): isEmpty(), isObject(), checkBooleanish(), checkFalsey(), CheckIntOptions, checkTruthy(), FALSEY, TRUTHY (+2 more)

### Community 206 - "@playwright/test"
Cohesion: 0.18
Nodes (3): pages, adminPassword, @playwright/test

### Community 207 - "load"
Cohesion: 0.40
Nodes (11): buildAdvancedConfig(), cleanPorts(), confirmDeployTarget(), deploy(), load(), parseLines(), rowsToEnv(), saveAppDetails() (+3 more)

### Community 208 - "schema-drift-rule-template.model.ts"
Cohesion: 0.35
Nodes (4): DriftRuleTemplate, parseRow(), SchemaDriftRuleTemplateModel, TemplateRow

### Community 211 - "utils/network.ts"
Cohesion: 0.38
Nodes (10): autoDetectLocalSubnets(), getNetworkErrorType(), intToIpv4(), ipv4ToInt(), isConnectionRefused(), isDnsError(), isNetworkUnreachable(), isRetryableNetworkError() (+2 more)

### Community 213 - "devDependencies"
Cohesion: 0.22
Nodes (9): devDependencies, @playwright/test@^1.65.0, typescript@^5.7.2, vite@^6.0.11, @vitejs/plugin-vue@^5.2.1, vue-tsc@^2.2.0, vite, @vitejs/plugin-vue (+1 more)

### Community 214 - "dashboard.ts"
Cohesion: 0.20
Nodes (9): CanonicalUnit, CustomUnitAlias, dashboardApi, DashboardStats, NetworkBandwidth, NormalizationHealth, NormalizationIssue, NormalizationIssueSummary (+1 more)

### Community 215 - "SchemaViewer.vue"
Cohesion: 0.24
Nodes (7): JSONSchema, fieldCount, fields, flattenSchema(), props, SchemaField, TYPE_COLORS

### Community 216 - "handleServiceMenu"
Cohesion: 0.22
Nodes (10): actionKey(), approveImageUpdate(), confirmRemoveService(), doAction(), getImageUpdate(), handleServiceMenu(), handleServiceMenuClick(), isInFlight() (+2 more)

### Community 217 - "publish.ts"
Cohesion: 0.42
Nodes (9): getFlag(), hasFlag(), normalizeTopicsForDisplay(), parseCsv(), publishDestinationsList(), publishMqttAdd(), publishSubscriptionsAdd(), publishSubscriptionsList() (+1 more)

### Community 218 - "schema-drift.ts"
Cohesion: 0.31
Nodes (9): formatValue(), humanMs(), KNOWN_FIELDS, OPERATOR_FIELDS, printConfig(), schemaDriftGet(), schemaDriftResetAdvanced(), schemaDriftSet() (+1 more)

### Community 219 - "package"
Cohesion: 0.20
Nodes (10): arch, deb_arch, package, include, name, needs, runs-on, strategy (+2 more)

### Community 223 - "version"
Cohesion: 0.22
Nodes (9): version, on, push, workflow_dispatch, tags, description, required, type (+1 more)

### Community 224 - "drift-labels.ts"
Cohesion: 0.42
Nodes (5): cleanDriftFieldName(), cleanProtocolPipeName(), KNOWN_DEVICE_ACRONYMS, prettifyDriftDeviceId(), stripFieldDevicePrefix()

### Community 225 - "BacnetPropertyId"
Cohesion: 0.22
Nodes (9): BacnetPropertyId, DESCRIPTION, MODEL_NAME, OBJECT_LIST, OBJECT_NAME, PRESENT_VALUE, PRIORITY_ARRAY, UNITS (+1 more)

### Community 226 - "connectLogs"
Cohesion: 0.25
Nodes (8): clearLogs(), connectLogs(), fullApp(), openAppLogs(), openLogs(), parseLogLine(), switchService(), toggleFollow()

### Community 227 - "logger"
Cohesion: 0.36
Nodes (7): devicesList(), discover(), endpointsClean(), formatConnection(), isModbusDiscoveryTarget(), parseConnectionValue(), logger

### Community 228 - "build"
Cohesion: 0.25
Nodes (8): name, needs, outputs, runs-on, build, agent_version, cli_version, sha_short

### Community 229 - "docker"
Cohesion: 0.25
Nodes (8): name, needs, permissions, runs-on, docker, actions, contents, security-events

### Community 230 - "build-agent-release.yml"
Cohesion: 0.25
Nodes (7): concurrency, cancel-in-progress, group, env, FORCE_JAVASCRIPT_ACTIONS_TO_NODE24, jobs, name

### Community 233 - "JobStatus"
Cohesion: 0.25
Nodes (8): JobStatus, CANCELED, FAILED, IN_PROGRESS, QUEUED, REJECTED, SUCCEEDED, TIMED_OUT

### Community 234 - "connectWs"
Cohesion: 0.33
Nodes (7): captureWsUrl(), clearCapture(), connectWs(), disconnectWs(), loadStatus(), startCapture(), stopCapture()

### Community 237 - "scripts"
Cohesion: 0.33
Nodes (6): scripts, build, dev, preview, test:e2e, test:e2e:ui

### Community 238 - "resolveState"
Cohesion: 0.33
Nodes (6): resolveState(), stateColor(), stateLabel(), summaryForApp(), totalRunning, totalStopped

### Community 239 - "poll"
Cohesion: 0.40
Nodes (6): netIface, poll(), pollOverview(), pollThroughput(), primaryNet(), push()

### Community 240 - "version"
Cohesion: 0.33
Nodes (6): version, tag, version, name, outputs, runs-on

### Community 242 - "rule-resolver.ts"
Cohesion: 0.47
Nodes (5): DetectionRuleBase, DetectionRuleScope, globCache, matchGlob(), resolveRules()

### Community 243 - "manifest.json"
Cohesion: 0.33
Nodes (5): apiVersion, description, name, protocol, version

### Community 244 - "timescaledb.unit.spec.ts"
Cohesion: 0.33
Nodes (3): mockEnd, mockPoolOn, mockQuery

### Community 245 - "anomalyTemplates.ts"
Cohesion: 0.60
Nodes (4): BUILTIN_ANOMALY_TEMPLATES, BuiltinAnomalyTemplate, DetectionMethod, SeasonalityPattern

### Community 246 - "data-explorer-tabs.ts"
Cohesion: 0.50
Nodes (3): builtInTabs, DataExplorerTabs, restoreDataExplorerTabs()

### Community 247 - "cleanup.sh"
Cohesion: 0.70
Nodes (4): ok(), cleanup.sh script, skip(), warn()

### Community 248 - "smoke.sh"
Cohesion: 0.70
Nodes (4): auth(), fail(), smoke.sh script, step()

### Community 250 - "upload-azure"
Cohesion: 0.40
Nodes (5): upload-azure, if, name, needs, runs-on

### Community 251 - "test-provisioning-skip.sh"
Cohesion: 0.90
Nodes (4): check_provisioning_status(), reset_provisioning(), test-provisioning-skip.sh script, simulate_provisioning()

### Community 253 - "RuleAction"
Cohesion: 0.40
Nodes (5): RuleAction, Append, Delete, Flush, Insert

### Community 255 - "loadTemplates"
Cohesion: 0.50
Nodes (4): deleteTemplate(), loadTemplates(), openTemplateLibrary(), saveAsTemplate()

### Community 256 - "saveConfig"
Cohesion: 0.50
Nodes (4): removeMetric(), saveConfig(), saveMetric(), toggleMetricEnabled()

### Community 257 - "enable-memory-cgroups.sh"
Cohesion: 0.83
Nodes (3): die(), say(), enable-memory-cgroups.sh script

### Community 258 - "add_certificate.sh"
Cohesion: 0.83
Nodes (3): main(), print_usage(), add_certificate.sh script

### Community 260 - "20260728030000_rename_opcua_alarms_to_protocol_alarms.ts"
Cohesion: 0.67
Nodes (3): migration, tableExists(), up()

### Community 262 - "uniqueCategoryLabels"
Cohesion: 0.67
Nodes (3): methodCategoryLabel(), ruleDetectionLabels(), uniqueCategoryLabels()

## Knowledge Gaps
- **79 isolated node(s):** `PATH`, `RFC-1918`, `RFC-4122`, `QUEUED`, `IN_PROGRESS` (+74 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 3004 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **58 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `typescript` connect `cli/package.json` to `admin/package.json`, `package.json`, `devDependencies`?**
  _High betweenness centrality (0.179) - this node is a cross-community bridge._
- **What connects `PATH`, `RFC-1918`, `RFC-4122` to the rest of the system?**
  _79 weakly-connected nodes found - possible missing edges._
- **Should `AgentLogger` be split into smaller, more focused modules?**
  _Cohesion score 0.024891371818746122 - nodes in this community are weakly interconnected._
- **Why does `AgentLogger` connect `AgentLogger` to `Logger`, `actions.ts`, `CaptureEngine`, `PublishManager`, `capture.ts`, `commands-e2e.integration.spec.ts`, `jobs/types.ts`, `BACnetDiscovery`, `plugins/index.ts`, `BaseMqttClient`, `core/index.ts`, `.warnSync`, `OPCUADiscovery`, `ConfigManager`, `mqtt/manager.ts`, `DiscoveryService`, `detectors.ts`, `AgentFirewall`, `features.ts`, `AnomalyInjectionSimulation`, `bacnet/discovery.ts`, `.infoSync`, `FetchHttpClient`, `MessageBufferModel`, `fixtures.ts`, `CloudLogBackend`, `WireGuardManager`, `CloudMqttClient`, `ShellHandler`, `container-manager.ts`, `Agent`, `AnomalyDetectionService`, `licensing/service.ts`, `maintenance/service.ts`, `ContainerManager`, `anomaly/service.ts`, `CloudSync`, `containers/types.ts`, `docker-manager.ts`, `JobEngine`, `DockerDriver`, `MaintenanceEnergyService`, `sqlite.ts`, `StateManager`, `BaseHttpClient`, `LocalLogBackend`, `monitor.ts`, `memory.ts`, `publish-destinations.model.ts`, `state-helpers.ts`, `CredentialManager`, `OfflineQueue`, `BaseMqttClient`, `pipeline.service.ts`, `backup.ts`, `sync/index.ts`, `anomaly/buffer.ts`, `StateReporter`, `app.ts`, `PublishDestinationsModel`, `BaseOrchestratorDriver`, `AnomalyStorageService`, `mqtt/auth.ts`, `RetryManager`, `DiscoveryRulesScheduler`, `BaseFeature`?**
  _High betweenness centrality (0.144) - this node is a cross-community bridge._
- **Should `Logger` be split into smaller, more focused modules?**
  _Cohesion score 0.02570281124497992 - nodes in this community are weakly interconnected._
- **Why does `vue` connect `vue` to `NormalizationHealthDrawer.vue`, `MqttUsersTab.vue`, `AnomalyView.vue`, `SparklineChart.vue`, `ContainersView.vue`, `AssetsView.vue`, `SettingsView.vue`, `types/index.ts`, `DiscoveryRulesView.vue`, `useSystemStats.ts`, `DataExplorer.vue`, `admin/package.json`, `api/mqtt.ts`, `DestinationsView.vue`, `DeviceDrawer.vue`, `MqttBrokerView.vue`, `TerminalView.vue`, `DriftRuleDrawer.vue`, `PointPickerModal.vue`, `SourceConnectionFields.vue`, `SubscriptionDrawer.vue`, `SourcesView.vue`, `DevicesView.vue`, `UsersView.vue`, `DashboardView.vue`, `DiscoveryDrawer.vue`, `CreateDatasetDrawer.vue`, `TopicTree.vue`, `SubscriptionsView.vue`, `PointHistoryModal.vue`, `MarketplaceCatalog.vue`, `SchemaViewer.vue`, `containers.ts`, `MessageViewer.vue`, `CaptureTab.vue`, `PointsTable.vue`, `BackupsView.vue`, `MaintenanceRuleDrawer.vue`, `NetworkView.vue`, `ModbusRegisterMapEditor.vue`?**
  _High betweenness centrality (0.133) - this node is a cross-community bridge._
- **Should `actions.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.0205188679245283 - nodes in this community are weakly interconnected._