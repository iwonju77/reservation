import { z } from "zod";

const runtimeSchema = z.object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(5_000),
});

export type RuntimeConfig = z.infer<typeof runtimeSchema>;

export function runtimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return runtimeSchema.parse(environment);
}

export function databaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  return z.string().url().startsWith("postgresql://").parse(environment.DATABASE_URL);
}
