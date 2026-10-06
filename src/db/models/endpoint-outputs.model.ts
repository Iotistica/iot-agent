/**
 * device Output Configuration Model
 * Manages output configurations for protocol adapters (Modbus, CAN, OPC-UA)
 */

import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../sqlite';

export interface DriftOptions {
  enabled?: boolean;
  warmupBatches?: number;
  consecutiveMissingThreshold?: number;
  alertCooldownMs?: number;
  minFieldPresenceRatio?: number;
  /**
   * Consecutive misses before a baseline field is retired (removed from the
   * learned schema) and its slot freed up for new fields to be tracked.
   * Defaults to 250 when unset — deliberately much higher than
   * consecutiveMissingThreshold (the alert threshold), so one bad
   * reload/gap doesn't erase a field the system has already learned is
   * normally there.
   */
  adaptiveRetireBatches?: number;
  /**
   * Which drift types raise an alert through the Events/Incidents/Alerts
   * pipeline, in addition to always being logged and persisted regardless.
   * Defaults to ['missing-field', 'type-drift'] when unset.
   */
  alertOnDriftTypes?: ('new-field' | 'missing-field' | 'type-drift' | 'rename-candidate')[];
  /** Observations a non-baseline field needs (with sufficient presence ratio, see adaptivePromotionRatio) before it's silently promoted into the baseline and stops being flagged. Defaults to 50. */
  adaptivePromotionBatches?: number;
  /** Required presence ratio (since first seen) for adaptivePromotionBatches promotion to fire. Defaults to 0.6. */
  adaptivePromotionRatio?: number;
  /** Fraction of a field's observations a value type must represent to be its "expected" type — prevents one bad payload from widening accepted types. Defaults to 0.15. */
  minTypeDominanceRatio?: number;
  /** Max distinct fields tracked per device. Defaults to 1000. */
  maxTrackedFields?: number;
  /** Max distinct device identities tracked per endpoint. Defaults to 2000. */
  maxTrackedDevices?: number;
  /** Max nesting depth the schema extractor recurses into a payload. Defaults to 5. */
  maxTraversalDepth?: number;
  /** Max fields processed from a single observation/batch. Defaults to 500. */
  maxFieldsPerBatch?: number;
  /** Max missing/new field pairs compared per side when searching for rename candidates. Defaults to 20. */
  maxRenameCandidates?: number;
  /** Field names longer than this are skipped during rename-candidate (Levenshtein) comparison. Defaults to 64. */
  maxRenameFieldLength?: number;
  /** How many example field names to include in each drift log line. Defaults to 10. */
  logSampleSize?: number;
  /** Run the full drift check only every Nth batch after baseline is established (1 = every batch). Defaults to 1. */
  checkIntervalBatches?: number;
}

export interface DeviceEndpointOutput {
  id?: number;
  protocol: 'modbus' | 'can' | 'opcua' | 'snmp';
  socket_path: string;
  data_format: string;
  delimiter: string;
  include_timestamp: boolean;
  include_device_name: boolean;
  buffer_capacity?: number;
  drift_options?: DriftOptions | null;
  logging?: Record<string, any>;
  created_at?: Date;
  updated_at?: Date;
}

type EndpointOutputRow = Omit<DeviceEndpointOutput, 'include_timestamp' | 'include_device_name' | 'logging' | 'drift_options'> & {
  include_timestamp: number;
  include_device_name: number;
  logging?: string | null;
  drift_options_json?: string | null;
};

export class EndpointOutputModel {
	private static table = 'endpoint_outputs';

	private static readonly SELECT_COLUMNS = [
		'id',
		'protocol',
		'socket_path',
		'data_format',
		'delimiter',
		'include_timestamp',
		'include_device_name',
		'buffer_capacity',
		'drift_options_json',
		'created_at',
		'updated_at',
	] as const;

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	private static toModel(row: EndpointOutputRow): DeviceEndpointOutput {
		const { logging: _logging, drift_options_json, ...rest } = row;

		return {
			...rest,
			include_timestamp: !!row.include_timestamp,
			include_device_name: !!row.include_device_name,
			drift_options: drift_options_json ? JSON.parse(drift_options_json) : null,
		};
	}

	/**
   * Get output configuration for a protocol
   */
	static async getOutput(protocol: string): Promise<DeviceEndpointOutput | null> {
		const output = this.getDb()
			.prepare(
				`SELECT ${this.SELECT_COLUMNS.join(', ')} FROM ${this.table} WHERE protocol = ? LIMIT 1`,
			)
			.get(protocol) as unknown as EndpointOutputRow | undefined;

		return output ? this.toModel(output) : null;
	}

	/**
   * Set output configuration for a protocol
   */
	static async setOutput(output: DeviceEndpointOutput): Promise<DeviceEndpointOutput | null> {
		const now = new Date().toISOString();

		this.getDb()
			.prepare(`
        INSERT INTO ${this.table} (
          protocol,
          socket_path,
          data_format,
          delimiter,
          include_timestamp,
          include_device_name,
          buffer_capacity,
          drift_options_json,
          logging,
          updated_at
        ) VALUES (
          @protocol,
          @socket_path,
          @data_format,
          @delimiter,
          @include_timestamp,
          @include_device_name,
          @buffer_capacity,
          @drift_options_json,
          @logging,
          @updated_at
        )
        ON CONFLICT(protocol) DO UPDATE SET
          socket_path = excluded.socket_path,
          data_format = excluded.data_format,
          delimiter = excluded.delimiter,
          include_timestamp = excluded.include_timestamp,
          include_device_name = excluded.include_device_name,
          buffer_capacity = excluded.buffer_capacity,
          drift_options_json = excluded.drift_options_json,
          logging = excluded.logging,
          updated_at = excluded.updated_at
      `)
			.run({
				protocol: output.protocol,
				socket_path: output.socket_path,
				data_format: output.data_format,
				delimiter: output.delimiter,
				include_timestamp: output.include_timestamp ? 1 : 0,
				include_device_name: output.include_device_name ? 1 : 0,
				buffer_capacity: output.buffer_capacity ?? null,
				drift_options_json: output.drift_options ? JSON.stringify(output.drift_options) : null,
				logging: output.logging ? JSON.stringify(output.logging) : null,
				updated_at: now,
			});

		return await this.getOutput(output.protocol);
	}

	/**
   * Delete output configuration for a protocol
   */
	static async delete(protocol: string): Promise<boolean> {
		const result = this.getDb()
			.prepare(`DELETE FROM ${this.table} WHERE protocol = ?`)
			.run(protocol);
		return Number(result.changes) > 0;
	}

	/**
   * Get all output configurations
   */
	static async getAll(): Promise<DeviceEndpointOutput[]> {
		const rows = this.getDb()
			.prepare(`SELECT ${this.SELECT_COLUMNS.join(', ')} FROM ${this.table} ORDER BY protocol ASC`)
			.all() as unknown as EndpointOutputRow[];

		return rows.map((row) => this.toModel(row));
	}
}
