import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../sqlite';

export type RecommendationPublishModule = 'maintenance' | 'energy';

export interface RecommendationPublishSettings {
	module: RecommendationPublishModule;
	mqtt: boolean;
	cloud: boolean;
	alert_destination_id: number | null;
	alert_topic: string | null;
	updated_at?: string;
}

type RecommendationPublishSettingsRow = Omit<RecommendationPublishSettings, 'mqtt' | 'cloud'> & {
	mqtt: number;
	cloud: number;
};

const DEFAULTS: Omit<RecommendationPublishSettings, 'module'> = {
	mqtt: false,
	cloud: true,
	alert_destination_id: null,
	alert_topic: null,
};

export class RecommendationPublishSettingsModel {
	private static table = 'recommendation_publish_settings';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	private static parseRow(row: RecommendationPublishSettingsRow): RecommendationPublishSettings {
		return { ...row, mqtt: !!row.mqtt, cloud: !!row.cloud };
	}

	/** Creates the default row on first read so callers never have to null-check. */
	static getByModule(module: RecommendationPublishModule): RecommendationPublishSettings {
		const row = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE module = ? LIMIT 1`)
			.get(module) as unknown as RecommendationPublishSettingsRow | undefined;

		if (row) return this.parseRow(row);

		this.getDb().prepare(`
			INSERT INTO ${this.table} (module, mqtt, cloud, alert_destination_id, alert_topic)
			VALUES (?, ?, ?, ?, ?)
		`).run(module, DEFAULTS.mqtt ? 1 : 0, DEFAULTS.cloud ? 1 : 0, DEFAULTS.alert_destination_id, DEFAULTS.alert_topic);

		return { module, ...DEFAULTS };
	}

	static update(module: RecommendationPublishModule, patch: Partial<Omit<RecommendationPublishSettings, 'module'>>): RecommendationPublishSettings {
		this.getByModule(module); // ensure the row exists first

		const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };
		if (patch.mqtt !== undefined) fields.mqtt = patch.mqtt ? 1 : 0;
		if (patch.cloud !== undefined) fields.cloud = patch.cloud ? 1 : 0;
		if (patch.alert_destination_id !== undefined) fields.alert_destination_id = patch.alert_destination_id;
		if (patch.alert_topic !== undefined) fields.alert_topic = patch.alert_topic;

		const cols = Object.keys(fields).map(k => `"${k}" = @${k}`).join(', ');
		this.getDb().prepare(`UPDATE ${this.table} SET ${cols} WHERE module = @module`).run({ ...fields, module });

		return this.getByModule(module);
	}
}
