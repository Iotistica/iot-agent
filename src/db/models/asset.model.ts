import { randomUUID } from 'crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../sqlite';

export type AssetCriticality = 'low' | 'medium' | 'high' | 'critical';

export interface Asset {
	id?: number;
	uuid: string;
	name: string;
	asset_type: string | null;
	criticality: AssetCriticality;
	manufacturer: string | null;
	model: string | null;
	rated_life_hours: number | null;
	rated_cycles: number | null;
	install_date: number | null;
	last_service_date: number | null;
	location: string | null;
	created_at?: string;
	updated_at?: string;
}

export type AssetCreateData = Omit<Asset, 'id' | 'uuid' | 'created_at' | 'updated_at'>;

export class AssetModel {
	private static table = 'assets';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	private static parseRow(row: Asset | undefined): Asset | null {
		if (!row) return null;
		return { ...row };
	}

	static getAll(): Asset[] {
		const rows = this.getDb()
			.prepare(`SELECT * FROM ${this.table} ORDER BY name ASC`)
			.all() as unknown as Asset[];
		return rows.map(r => this.parseRow(r)).filter((r): r is Asset => r !== null);
	}

	static getByUuid(uuid: string): Asset | null {
		const row = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE uuid = ? LIMIT 1`)
			.get(uuid) as unknown as Asset | undefined;
		return this.parseRow(row);
	}

	static create(data: AssetCreateData): Asset {
		const uuid = randomUUID();
		const now = new Date().toISOString();
		this.getDb().prepare(`
			INSERT INTO ${this.table}
				(uuid, name, asset_type, criticality, manufacturer, model, rated_life_hours, rated_cycles, install_date, last_service_date, location, created_at, updated_at)
			VALUES
				(@uuid, @name, @asset_type, @criticality, @manufacturer, @model, @rated_life_hours, @rated_cycles, @install_date, @last_service_date, @location, @created_at, @updated_at)
		`).run({
			uuid,
			name: data.name,
			asset_type: data.asset_type ?? null,
			criticality: data.criticality ?? 'medium',
			manufacturer: data.manufacturer ?? null,
			model: data.model ?? null,
			rated_life_hours: data.rated_life_hours ?? null,
			rated_cycles: data.rated_cycles ?? null,
			install_date: data.install_date ?? null,
			last_service_date: data.last_service_date ?? null,
			location: data.location ?? null,
			created_at: now,
			updated_at: now,
		});
		return this.getByUuid(uuid)!;
	}

	static update(uuid: string, patch: Partial<Omit<Asset, 'id' | 'uuid' | 'created_at'>>): Asset | null {
		const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };

		if (patch.name !== undefined) fields.name = patch.name;
		if (patch.asset_type !== undefined) fields.asset_type = patch.asset_type;
		if (patch.criticality !== undefined) fields.criticality = patch.criticality;
		if (patch.manufacturer !== undefined) fields.manufacturer = patch.manufacturer;
		if (patch.model !== undefined) fields.model = patch.model;
		if (patch.rated_life_hours !== undefined) fields.rated_life_hours = patch.rated_life_hours;
		if (patch.rated_cycles !== undefined) fields.rated_cycles = patch.rated_cycles;
		if (patch.install_date !== undefined) fields.install_date = patch.install_date;
		if (patch.last_service_date !== undefined) fields.last_service_date = patch.last_service_date;
		if (patch.location !== undefined) fields.location = patch.location;

		const cols = Object.keys(fields).map(k => `"${k}" = @${k}`).join(', ');
		this.getDb().prepare(`UPDATE ${this.table} SET ${cols} WHERE uuid = @lookup_uuid`).run({ ...fields, lookup_uuid: uuid });
		return this.getByUuid(uuid);
	}

	static delete(uuid: string): boolean {
		return this.getDb().prepare(`DELETE FROM ${this.table} WHERE uuid = ?`).run(uuid).changes > 0;
	}
}
