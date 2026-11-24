import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	const isWindows = process.platform === 'win32';

	// ── endpoint_outputs: one row per protocol ──────────────────────────
	const hasProtocol = db.prepare('SELECT 1 FROM endpoint_outputs WHERE protocol = ? LIMIT 1');
	const insertOutput = db.prepare(`
		INSERT INTO endpoint_outputs (
			protocol,
			socket_path,
			data_format,
			delimiter,
			include_timestamp,
			include_device_name,
			buffer_capacity,
			logging
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`);

	const outputDefaults = [
		{
			protocol: 'modbus',
			socketPath: isWindows ? '\\\\.\\pipe\\modbus' : '/tmp/modbus.sock',
			bufferCapacity: 128 * 1024,
		},
		{
			protocol: 'opcua',
			socketPath: isWindows ? '\\\\.\\pipe\\opcua' : '/tmp/opcua.sock',
			bufferCapacity: 8 * 1024 * 1024,
		},
		{
			protocol: 'snmp',
			socketPath: isWindows ? '\\\\.\\pipe\\snmp' : '/tmp/snmp.sock',
			bufferCapacity: 128 * 1024,
		},
		{
			protocol: 'mqtt',
			socketPath: isWindows ? '\\\\.\\pipe\\mqtt' : '/tmp/mqtt.sock',
			bufferCapacity: 128 * 1024,
		},
		{
			protocol: 'bacnet',
			socketPath: isWindows ? '\\\\.\\pipe\\bacnet' : '/tmp/bacnet.sock',
			bufferCapacity: 128 * 1024,
		},
	];

	for (const row of outputDefaults) {
		if (hasProtocol.get(row.protocol)) continue;
		insertOutput.run(
			row.protocol,
			row.socketPath,
			'json',
			'\n',
			1,
			1,
			row.bufferCapacity,
			JSON.stringify({ level: 'info' }),
		);
	}

	// ── backup_schedule: single-row config ──────────────────────────────
	db.exec('INSERT OR IGNORE INTO backup_schedule (id) VALUES (1)');

	// ── marketplace_categories ──────────────────────────────────────────
	const hasCat = db.prepare('SELECT 1 FROM marketplace_categories LIMIT 1');
	if (!hasCat.get()) {
		const insertCat = db.prepare(
			'INSERT OR IGNORE INTO marketplace_categories (id, name, color, sort_order) VALUES (?, ?, ?, ?)',
		);
		const categories = [
			{ name: 'Automation', color: '#fa8c16' },
			{ name: 'Monitoring', color: '#1677ff' },
			{ name: 'Time Series', color: '#722ed1' },
			{ name: 'MQTT', color: '#13c2c2' },
			{ name: 'Management', color: '#2f54eb' },
			{ name: 'IoT Platform', color: '#52c41a' },
			{ name: 'Database', color: '#f5222d' },
			{ name: 'AI', color: '#fa541c' },
			{ name: 'Iotistica', color: '#722ed1' },
		];
		categories.forEach((cat, i) => insertCat.run(randomUUID(), cat.name, cat.color, i));
	}
}

export const migration: NativeSqliteMigration = {
	name: '20261122010000_seed_missing_data.js',
	up,
};
