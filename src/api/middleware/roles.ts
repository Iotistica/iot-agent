/**
 * Session + role gate for the admin API. `requireRole('viewer')` is
 * effectively "must be logged in" (viewer is the lowest tier); higher
 * minimums additionally require that rank.
 */

import type { Request, Response, NextFunction } from 'express';
import { AdminSessionModel } from '../../db/models/admin-session.model.js';
import { UserModel, type UserRole } from '../../db/models/admin-user.model.js';

export const SESSION_COOKIE = 'admin_session';

const RANK: Record<UserRole, number> = { viewer: 0, operator: 1, admin: 2 };

export function parseCookie(header: string | undefined, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(';')) {
		const [k, v] = part.trim().split('=');
		if (k === name) return v;
	}
	return undefined;
}

export function requireRole(min: UserRole) {
	return (req: Request, res: Response, next: NextFunction) => {
		const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
		const session = token ? AdminSessionModel.find(token) : null;
		if (!session) {
			return res.status(401).json({ error: 'Not authenticated' });
		}

		const user = UserModel.getByUsername(session.username);
		if (!user?.is_active) {
			return res.status(401).json({ error: 'Not authenticated' });
		}

		if (RANK[user.role] < RANK[min]) {
			return res.status(403).json({ error: 'Insufficient role' });
		}

		(req as any).adminUser = user.username;
		(req as any).adminRole = user.role;
		next();
	};
}
