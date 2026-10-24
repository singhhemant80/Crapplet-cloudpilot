import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { loadEnv } from '../config/env';

/** Applies pending SQL migrations from ./drizzle (forward-only; see docs/operations/upgrade-rollback.md). */
export async function runMigrations(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: resolve(__dirname, '../../drizzle') });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  const env = loadEnv();
  runMigrations(env.DATABASE_URL)
    .then(() => console.log('migrations applied'))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
