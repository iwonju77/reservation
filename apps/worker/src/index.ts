import "dotenv/config";
import { databaseUrl, runtimeConfig } from "@reservation/shared";
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

async function main(): Promise<void> {
  await heartbeat();
  if (process.env.WORKER_ONCE === "true") return;

  setInterval(() => {
    void heartbeat().catch((error: unknown) => {
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
