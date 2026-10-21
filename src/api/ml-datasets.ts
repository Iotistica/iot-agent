import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireRole } from './middleware/roles.js';
import { MlDatasetModel } from '../db/models/ml-dataset.model.js';
import type { MlDatasetRecord } from '../db/models/ml-dataset.model.js';

export const mlDatasetsRouter = express.Router();

const VALID_SAMPLING_INTERVALS = [1, 5, 10, 30, 60, 300, 900];
const VALID_WINDOWS = [300, 900, 1800, 3600, 21600, 86400];
const VALID_MISSING_VALUES = ['keep_null', 'forward_fill', 'skip_missing', 'drop_incomplete'];
const VALID_NORMALIZATIONS = ['none', 'min_max', 'standard'];
const VALID_OUTPUT_FORMATS = ['jsonl', 'csv'];
const VALID_OUTLIER_METHODS = ['iqr'];
const MAX_POINTS = 200;

interface DatasetResponse {
	id: string;
	name: string;
	description: string;
	pointKeys: string[];
	samplingIntervalSecs: number;
	windowSecs: number;
	missingValues: string;
	normalization: string;
	excludeBadQuality: boolean;
	removeOutliers: boolean;
	outlierMethod: string;
	outputFormat: string;
	createdAt: string;
	updatedAt: string;
}

function toResponse(record: MlDatasetRecord): DatasetResponse {
	let pointKeys: string[] = [];
	try { pointKeys = JSON.parse(record.point_keys); } catch { /* empty */ }
	return {
		id: record.id,
		name: record.name,
		description: record.description,
		pointKeys,
		samplingIntervalSecs: record.sampling_interval_secs,
		windowSecs: record.window_secs,
		missingValues: record.missing_values,
		normalization: record.normalization,
		excludeBadQuality: record.exclude_bad_quality === 1,
		removeOutliers: record.remove_outliers === 1,
		outlierMethod: record.outlier_method,
		outputFormat: record.output_format,
		createdAt: record.created_at,
		updatedAt: record.updated_at,
	};
}

function normalizePointKey(key: string): string {
	try {
		const parsed = JSON.parse(key);
		if (Array.isArray(parsed) && parsed.length === 4 && parsed.every((v: unknown) => typeof v === 'string')) {
			return JSON.stringify(parsed.slice(0, 3));
		}
		return key;
	} catch {
		return key;
	}
}

function isValidPointKey(key: unknown): boolean {
	if (typeof key !== 'string') return false;
	try {
		const parsed = JSON.parse(key);
		return Array.isArray(parsed)
			&& (parsed.length === 3 || parsed.length === 4)
			&& parsed.every((v: unknown) => typeof v === 'string' && v.length > 0);
	} catch {
		return false;
	}
}

interface ValidatedConfig {
	name: string;
	description: string;
	pointKeys: string[];
	samplingIntervalSecs: number;
	windowSecs: number;
	missingValues: string;
	normalization: string;
	excludeBadQuality: boolean;
	removeOutliers: boolean;
	outlierMethod: string;
	outputFormat: string;
}

