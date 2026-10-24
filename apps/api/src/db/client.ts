import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;
/** A transaction handle has the same query surface as the database. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbOrTx = Database | Tx;

export function createDatabase(url: string, max = 10): { db: Database; pool: Pool } {
  const pool = new Pool({ connectionString: url, max });
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return { db, pool };
}

export { schema };
