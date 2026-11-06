import { describe, expect, it } from "vitest";
import { databaseUrl, runtimeConfig, sessionSecret } from "./runtime-config.js";

describe("runtime configuration", () => {
  it("uses safe local defaults for non-secret process settings", () => {
    expect(runtimeConfig({})).toEqual({ APP_ENV: "development", WORKER_POLL_INTERVAL_MS: 5_000 });
  });

  it("rejects a database URL with the wrong protocol", () => {
    expect(() => databaseUrl({ DATABASE_URL: "https://example.com" })).toThrow();
  });

  it("requires a session secret with at least 32 characters", () => {
    expect(() => sessionSecret({ SESSION_SECRET: "too-short" })).toThrow();
    expect(sessionSecret({ SESSION_SECRET: "a".repeat(32) })).toHaveLength(32);
  });
});