function validateFullConfig(config: ValidatedConfig): string | null {
	if (typeof config.name !== 'string' || config.name.trim().length === 0 || config.name.trim().length > 100) {
		return 'name is required (1–100 characters)';
	}
	if (!Array.isArray(config.pointKeys) || config.pointKeys.length === 0) {
		return 'pointKeys must be a non-empty array';
	}
	if (config.pointKeys.length > MAX_POINTS) {
		return `A dataset may contain at most ${MAX_POINTS} points`;
	}
	for (let i = 0; i < config.pointKeys.length; i++) {
		if (!isValidPointKey(config.pointKeys[i])) {
			return `Invalid pointKey at index ${i}: must be a JSON array of 3 non-empty strings`;
		}
	}
	if (!VALID_SAMPLING_INTERVALS.includes(config.samplingIntervalSecs)) {
		return `samplingIntervalSecs must be one of ${JSON.stringify(VALID_SAMPLING_INTERVALS)}`;
	}
	if (!VALID_WINDOWS.includes(config.windowSecs)) {
		return `windowSecs must be one of ${JSON.stringify(VALID_WINDOWS)}`;
	}
	if (config.samplingIntervalSecs > config.windowSecs) {
		return 'samplingIntervalSecs must be ≤ windowSecs';
	}
	if (!VALID_MISSING_VALUES.includes(config.missingValues)) {
		return `missingValues must be one of ${JSON.stringify(VALID_MISSING_VALUES)}`;
	}
	if (!VALID_NORMALIZATIONS.includes(config.normalization)) {
		return `normalization must be one of ${JSON.stringify(VALID_NORMALIZATIONS)}`;
	}
	if (typeof config.excludeBadQuality !== 'boolean') {
		return 'excludeBadQuality must be a boolean';
	}
	if (typeof config.removeOutliers !== 'boolean') {
		return 'removeOutliers must be a boolean';
	}
	if (config.removeOutliers && !VALID_OUTLIER_METHODS.includes(config.outlierMethod)) {
		return `outlierMethod must be one of ${JSON.stringify(VALID_OUTLIER_METHODS)} when removeOutliers is true`;
	}
	if (!VALID_OUTPUT_FORMATS.includes(config.outputFormat)) {
		return `outputFormat must be one of ${JSON.stringify(VALID_OUTPUT_FORMATS)}`;
	}
	return null;
}

function normalizeAndDedupKeys(keys: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const key of keys) {
		const normalized = normalizePointKey(key);
		if (!seen.has(normalized)) {
			seen.add(normalized);
			result.push(normalized);
		}
	}
	return result;
}

mlDatasetsRouter.get(
	'/v1/ml-datasets',
	requireRole('viewer'),
	(req: Request, res: Response, next: NextFunction) => {
		try {
			const username = (req as any).adminUser as string;
			const records = MlDatasetModel.listByOwner(username);
			return res.status(200).json({ datasets: records.map(toResponse) });
		} catch (error) {
			next(error);
		}
	},
);

mlDatasetsRouter.get(
	'/v1/ml-datasets/:id',
	requireRole('viewer'),
	(req: Request, res: Response, next: NextFunction) => {
		try {
			const username = (req as any).adminUser as string;
			const record = MlDatasetModel.getById(req.params.id, username);
			if (!record) return res.status(404).json({ error: 'Dataset not found' });
			return res.status(200).json({ dataset: toResponse(record) });
		} catch (error) {
			next(error);
		}
	},
);

mlDatasetsRouter.post(
	'/v1/ml-datasets',
	requireRole('viewer'),
	(req: Request, res: Response, next: NextFunction) => {
		try {
			const username = (req as any).adminUser as string;
			const body = req.body ?? {};

			const pointKeys = Array.isArray(body.pointKeys) ? normalizeAndDedupKeys(body.pointKeys) : body.pointKeys;

			const config: ValidatedConfig = {
				name: body.name,
				description: typeof body.description === 'string' ? body.description.trim().slice(0, 500) : '',
				pointKeys,
				samplingIntervalSecs: body.samplingIntervalSecs,
				windowSecs: body.windowSecs,
				missingValues: body.missingValues,
				normalization: body.normalization,
				excludeBadQuality: body.excludeBadQuality,
				removeOutliers: body.removeOutliers,
				outlierMethod: body.removeOutliers ? (body.outlierMethod ?? 'iqr') : 'iqr',
				outputFormat: body.outputFormat,
			};

			const err = validateFullConfig(config);
			if (err) return res.status(400).json({ error: err });

			const id = randomUUID();
			const record = MlDatasetModel.create(id, {
				name: config.name.trim(),
				description: config.description,
				point_keys: JSON.stringify(config.pointKeys),
				sampling_interval_secs: config.samplingIntervalSecs,
				window_secs: config.windowSecs,
				missing_values: config.missingValues,
				normalization: config.normalization,
				exclude_bad_quality: config.excludeBadQuality ? 1 : 0,
				remove_outliers: config.removeOutliers ? 1 : 0,
				outlier_method: config.outlierMethod,
				output_format: config.outputFormat,
			}, username);

			return res.status(201).json({ dataset: toResponse(record) });
		} catch (error) {
			next(error);
		}
	},
);

