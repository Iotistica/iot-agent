import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireRole } from './middleware/roles.js';
import { PointNameMappingsModel } from '../db/models/point-name.model.js';

export const pointCatalogRouter = express.Router();

interface PointCatalogEntry {
	sourceSystem: string | null;
	endpointName: string;
	rawName: string;
	normalizedName: string;
	pointKey: string;
}

pointCatalogRouter.get(
	'/v1/point-catalog',
	requireRole('viewer'),
	(_req: Request, res: Response, next: NextFunction) => {
		try {
			const records = PointNameMappingsModel.getAll();
			const points: PointCatalogEntry[] = records.map(r => ({
				sourceSystem: r.source_system ?? null,
				endpointName: r.endpoint_name,
				rawName: r.raw_name,
				normalizedName: r.normalized_name,
				pointKey: JSON.stringify([r.source_system ?? '', r.endpoint_name, r.normalized_name]),
			}));
			return res.json({ points });
		} catch (error) {
			next(error);
		}
	},
);
