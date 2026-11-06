import { databaseUrl } from "@reservation/shared";
import pg from "pg";

const { Pool } = pg;

export type DatabasePool = InstanceType<typeof Pool>;

export function createDatabasePool(): DatabasePool {
  return new Pool({
    connectionString: databaseUrl(),
    max: 10,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
  });
}
