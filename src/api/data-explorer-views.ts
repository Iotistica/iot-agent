import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireRole } from './middleware/roles.js';
import { DataExplorerViewModel } from '../db/models/data-explorer-view.model.js';

export const dataExplorerViewsRouter = express.Router();

interface SavedViewResponse {
	id: string;
	name: string;
	description?: string;
	pointKeys: string[];
}

function toResponse(record: { id: string; name: string; description: string; point_keys: string }): SavedViewResponse {
	let pointKeys: string[] = [];
	try { pointKeys = JSON.parse(record.point_keys); } catch { /* empty */ }
	return {
		id: record.id,
		name: record.name,
		description: record.description || undefined,
		pointKeys,
	};
}

function isValidPointKey(key: unknown): boolean {
	if (typeof key !== 'string') return false;
	try {
		const parsed = JSON.parse(key);
		return Array.isArray(parsed)
			&& parsed.length === 4
			&& parsed.every((v: unknown) => typeof v === 'string' && v.length > 0);
	} catch {
		return false;
	}
}

dataExplorerViewsRouter.get(
	'/v1/data-explorer/views',
	requireRole('viewer'),
	(req: Request, res: Response, next: NextFunction) => {
		try {
			const username = (req as any).adminUser as string;
			const records = DataExplorerViewModel.listByOwner(username);
			return res.status(200).json({ views: records.map(toResponse) });
		} catch (error) {
			next(error);
		}
	},
);

dataExplorerViewsRouter.post(
	'/v1/data-explorer/views',
	requireRole('viewer'),
	(req: Request, res: Response, next: NextFunction) => {
		try {
			const username = (req as any).adminUser as string;
			const { name, description, pointKeys, filters } = req.body ?? {};

			if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 100) {
				return res.status(400).json({ error: 'name is required (1–100 characters)' });
			}

			if (!Array.isArray(pointKeys) || pointKeys.length === 0) {
				return res.status(400).json({ error: 'pointKeys must be a non-empty array' });
			}

			if (pointKeys.length > 500) {
				return res.status(400).json({ error: 'A view may contain at most 500 points' });
			}

			for (let i = 0; i < pointKeys.length; i++) {
				if (!isValidPointKey(pointKeys[i])) {
					return res.status(400).json({
						error: `Invalid pointKey at index ${i}: must be a JSON array of exactly 4 non-empty strings`,
					});
				}
			}

			const id = randomUUID();
			const record = DataExplorerViewModel.create(
				id,
				name.trim(),
				typeof description === 'string' ? description.trim().slice(0, 500) : '',
				JSON.stringify(pointKeys),
				filters && typeof filters === 'object' ? JSON.stringify(filters) : null,
				username,
			);

			return res.status(201).json({ view: toResponse(record) });
		} catch (error) {
			next(error);
		}
	},
);

dataExplorerViewsRouter.delete(
	'/v1/data-explorer/views/:id',
	requireRole('viewer'),
	(req: Request, res: Response, next: NextFunction) => {
		try {
			const username = (req as any).adminUser as string;
			const deleted = DataExplorerViewModel.delete(req.params.id, username);

			if (deleted === 0) {
				return res.status(404).json({ error: 'View not found' });
			}

			return res.status(204).send();
		} catch (error) {
			next(error);
		}
	},
);
