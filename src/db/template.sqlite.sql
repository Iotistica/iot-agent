BEGIN TRANSACTION;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Core: Agent & Endpoints
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agent (
	id                  INTEGER PRIMARY KEY AUTOINCREMENT,
	uuid                VARCHAR(255) NOT NULL,
	name                VARCHAR(255),
	type                VARCHAR(255),
	apiKey              VARCHAR(255),
	apiEndpoint         VARCHAR(255),
	registeredAt        BIGINT,
	provisioned         BOOLEAN DEFAULT 0,
	deviceApiKey        VARCHAR(255),
	provisioningApiKey  VARCHAR(255),
	mqttBrokerConfig    TEXT,
	apiTlsConfig        TEXT,
	applicationId       INTEGER,
	agentVersion        VARCHAR(50),
	macAddress          VARCHAR(255),
	osVersion           VARCHAR(255),
	createdAt           DATETIME DEFAULT CURRENT_TIMESTAMP,
	updatedAt           DATETIME DEFAULT CURRENT_TIMESTAMP,
	lastSeenAt          DATETIME,
	provisioningState   VARCHAR(255),
	tenantId            VARCHAR(255),
	target_sync_enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS agent_metadata (
	key       VARCHAR(255) PRIMARY KEY,
	value     TEXT NOT NULL,
	createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
	updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS endpoints (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	uuid          VARCHAR(255),
	name          VARCHAR(255) NOT NULL,
	protocol      VARCHAR(50) NOT NULL,
	group_name    VARCHAR(255),
	enabled       BOOLEAN NOT NULL DEFAULT 1,
	poll_interval INTEGER NOT NULL DEFAULT 5000,
	connection    TEXT NOT NULL,
	data_points   TEXT,
	metadata      TEXT,
	created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	lastSeenAt    DATETIME,
	fingerprint   VARCHAR(255),
	revision      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS devices (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	uuid        VARCHAR(255) NOT NULL UNIQUE,
	endpoint_id INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
	name        VARCHAR(255) NOT NULL,
	protocol    VARCHAR(50) NOT NULL,
	enabled     BOOLEAN NOT NULL DEFAULT 1,
	identifier  VARCHAR(255),
	metadata    TEXT,
	lastSeenAt  DATETIME,
	created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	asset_path  TEXT
);

CREATE TABLE IF NOT EXISTS endpoint_outputs (
	id                   INTEGER PRIMARY KEY AUTOINCREMENT,
	protocol             VARCHAR(50) NOT NULL,
	socket_path          VARCHAR(500) NOT NULL,
	data_format          VARCHAR(50) NOT NULL DEFAULT 'json',
	delimiter            VARCHAR(10) NOT NULL DEFAULT '
',
	include_timestamp    BOOLEAN NOT NULL DEFAULT 1,
	include_device_name  BOOLEAN NOT NULL DEFAULT 1,
	logging              TEXT,
	created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	buffer_capacity      INTEGER,
	drift_options_json   TEXT DEFAULT NULL
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Publishing: Destinations, Subscriptions, Source Filters
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS publish_destinations (
	id               INTEGER PRIMARY KEY AUTOINCREMENT,
	name             VARCHAR(255) NOT NULL,
	type             VARCHAR(50) NOT NULL,
	config_json      TEXT,
	enabled          BOOLEAN NOT NULL DEFAULT 1,
	last_error       TEXT,
	last_error_at    DATETIME,
	created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	use_for_commands INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS publish_subscriptions (
	id                       INTEGER PRIMARY KEY AUTOINCREMENT,
	publish_destination_id   INTEGER NOT NULL REFERENCES publish_destinations(id) ON DELETE CASCADE,
	topics                   TEXT NOT NULL DEFAULT '[]',
	route_json               TEXT,
	payload_format           VARCHAR(20) NOT NULL DEFAULT 'custom',
	compression              VARCHAR(50),
	enabled                  BOOLEAN NOT NULL DEFAULT 1,
	created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	ml_dataset_id            TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS subscription_source_filters (
	subscription_id  INTEGER PRIMARY KEY REFERENCES publish_subscriptions(id) ON DELETE CASCADE,
	include_selected INTEGER NOT NULL CHECK (include_selected IN (0, 1))
);

CREATE TABLE IF NOT EXISTS subscription_source_members (
	subscription_id INTEGER NOT NULL REFERENCES subscription_source_filters(subscription_id) ON DELETE CASCADE,
	endpoint_id     INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
	kind            TEXT NOT NULL CHECK (kind IN ('include', 'exclude')),
	position        INTEGER NOT NULL,
	PRIMARY KEY (subscription_id, endpoint_id, kind)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Message Buffer & Offline Queue
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS message_buffer (
	id             INTEGER PRIMARY KEY AUTOINCREMENT,
	endpoint_name  VARCHAR(255) NOT NULL,
	topic          VARCHAR(500) NOT NULL,
	qos            INTEGER NOT NULL DEFAULT 1,
	payload        TEXT NOT NULL,
	payload_bytes  INTEGER NOT NULL,
	retry_count    INTEGER NOT NULL DEFAULT 0,
	last_retry_at  DATETIME,
	last_error     TEXT,
	created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	expires_at     DATETIME NOT NULL,
	msg_id         VARCHAR(255),
	next_retry_at  DATETIME,
	is_critical    INTEGER NOT NULL DEFAULT 0,
	status         VARCHAR(20) NOT NULL DEFAULT 'queued',
	lock_id        VARCHAR(64),
	locked_at      DATETIME
);

CREATE TABLE IF NOT EXISTS message_buffer_metadata (
	key        VARCHAR(100) PRIMARY KEY,
	value      TEXT NOT NULL,
	updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO message_buffer_metadata (key, value, updated_at) VALUES
	('max_records',     '10000',                        CURRENT_TIMESTAMP),
	('max_bytes',       '52428800',                     CURRENT_TIMESTAMP),
	('ttl_hours',       '72',                           CURRENT_TIMESTAMP),
	('last_cleanup_at', '1970-01-01T00:00:00.000Z',    CURRENT_TIMESTAMP),
	('total_buffered',  '0',                            CURRENT_TIMESTAMP),
	('total_flushed',   '0',                            CURRENT_TIMESTAMP),
	('total_dropped',   '0',                            CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS offline_queue (
	id        INTEGER PRIMARY KEY AUTOINCREMENT,
	queueName VARCHAR(255) NOT NULL,
	payload   TEXT NOT NULL,
	createdAt BIGINT NOT NULL,
	attempts  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS retry_state (
	key        VARCHAR(255) PRIMARY KEY,
	count      INTEGER NOT NULL DEFAULT 0,
	next_retry VARCHAR(255) NOT NULL,
	last_error TEXT NOT NULL,
	terminal   INTEGER NOT NULL DEFAULT 0,
	retryable  INTEGER NOT NULL DEFAULT 1,
	updated_at VARCHAR(255) NOT NULL
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Dictionary (key/metric/unit/quality/device enumeration)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dictionary_entries (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	field_name    TEXT NOT NULL UNIQUE,
	field_index   INTEGER NOT NULL,
	domain        TEXT NOT NULL DEFAULT 'key' CHECK (domain IN ('key', 'metric', 'unit', 'quality', 'device')),
	version_added INTEGER NOT NULL,
	created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE (domain, field_index)
);

CREATE TABLE IF NOT EXISTS dictionary_deltas (
	id              INTEGER PRIMARY KEY AUTOINCREMENT,
	version         INTEGER NOT NULL,
	field_name      TEXT NOT NULL,
	field_index     INTEGER NOT NULL,
	domain          TEXT NOT NULL DEFAULT 'metric' CHECK (domain IN ('key', 'metric', 'unit', 'quality', 'device')),
	synced_to_cloud BOOLEAN NOT NULL DEFAULT 0,
	synced_at       DATETIME,
	created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE (domain, field_index)
);

CREATE TABLE IF NOT EXISTS dictionary_metadata (
	key        VARCHAR(100) PRIMARY KEY,
	value      TEXT NOT NULL,
	updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Anomaly Detection & Baselines
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS anomaly_baselines (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	metric        VARCHAR(255) NOT NULL,
	profile       VARCHAR(100),
	time_slot     INTEGER NOT NULL DEFAULT -1,
	device_state  VARCHAR(20) NOT NULL DEFAULT 'unknown',
	device_id     TEXT NOT NULL DEFAULT 'unknown-device',
	mean          FLOAT,
	median        FLOAT,
	std_dev       FLOAT,
	mad           FLOAT,
	min           FLOAT,
	max           FLOAT,
	q1            FLOAT,
	q3            FLOAT,
	iqr           FLOAT,
	sample_count  INTEGER NOT NULL,
	calculated_at BIGINT NOT NULL,
	window_start  BIGINT,
	window_end    BIGINT,
	created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
	updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS anomaly_rule_templates (
	id                 INTEGER PRIMARY KEY AUTOINCREMENT,
	uuid               TEXT NOT NULL UNIQUE,
	name               TEXT NOT NULL,
	category           TEXT,
	purpose            TEXT,
	methods_json       TEXT NOT NULL,
	threshold          REAL NOT NULL,
	window_size        INTEGER NOT NULL,
	min_confidence     REAL,
	cooldown_ms        INTEGER,
	seasonality        TEXT,
	expected_range_json TEXT,
	created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Unified Event System (agent_events → agent_incidents → agent_alerts)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agent_events (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	msg_id        TEXT NOT NULL UNIQUE,
	source        TEXT NOT NULL,
	category      TEXT NOT NULL,
	severity      TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
	fingerprint   TEXT NOT NULL,
	message       TEXT NOT NULL,
	device_name   TEXT,
	timestamp_ms  INTEGER NOT NULL,
	actor         TEXT,
	resource_type TEXT,
	resource_id   TEXT,
	metadata      TEXT,
	created_at    INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE TABLE IF NOT EXISTS agent_incidents (
	id                INTEGER PRIMARY KEY AUTOINCREMENT,
	incident_id       TEXT NOT NULL UNIQUE,
	source            TEXT NOT NULL,
	fingerprint       TEXT NOT NULL,
	severity          TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
	device_name       TEXT NOT NULL DEFAULT 'Unknown',
	first_seen        INTEGER NOT NULL,
	last_seen         INTEGER NOT NULL,
	event_count       INTEGER NOT NULL DEFAULT 1,
	status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'active', 'resolved')),
	last_alert_at     INTEGER,
	acknowledged_at   INTEGER,
	acknowledged_by   TEXT,
	resolution_notes  TEXT,
	resolution_reason TEXT,
	created_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
	updated_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE TABLE IF NOT EXISTS agent_alerts (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	alert_id    TEXT NOT NULL UNIQUE,
	incident_id TEXT NOT NULL,
	source      TEXT NOT NULL,
	severity    TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
	device_name TEXT NOT NULL DEFAULT 'Unknown',
	message     TEXT NOT NULL,
	created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Schema Drift Detection
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS message_schema_drift_log (
	id                    INTEGER PRIMARY KEY AUTOINCREMENT,
	endpoint_name         TEXT NOT NULL,
	drift_type            TEXT NOT NULL,
	field_name            TEXT,
	severity              TEXT NOT NULL,
	expected_type         TEXT,
	observed_types        TEXT,
	rename_candidate_from TEXT,
	rename_candidate_to   TEXT,
	rename_similarity     REAL,
	detected_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	details_json          TEXT
);

CREATE TABLE IF NOT EXISTS message_schema_baseline (
	endpoint_name TEXT PRIMARY KEY,
	baseline_json TEXT NOT NULL,
	updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS schema_drift_rules (
	id                                  INTEGER PRIMARY KEY AUTOINCREMENT,
	uuid                                TEXT NOT NULL UNIQUE,
	enabled                             INTEGER NOT NULL DEFAULT 1,
	priority                            INTEGER NOT NULL DEFAULT 0,
	name                                TEXT,
	description                         TEXT,
	field_pattern                       TEXT,
	device_pattern                      TEXT,
	endpoint_pattern                    TEXT,
	suppress_drift_types_json           TEXT,
	alert_on_drift_types_json           TEXT,
	severity_overrides_json             TEXT,
	consecutive_missing_threshold       INTEGER,
	alert_cooldown_ms                   INTEGER,
	pin_as_baseline                     INTEGER,
	allowed_types_json                  TEXT,
	adaptive_promotion_batches          INTEGER,
	adaptive_promotion_min_elapsed_ms   INTEGER,
	adaptive_retire_batches             INTEGER,
	created_at                          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at                          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS schema_drift_rule_templates (
	id                                  INTEGER PRIMARY KEY AUTOINCREMENT,
	uuid                                TEXT NOT NULL UNIQUE,
	name                                TEXT NOT NULL,
	category                            TEXT,
	description                         TEXT,
	suppress_drift_types_json           TEXT,
	alert_on_drift_types_json           TEXT,
	severity_overrides_json             TEXT,
	consecutive_missing_threshold       INTEGER,
	alert_cooldown_ms                   INTEGER,
	pin_as_baseline                     INTEGER,
	allowed_types_json                  TEXT,
	adaptive_promotion_batches          INTEGER,
	adaptive_promotion_min_elapsed_ms   INTEGER,
	adaptive_retire_batches             INTEGER,
	created_at                          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at                          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Discovery
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS discovery_rules (
	id               INTEGER PRIMARY KEY AUTOINCREMENT,
	uuid             TEXT NOT NULL UNIQUE,
	name             TEXT NOT NULL,
	enabled          INTEGER NOT NULL DEFAULT 1,
	protocol         TEXT NOT NULL,
	interval_seconds INTEGER NOT NULL DEFAULT 3600,
	target_json      TEXT,
	params_json      TEXT,
	auto_enable      INTEGER NOT NULL DEFAULT 0,
	status           TEXT NOT NULL DEFAULT 'idle',
	last_run_at      TEXT,
	next_run_at      TEXT,
	last_result_json TEXT,
	created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS discovery_runs (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	rule_uuid   TEXT NOT NULL,
	rule_name   TEXT NOT NULL,
	protocol    TEXT NOT NULL,
	trigger     TEXT NOT NULL DEFAULT 'scheduled',
	started_at  TEXT NOT NULL,
	finished_at TEXT,
	duration_ms INTEGER,
	status      TEXT NOT NULL DEFAULT 'running',
	found       INTEGER NOT NULL DEFAULT 0,
	saved       INTEGER NOT NULL DEFAULT 0,
	skipped     INTEGER NOT NULL DEFAULT 0,
	error       TEXT,
	created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS discovery_blocklist (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	fingerprint TEXT NOT NULL UNIQUE,
	protocol    TEXT NOT NULL,
	name        TEXT NOT NULL,
	created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS observed_metrics (
	name              TEXT NOT NULL,
	device_id         TEXT NOT NULL DEFAULT '',
	source            TEXT NOT NULL DEFAULT 'unknown',
	protocol          TEXT,
	unit              TEXT,
	last_seen_at      INTEGER NOT NULL,
	observation_count INTEGER NOT NULL DEFAULT 1,
	created_at        INTEGER NOT NULL,
	PRIMARY KEY (name, device_id)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Point Identity & Device Resolution
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS point_identity (
	point_uuid         TEXT PRIMARY KEY NOT NULL CHECK (length(trim(point_uuid)) > 0),
	endpoint_uuid      TEXT NOT NULL CHECK (length(trim(endpoint_uuid)) > 0),
	protocol           TEXT NOT NULL CHECK (length(trim(protocol)) > 0),
	device_uuid        TEXT CHECK (device_uuid IS NULL OR length(trim(device_uuid)) > 0),
	association_source TEXT,
	created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE (point_uuid, endpoint_uuid),
	UNIQUE (point_uuid, endpoint_uuid, protocol)
);

CREATE TABLE IF NOT EXISTS point_identity_address (
	endpoint_uuid   TEXT NOT NULL CHECK (length(trim(endpoint_uuid)) > 0),
	protocol        TEXT NOT NULL CHECK (length(trim(protocol)) > 0),
	address_version INTEGER NOT NULL CHECK (typeof(address_version) = 'integer' AND address_version > 0),
	address_key     TEXT NOT NULL COLLATE BINARY CHECK (length(address_key) > 0),
	point_uuid      TEXT NOT NULL CHECK (length(trim(point_uuid)) > 0),
	created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (endpoint_uuid, protocol, address_version, address_key),
	FOREIGN KEY (point_uuid, endpoint_uuid, protocol)
		REFERENCES point_identity (point_uuid, endpoint_uuid, protocol)
);

CREATE TABLE IF NOT EXISTS point_identity_alias (
	endpoint_uuid TEXT NOT NULL CHECK (length(trim(endpoint_uuid)) > 0),
	alias_kind    TEXT NOT NULL CHECK (length(trim(alias_kind)) > 0),
	alias_key     TEXT NOT NULL COLLATE BINARY CHECK (length(alias_key) > 0),
	point_uuid    TEXT NOT NULL CHECK (length(trim(point_uuid)) > 0),
	evidence      TEXT NOT NULL CHECK (length(trim(evidence)) > 0),
	created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (endpoint_uuid, alias_kind, alias_key),
	FOREIGN KEY (point_uuid, endpoint_uuid)
		REFERENCES point_identity (point_uuid, endpoint_uuid)
);

CREATE TABLE IF NOT EXISTS point_name_mappings (
	id                   INTEGER PRIMARY KEY AUTOINCREMENT,
	source_system        TEXT,
	endpoint_name        TEXT NOT NULL,
	device_key           TEXT NOT NULL DEFAULT '',
	raw_name             TEXT NOT NULL,
	provisional_point_id TEXT NOT NULL,
	normalized_name      TEXT NOT NULL,
	locked               INTEGER NOT NULL DEFAULT 1,
	method               TEXT NOT NULL,
	source_fields        TEXT NOT NULL DEFAULT '[]',
	collision_suffix     TEXT,
	rules_version        TEXT NOT NULL,
	created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
	updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
	UNIQUE (source_system, endpoint_name, device_key, raw_name),
	UNIQUE (endpoint_name, device_key, normalized_name)
);

CREATE TABLE IF NOT EXISTS device_resolution_keys (
	endpoint_id INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
	device_uuid TEXT NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
	kind        TEXT NOT NULL,
	value       TEXT NOT NULL,
	PRIMARY KEY (endpoint_id, kind, value)
);

CREATE TABLE IF NOT EXISTS device_resolution_points (
	endpoint_id INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
	device_uuid TEXT NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
	address     TEXT NOT NULL,
	PRIMARY KEY (endpoint_id, address)
);

CREATE TABLE IF NOT EXISTS device_state_history (
	device_key TEXT PRIMARY KEY,
	state      TEXT NOT NULL,
	since_ms   INTEGER NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Units
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS unit_definitions (
	id             INTEGER PRIMARY KEY AUTOINCREMENT,
	canonical_unit TEXT NOT NULL UNIQUE,
	quantity       TEXT NOT NULL,
	symbol         TEXT,
	description    TEXT,
	base_unit      TEXT NOT NULL,
	multiplier     REAL NOT NULL DEFAULT 1,
	offset_value   REAL NOT NULL DEFAULT 0,
	created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (base_unit) REFERENCES unit_definitions(canonical_unit)
);

CREATE TABLE IF NOT EXISTS unit_aliases (
	id             INTEGER PRIMARY KEY AUTOINCREMENT,
	source_system  TEXT,
	alias          TEXT NOT NULL,
	canonical_unit TEXT NOT NULL,
	created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
	UNIQUE (source_system, alias),
	FOREIGN KEY (canonical_unit) REFERENCES unit_definitions(canonical_unit)
);

CREATE TABLE IF NOT EXISTS custom_unit_aliases (
	id             INTEGER PRIMARY KEY AUTOINCREMENT,
	source_system  TEXT,
	alias          TEXT NOT NULL,
	canonical_unit TEXT NOT NULL,
	created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
	UNIQUE (source_system, alias),
	FOREIGN KEY (canonical_unit) REFERENCES unit_definitions(canonical_unit)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Assets, Maintenance & Energy
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS assets (
	id                INTEGER PRIMARY KEY AUTOINCREMENT,
	uuid              TEXT NOT NULL UNIQUE,
	name              TEXT NOT NULL,
	asset_type        TEXT,
	criticality       TEXT NOT NULL DEFAULT 'medium',
	manufacturer      TEXT,
	model             TEXT,
	rated_life_hours  REAL,
	rated_cycles      INTEGER,
	install_date      INTEGER,
	last_service_date INTEGER,
	location          TEXT,
	created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS asset_metrics (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	asset_id      INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
	device_uuid   TEXT NOT NULL,
	endpoint_uuid TEXT,
	metric        TEXT NOT NULL,
	created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS maintenance_rules (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	asset_id   INTEGER NOT NULL REFERENCES assets(id),
	component  TEXT NOT NULL,
	rule_type  TEXT NOT NULL,
	enabled    INTEGER NOT NULL DEFAULT 1,
	config     TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS maintenance_recommendations (
	id                 INTEGER PRIMARY KEY AUTOINCREMENT,
	asset_id           INTEGER NOT NULL REFERENCES assets(id),
	asset_name         TEXT NOT NULL,
	criticality        TEXT NOT NULL,
	component          TEXT NOT NULL,
	rule_type          TEXT NOT NULL,
	rule_config        TEXT NOT NULL,
	status             TEXT NOT NULL DEFAULT 'open',
	message            TEXT NOT NULL,
	due_by             INTEGER,
	confidence         REAL,
	consecutive_count  INTEGER NOT NULL DEFAULT 1,
	first_evaluated_at INTEGER NOT NULL,
	last_evaluated_at  INTEGER NOT NULL,
	created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS energy_rules (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	asset_id   INTEGER NOT NULL REFERENCES assets(id),
	metric     TEXT NOT NULL,
	rule_type  TEXT NOT NULL,
	enabled    INTEGER NOT NULL DEFAULT 1,
	config     TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS energy_recommendations (
	id                 INTEGER PRIMARY KEY AUTOINCREMENT,
	asset_id           INTEGER NOT NULL REFERENCES assets(id),
	asset_name         TEXT NOT NULL,
	criticality        TEXT NOT NULL,
	metric             TEXT NOT NULL,
	rule_type          TEXT NOT NULL,
	rule_config        TEXT NOT NULL,
	status             TEXT NOT NULL DEFAULT 'open',
	message            TEXT NOT NULL,
	estimated_impact   TEXT,
	confidence         REAL,
	consecutive_count  INTEGER NOT NULL DEFAULT 1,
	first_evaluated_at INTEGER NOT NULL,
	last_evaluated_at  INTEGER NOT NULL,
	created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS recommendation_publish_settings (
	module               TEXT PRIMARY KEY,
	mqtt                 INTEGER NOT NULL DEFAULT 0,
	cloud                INTEGER NOT NULL DEFAULT 1,
	alert_destination_id INTEGER,
	alert_topic          TEXT,
	updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Protocol Alarms
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS protocol_alarms (
	id           INTEGER PRIMARY KEY AUTOINCREMENT,
	protocol     TEXT NOT NULL,
	condition_id TEXT NOT NULL,
	event_type   TEXT NOT NULL,
	device_name  TEXT NOT NULL,
	message      TEXT NOT NULL,
	severity     INTEGER NOT NULL,
	active       INTEGER NOT NULL DEFAULT 1,
	opened_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	cleared_at   TEXT,
	created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- MQTT Users
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mqtt_users (
	id                 INTEGER PRIMARY KEY AUTOINCREMENT,
	username           VARCHAR(255) NOT NULL,
	password_hash      VARCHAR(255) NOT NULL,
	password_plaintext VARCHAR(255) DEFAULT NULL,
	is_superuser       BOOLEAN NOT NULL DEFAULT 0,
	is_active          BOOLEAN NOT NULL DEFAULT 1,
	created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
	updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Admin: Users, Sessions, Backups, License
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS users (
	id                   INTEGER PRIMARY KEY AUTOINCREMENT,
	username             TEXT NOT NULL,
	password_hash        TEXT NOT NULL,
	is_superuser         INTEGER NOT NULL DEFAULT 0,
	is_active            INTEGER NOT NULL DEFAULT 1,
	must_change_password INTEGER NOT NULL DEFAULT 0,
	role                 TEXT NOT NULL DEFAULT 'operator',
	created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS admin_sessions (
	token      TEXT PRIMARY KEY,
	username   TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE TABLE IF NOT EXISTS backup_schedule (
	id             INTEGER PRIMARY KEY CHECK (id = 1),
	enabled        INTEGER NOT NULL DEFAULT 0,
	interval_hours INTEGER NOT NULL DEFAULT 24,
	keep_count     INTEGER NOT NULL DEFAULT 7,
	last_run_at    TEXT,
	next_run_at    TEXT,
	updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS license (
	id           INTEGER PRIMARY KEY CHECK (id = 1),
	token        TEXT NOT NULL,
	activated_at INTEGER NOT NULL
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Firewall
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS firewall_rules (
	id             INTEGER PRIMARY KEY AUTOINCREMENT,
	port           TEXT NOT NULL,
	protocol       TEXT NOT NULL DEFAULT 'tcp',
	interface_name TEXT,
	description    TEXT,
	action         TEXT NOT NULL DEFAULT 'ACCEPT' CHECK (action IN ('ACCEPT', 'REJECT', 'DROP')),
	created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Applications & Marketplace
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS app_marketplace_templates (
	id            TEXT PRIMARY KEY,
	template_json TEXT NOT NULL,
	sort_order    INTEGER NOT NULL,
	created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS marketplace_categories (
	id         TEXT PRIMARY KEY,
	name       TEXT UNIQUE NOT NULL,
	color      TEXT,
	sort_order INTEGER NOT NULL DEFAULT 0
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Data Explorer & ML Datasets
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS data_explorer_views (
	id             TEXT PRIMARY KEY,
	name           TEXT NOT NULL,
	description    TEXT DEFAULT '',
	point_keys     TEXT NOT NULL DEFAULT '[]',
	filters        TEXT DEFAULT NULL,
	owner_username TEXT NOT NULL,
	display_order  INTEGER DEFAULT 0,
	created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
	updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ml_datasets (
	id                     TEXT PRIMARY KEY,
	name                   TEXT NOT NULL,
	description            TEXT NOT NULL DEFAULT '',
	owner_username         TEXT NOT NULL,
	point_keys             TEXT NOT NULL DEFAULT '[]',
	sampling_interval_secs INTEGER NOT NULL DEFAULT 60,
	window_secs            INTEGER NOT NULL DEFAULT 900,
	missing_values         TEXT NOT NULL DEFAULT 'forward_fill',
	normalization          TEXT NOT NULL DEFAULT 'none',
	exclude_bad_quality    INTEGER NOT NULL DEFAULT 1,
	remove_outliers        INTEGER NOT NULL DEFAULT 0,
	outlier_method         TEXT NOT NULL DEFAULT 'iqr',
	output_format          TEXT NOT NULL DEFAULT 'jsonl',
	created_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
	updated_at             DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- State Snapshots
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS stateSnapshot (
	id        INTEGER PRIMARY KEY AUTOINCREMENT,
	type      VARCHAR(50) NOT NULL,
	state     TEXT,
	stateHash VARCHAR(64),
	createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration Infrastructure
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS schema_migrations (
	id             INTEGER PRIMARY KEY AUTOINCREMENT,
	name           VARCHAR(255),
	batch          INTEGER,
	migration_time DATETIME
);

CREATE TABLE IF NOT EXISTS schema_migrations_lock (
	"index"   INTEGER PRIMARY KEY AUTOINCREMENT,
	is_locked INTEGER
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Triggers
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TRIGGER IF NOT EXISTS endpoints_bump_revision
AFTER UPDATE ON endpoints
FOR EACH ROW
WHEN OLD.revision = NEW.revision AND (
	OLD.uuid IS NOT NEW.uuid OR
	OLD.name IS NOT NEW.name OR
	OLD.protocol IS NOT NEW.protocol OR
	OLD.group_name IS NOT NEW.group_name OR
	OLD.enabled IS NOT NEW.enabled OR
	OLD.poll_interval IS NOT NEW.poll_interval OR
	OLD.connection IS NOT NEW.connection OR
	OLD.data_points IS NOT NEW.data_points OR
	OLD.metadata IS NOT NEW.metadata OR
	OLD.fingerprint IS NOT NEW.fingerprint
)
BEGIN
	UPDATE endpoints SET revision = OLD.revision + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER IF NOT EXISTS device_resolution_cleanup_device
AFTER DELETE ON devices BEGIN
	DELETE FROM device_resolution_keys WHERE device_uuid = OLD.uuid;
	DELETE FROM device_resolution_points WHERE device_uuid = OLD.uuid;
END;

CREATE TRIGGER IF NOT EXISTS device_resolution_cleanup_endpoint
AFTER DELETE ON endpoints BEGIN
	DELETE FROM device_resolution_keys WHERE endpoint_id = OLD.id;
	DELETE FROM device_resolution_points WHERE endpoint_id = OLD.id;
END;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Indexes
-- ═══════════════════════════════════════════════════════════════════════════════

-- agent
CREATE UNIQUE INDEX IF NOT EXISTS agent_uuid_unique ON agent (uuid);

-- endpoints
CREATE UNIQUE INDEX IF NOT EXISTS endpoints_name_unique ON endpoints (name);
CREATE UNIQUE INDEX IF NOT EXISTS endpoints_uuid_unique ON endpoints (uuid);
CREATE INDEX IF NOT EXISTS endpoints_enabled_index ON endpoints (enabled);
CREATE INDEX IF NOT EXISTS endpoints_protocol_index ON endpoints (protocol);
CREATE INDEX IF NOT EXISTS idx_endpoints_fingerprint ON endpoints (fingerprint);
CREATE INDEX IF NOT EXISTS idx_endpoints_group_name ON endpoints (group_name);

-- devices
CREATE INDEX IF NOT EXISTS idx_devices_endpoint_id ON devices (endpoint_id);
CREATE INDEX IF NOT EXISTS idx_devices_protocol ON devices (protocol);

-- endpoint_outputs
CREATE UNIQUE INDEX IF NOT EXISTS endpoint_outputs_protocol_unique ON endpoint_outputs (protocol);

-- publish_destinations
CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_destinations_name_unique ON publish_destinations (name);
CREATE INDEX IF NOT EXISTS idx_publish_destinations_type_enabled ON publish_destinations (type, enabled);

-- publish_subscriptions
CREATE INDEX IF NOT EXISTS idx_publish_subscriptions_publish_destination_id ON publish_subscriptions (publish_destination_id);
CREATE INDEX IF NOT EXISTS idx_publish_subscriptions_enabled ON publish_subscriptions (enabled);

-- subscription_source
CREATE INDEX IF NOT EXISTS idx_subscription_source_endpoint ON subscription_source_members (endpoint_id);

-- message_buffer
CREATE INDEX IF NOT EXISTS idx_message_buffer_endpoint_name ON message_buffer (endpoint_name);
CREATE INDEX IF NOT EXISTS idx_message_buffer_expires_at ON message_buffer (expires_at);
CREATE INDEX IF NOT EXISTS idx_message_buffer_lock_id ON message_buffer (lock_id);
CREATE INDEX IF NOT EXISTS idx_message_buffer_lock_recovery ON message_buffer (status, locked_at);
CREATE INDEX IF NOT EXISTS idx_message_buffer_ready ON message_buffer (status, next_retry_at, created_at);
CREATE INDEX IF NOT EXISTS idx_message_buffer_status_lock_created ON message_buffer (status, lock_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_buffer_status_retry ON message_buffer (status, next_retry_at);
CREATE INDEX IF NOT EXISTS message_buffer_created_at_index ON message_buffer (created_at);
CREATE INDEX IF NOT EXISTS message_buffer_endpoint_name_created_at_index ON message_buffer (endpoint_name, created_at);
CREATE INDEX IF NOT EXISTS message_buffer_is_critical_index ON message_buffer (is_critical);
CREATE INDEX IF NOT EXISTS message_buffer_msg_id_index ON message_buffer (msg_id);

-- offline_queue
CREATE INDEX IF NOT EXISTS offline_queue_queuename_createdat_index ON offline_queue (queueName, createdAt);

-- retry_state
CREATE INDEX IF NOT EXISTS idx_retry_state_retryable ON retry_state (retryable, terminal);
CREATE INDEX IF NOT EXISTS idx_retry_state_terminal ON retry_state (terminal, updated_at);
CREATE INDEX IF NOT EXISTS idx_retry_state_updated_at ON retry_state (updated_at);

-- dictionary
CREATE INDEX IF NOT EXISTS dictionary_entries_domain ON dictionary_entries (domain);
CREATE INDEX IF NOT EXISTS dictionary_entries_domain_field_index ON dictionary_entries (domain, field_index);
CREATE INDEX IF NOT EXISTS dictionary_entries_field_name ON dictionary_entries (field_name);
CREATE INDEX IF NOT EXISTS dictionary_entries_version_added ON dictionary_entries (version_added);
CREATE INDEX IF NOT EXISTS dictionary_deltas_domain ON dictionary_deltas (domain);
CREATE INDEX IF NOT EXISTS dictionary_deltas_domain_synced_to_cloud ON dictionary_deltas (domain, synced_to_cloud);
CREATE INDEX IF NOT EXISTS dictionary_deltas_synced_to_cloud ON dictionary_deltas (synced_to_cloud);
CREATE INDEX IF NOT EXISTS dictionary_deltas_version ON dictionary_deltas (version);
CREATE INDEX IF NOT EXISTS dictionary_deltas_version_synced ON dictionary_deltas (version, synced_to_cloud);

-- anomaly_baselines
CREATE UNIQUE INDEX IF NOT EXISTS anomaly_baselines_new_metric_profile_time_slot_unique
	ON anomaly_baselines (metric, profile, time_slot, device_state, device_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_baselines_lookup
	ON anomaly_baselines (metric, time_slot, device_state, device_id, calculated_at);
CREATE INDEX IF NOT EXISTS idx_anomaly_rule_templates_name ON anomaly_rule_templates (name);

-- agent_events
CREATE INDEX IF NOT EXISTS idx_agent_events_source ON agent_events (source);
CREATE INDEX IF NOT EXISTS idx_agent_events_severity ON agent_events (severity);
CREATE INDEX IF NOT EXISTS idx_agent_events_fingerprint ON agent_events (fingerprint);
CREATE INDEX IF NOT EXISTS idx_agent_events_timestamp ON agent_events (timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_agent_events_actor ON agent_events (actor) WHERE actor IS NOT NULL;

-- agent_incidents
CREATE INDEX IF NOT EXISTS idx_agent_incidents_source ON agent_incidents (source);
CREATE INDEX IF NOT EXISTS idx_agent_incidents_fp_status ON agent_incidents (fingerprint, status);
CREATE INDEX IF NOT EXISTS idx_agent_incidents_first_seen ON agent_incidents (first_seen DESC);

-- agent_alerts
CREATE INDEX IF NOT EXISTS idx_agent_alerts_source ON agent_alerts (source);
CREATE INDEX IF NOT EXISTS idx_agent_alerts_incident ON agent_alerts (incident_id);
CREATE INDEX IF NOT EXISTS idx_agent_alerts_created ON agent_alerts (created_at DESC);

-- schema drift
CREATE INDEX IF NOT EXISTS idx_message_schema_drift_log_endpoint_time ON message_schema_drift_log (endpoint_name, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_schema_drift_rules_priority ON schema_drift_rules (priority DESC);
CREATE INDEX IF NOT EXISTS idx_schema_drift_rule_templates_name ON schema_drift_rule_templates (name);

-- discovery
CREATE INDEX IF NOT EXISTS idx_discovery_rules_enabled ON discovery_rules (enabled);
CREATE INDEX IF NOT EXISTS idx_discovery_rules_next_run ON discovery_rules (next_run_at);
CREATE INDEX IF NOT EXISTS idx_discovery_runs_rule_uuid ON discovery_runs (rule_uuid);
CREATE INDEX IF NOT EXISTS idx_discovery_runs_started_at ON discovery_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_discovery_blocklist_fingerprint ON discovery_blocklist (fingerprint);
CREATE INDEX IF NOT EXISTS idx_observed_metrics_last_seen ON observed_metrics (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_observed_metrics_source ON observed_metrics (source);

-- point identity
CREATE INDEX IF NOT EXISTS idx_point_identity_device ON point_identity (device_uuid) WHERE device_uuid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_point_identity_source ON point_identity (endpoint_uuid, protocol);
CREATE INDEX IF NOT EXISTS idx_point_identity_address_point ON point_identity_address (point_uuid);
CREATE INDEX IF NOT EXISTS idx_point_identity_alias_point ON point_identity_alias (point_uuid);
CREATE INDEX IF NOT EXISTS idx_point_name_mappings_provisional_point_id ON point_name_mappings (provisional_point_id);

-- device resolution
CREATE INDEX IF NOT EXISTS idx_device_resolution_keys_device ON device_resolution_keys (device_uuid);
CREATE INDEX IF NOT EXISTS idx_device_resolution_points_device ON device_resolution_points (device_uuid);

-- units
CREATE INDEX IF NOT EXISTS idx_unit_aliases_alias ON unit_aliases (alias);
CREATE INDEX IF NOT EXISTS idx_unit_aliases_canonical ON unit_aliases (canonical_unit);
CREATE INDEX IF NOT EXISTS idx_custom_unit_aliases_alias ON custom_unit_aliases (alias);

-- assets & maintenance/energy
CREATE INDEX IF NOT EXISTS idx_assets_criticality ON assets (criticality);
CREATE INDEX IF NOT EXISTS idx_asset_metrics_asset_id ON asset_metrics (asset_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_metrics_unique ON asset_metrics (asset_id, device_uuid, metric);
CREATE INDEX IF NOT EXISTS idx_maintenance_rules_asset_id ON maintenance_rules (asset_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_rules_enabled ON maintenance_rules (enabled);
CREATE INDEX IF NOT EXISTS idx_maintenance_rec_status ON maintenance_recommendations (status);
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_rec_active_unique
	ON maintenance_recommendations (asset_id, component, rule_type)
	WHERE status IN ('open', 'scheduled');
CREATE INDEX IF NOT EXISTS idx_energy_rules_asset_id ON energy_rules (asset_id);
CREATE INDEX IF NOT EXISTS idx_energy_rules_enabled ON energy_rules (enabled);
CREATE INDEX IF NOT EXISTS idx_energy_rec_status ON energy_recommendations (status);
CREATE UNIQUE INDEX IF NOT EXISTS energy_rec_active_unique
	ON energy_recommendations (asset_id, metric, rule_type)
	WHERE status IN ('open', 'scheduled');

-- protocol_alarms
CREATE INDEX IF NOT EXISTS idx_protocol_alarms_condition_id ON protocol_alarms (protocol, condition_id);
CREATE INDEX IF NOT EXISTS idx_protocol_alarms_device_name ON protocol_alarms (device_name);

-- mqtt_users
CREATE UNIQUE INDEX IF NOT EXISTS mqtt_users_username_unique ON mqtt_users (username);

-- users & sessions
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (username);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON admin_sessions (expires_at);

-- data explorer & ML
CREATE INDEX IF NOT EXISTS idx_data_explorer_views_owner ON data_explorer_views (owner_username);
CREATE INDEX IF NOT EXISTS idx_ml_datasets_owner ON ml_datasets (owner_username);

-- stateSnapshot
CREATE INDEX IF NOT EXISTS statesnapshot_statehash_index ON stateSnapshot (stateHash);
CREATE INDEX IF NOT EXISTS statesnapshot_type_index ON stateSnapshot (type);

COMMIT;
