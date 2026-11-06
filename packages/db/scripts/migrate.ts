import "dotenv/config";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { databaseUrl } from "@reservation/shared";
import pg from "pg";

const { Client } = pg;
const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
const statusOnly = process.argv.includes("--status");

type AppliedMigration = { name: string; checksum: string };

async function migrationFiles(): Promise<Array<{ name: string; sql: string; checksum: string }>> {
  const entries = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .sort((left, right) => left.name.localeCompare(right.name));

  return Promise.all(entries.map(async ({ name }) => {
    const sql = await readFile(resolve(migrationsDirectory, name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    return { name, sql, checksum };
  }));
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const appliedResult = await client.query<AppliedMigration>(
      "SELECT name, checksum FROM schema_migrations ORDER BY name",
    );
    const applied = new Map(appliedResult.rows.map((row) => [row.name, row.checksum]));
    const files = await migrationFiles();

    for (const migration of files) {
      const recordedChecksum = applied.get(migration.name);
      if (recordedChecksum && recordedChecksum !== migration.checksum) {
        throw new Error(`Applied migration was modified: ${migration.name}`);
      }
    }

    const pending = files.filter((migration) => !applied.has(migration.name));
    if (statusOnly) {
      console.log(JSON.stringify({ applied: applied.size, pending: pending.map(({ name }) => name) }));
      if (pending.length > 0) process.exitCode = 1;
      return;
    }

    await client.query("SELECT pg_advisory_lock(hashtext('reservation_schema_migrations'))");
    try {
      for (const migration of pending) {
        await client.query("BEGIN");
        try {
          await client.query(migration.sql);
          await client.query(
            "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
            [migration.name, migration.checksum],
          );
          await client.query("COMMIT");
          console.log(`Applied ${migration.name}`);
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('reservation_schema_migrations'))");
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown migration error";
  console.error(message);
  process.exitCode = 1;
});
