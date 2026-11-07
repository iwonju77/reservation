import "dotenv/config";
import { databaseUrl, runtimeConfig } from "@reservation/shared";
import { createDatabasePool } from "@reservation/db";
import { processDueJobs } from "@reservation/reservation-engine";
import pg from "pg";

const { Client } = pg;
const config = runtimeConfig();

async function heartbeat(): Promise<void> {
  const client = new Client({ connectionString: databaseUrl(), connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.query(`
      INSERT INTO system_heartbeats (service, checked_at)
      VALUES ('worker', CURRENT_TIMESTAMP)
      ON CONFLICT (service) DO UPDATE SET checked_at = EXCLUDED.checked_at
    `);
    console.log(JSON.stringify({ level: "info", event: "worker.heartbeat", status: "ok" }));
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function work(): Promise<void> {
  const pool = createDatabasePool();
  try {
    const processed = await processDueJobs(pool, `worker-${process.pid}`);
    console.log(JSON.stringify({ level: "info", event: "worker.jobs", processed }));
  } finally { await pool.end(); }
}

async function main(): Promise<void> {
  await heartbeat();
  await work();
  if (process.env.WORKER_ONCE === "true") return;

  setInterval(() => {
    void Promise.all([heartbeat(), work()]).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(JSON.stringify({ level: "error", event: "worker.heartbeat", message }));
    });
  }, config.WORKER_POLL_INTERVAL_MS);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(JSON.stringify({ level: "error", event: "worker.startup", message }));
  process.exitCode = 1;
});