mlDatasetsRouter.patch(
	'/v1/ml-datasets/:id',
	requireRole('viewer'),
	(req: Request, res: Response, next: NextFunction) => {
		try {
			const username = (req as any).adminUser as string;
			const existing = MlDatasetModel.getById(req.params.id, username);
			if (!existing) return res.status(404).json({ error: 'Dataset not found' });

			const body = req.body ?? {};
			let existingPointKeys: string[] = [];
			try { existingPointKeys = JSON.parse(existing.point_keys); } catch { /* empty */ }

			const pointKeys = Array.isArray(body.pointKeys)
				? normalizeAndDedupKeys(body.pointKeys)
				: existingPointKeys;

			const merged: ValidatedConfig = {
				name: body.name ?? existing.name,
				description: body.description !== undefined
					? (typeof body.description === 'string' ? body.description.trim().slice(0, 500) : '')
					: existing.description,
				pointKeys,
				samplingIntervalSecs: body.samplingIntervalSecs ?? existing.sampling_interval_secs,
				windowSecs: body.windowSecs ?? existing.window_secs,
				missingValues: body.missingValues ?? existing.missing_values,
				normalization: body.normalization ?? existing.normalization,
				excludeBadQuality: body.excludeBadQuality !== undefined ? body.excludeBadQuality : existing.exclude_bad_quality === 1,
				removeOutliers: body.removeOutliers !== undefined ? body.removeOutliers : existing.remove_outliers === 1,
				outlierMethod: body.outlierMethod ?? existing.outlier_method,
				outputFormat: body.outputFormat ?? existing.output_format,
			};

			const err = validateFullConfig(merged);
			if (err) return res.status(400).json({ error: err });

			const updateData: Record<string, unknown> = {};
			if (body.name !== undefined) updateData.name = merged.name.trim();
			if (body.description !== undefined) updateData.description = merged.description;
			if (body.pointKeys !== undefined) updateData.point_keys = JSON.stringify(merged.pointKeys);
			if (body.samplingIntervalSecs !== undefined) updateData.sampling_interval_secs = merged.samplingIntervalSecs;
			if (body.windowSecs !== undefined) updateData.window_secs = merged.windowSecs;
			if (body.missingValues !== undefined) updateData.missing_values = merged.missingValues;
			if (body.normalization !== undefined) updateData.normalization = merged.normalization;
			if (body.excludeBadQuality !== undefined) updateData.exclude_bad_quality = merged.excludeBadQuality ? 1 : 0;
			if (body.removeOutliers !== undefined) updateData.remove_outliers = merged.removeOutliers ? 1 : 0;
			if (body.outlierMethod !== undefined) updateData.outlier_method = merged.outlierMethod;
			if (body.outputFormat !== undefined) updateData.output_format = merged.outputFormat;

			const record = MlDatasetModel.update(req.params.id, updateData, username);
			if (!record) return res.status(404).json({ error: 'Dataset not found' });

			return res.status(200).json({ dataset: toResponse(record) });
		} catch (error) {
			next(error);
		}
	},
);

mlDatasetsRouter.delete(
	'/v1/ml-datasets/:id',
	requireRole('viewer'),
	(req: Request, res: Response, next: NextFunction) => {
		try {
			const username = (req as any).adminUser as string;
			const deleted = MlDatasetModel.delete(req.params.id, username);
			if (deleted === 0) return res.status(404).json({ error: 'Dataset not found' });
			return res.status(204).send();
		} catch (error) {
			next(error);
		}
	},
);
