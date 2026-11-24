import { migration as squashedInitialSchema } from './migrations/20260312020000_squashed_initial_schema.js';
import { migration as bootstrapAdminUser } from './migrations/20261122000000_bootstrap_admin_user.js';
import { migration as seedMissingData } from './migrations/20261122010000_seed_missing_data.js';
import { migration as bumpOpcuaBuffer } from './migrations/20261123010000_bump_opcua_buffer.js';
import type { NativeSqliteMigration } from './migration-types.js';

export const nativeMigrations: NativeSqliteMigration[] = [
	squashedInitialSchema,
	bootstrapAdminUser,
	seedMissingData,
	bumpOpcuaBuffer,
];
