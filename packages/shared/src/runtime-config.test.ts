import { describe, expect, it } from "vitest";
import { databaseUrl, runtimeConfig } from "./runtime-config.js";

describe("runtime configuration", () => {
  it("uses safe local defaults for non-secret process settings", () => {
    expect(runtimeConfig({})).toEqual({ APP_ENV: "development", WORKER_POLL_INTERVAL_MS: 5_000 });
  });

  it("rejects a database URL with the wrong protocol", () => {
    expect(() => databaseUrl({ DATABASE_URL: "https://example.com" })).toThrow();
  });
});
