import { migration as squashedInitialSchema } from './migrations/20260312020000_squashed_initial_schema.js';
import type { NativeSqliteMigration } from './migration-types.js';

export const nativeMigrations: NativeSqliteMigration[] = [
	squashedInitialSchema,
];
