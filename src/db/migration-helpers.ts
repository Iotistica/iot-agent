import type { DatabaseSync } from 'node:sqlite';
import path from 'path';
import * as fs from 'fs';

export function tableExists(db: DatabaseSync, tableName: string): boolean {
	const row = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
		.get(tableName);

	return Boolean(row);
}

export function columnExists(db: DatabaseSync, tableName: string, columnName: string): boolean {
	if (!tableExists(db, tableName)) {
		return false;
	}

	const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as unknown as Array<{ name: string }>;
	return columns.some((column) => column.name === columnName);
}

function loadSqlAsset(fileName: string): string {
	const candidatePaths = [
		path.join(__dirname, 'sql', fileName),
		path.join(process.cwd(), 'dist', 'db', 'sql', fileName),
		path.join(process.cwd(), 'src', 'db', 'sql', fileName),
		path.join('/app/dist/db/sql', fileName),
		path.join('/app/src/db/sql', fileName),
	];

	for (const candidate of candidatePaths) {
		if (fs.existsSync(candidate)) {
			return fs.readFileSync(candidate, 'utf-8');
		}
	}

	throw new Error(
		`${fileName} not found. Checked paths: ${candidatePaths.join(', ')}`
	);
}

export function loadTemplateSql(): string {
	return loadSqlAsset('template.sqlite.sql');
}
