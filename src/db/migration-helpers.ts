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
		path.join(__dirname, fileName),
		path.join(process.cwd(), 'dist', 'db', fileName),
		path.join(process.cwd(), 'src', 'db', fileName),
		path.join('/app/dist/db', fileName),
		path.join('/app/src/db', fileName),
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

export function loadMarketplaceSeedSql(): string {
	return loadSqlAsset('marketplace-seed.sql');
}
