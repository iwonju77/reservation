import { databaseUrl } from "@reservation/shared";
import pg from "pg";

const { Client } = pg;

export async function checkDatabase(): Promise<void> {
  const client = new Client({ connectionString: databaseUrl(), connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } finally {
    await client.end().catch(() => undefined);
  }
}
