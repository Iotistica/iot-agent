import { getDatabase } from '../sqlite.js';

export interface FirewallRule {
	id: number;
	port: string;
	protocol: string;
	interface_name: string | null;
	description: string | null;
	created_at: string;
}

interface FirewallRuleRow {
	id: number;
	port: string;
	protocol: string;
	interface_name: string | null;
	description: string | null;
	created_at: string;
}

export class FirewallRuleModel {
	private static db() { return getDatabase(); }

	static getAll(): FirewallRule[] {
		return this.db()
			.prepare('SELECT id, port, protocol, interface_name, description, created_at FROM firewall_rules ORDER BY created_at ASC')
			.all() as unknown as FirewallRuleRow[];
	}

	static getById(id: number): FirewallRule | null {
		const row = this.db()
			.prepare('SELECT id, port, protocol, interface_name, description, created_at FROM firewall_rules WHERE id = ?')
			.get(id) as unknown as FirewallRuleRow | undefined;
		return row ?? null;
	}

	static create(rule: { port: string; protocol: string; interface_name?: string | null; description?: string | null }): FirewallRule {
		const now = new Date().toISOString();
		const result = this.db()
			.prepare('INSERT INTO firewall_rules (port, protocol, interface_name, description, created_at) VALUES (?, ?, ?, ?, ?)')
			.run(rule.port, rule.protocol, rule.interface_name ?? null, rule.description ?? null, now);
		return this.getById(Number(result.lastInsertRowid))!;
	}

	static update(id: number, fields: { port?: string; protocol?: string; interface_name?: string | null; description?: string | null }): FirewallRule | null {
		const sets: string[] = [];
		const values: (string | null)[] = [];

		if (fields.port !== undefined)           { sets.push('port = ?');           values.push(fields.port); }
		if (fields.protocol !== undefined)        { sets.push('protocol = ?');        values.push(fields.protocol); }
		if (fields.interface_name !== undefined)   { sets.push('interface_name = ?');  values.push(fields.interface_name); }
		if (fields.description !== undefined)      { sets.push('description = ?');     values.push(fields.description); }
		if (sets.length === 0) return this.getById(id);

		values.push(String(id));
		this.db().prepare(`UPDATE firewall_rules SET ${sets.join(', ')} WHERE id = ?`).run(...values);
		return this.getById(id);
	}

	static delete(id: number): boolean {
		const result = this.db().prepare('DELETE FROM firewall_rules WHERE id = ?').run(id);
		return result.changes > 0;
	}
}
