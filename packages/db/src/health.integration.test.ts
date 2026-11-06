import { describe, expect, it } from "vitest";
import { checkDatabase } from "./health.js";

describe("PostgreSQL connection", () => {
  it("executes a query against the development database", async () => {
    await expect(checkDatabase()).resolves.toBeUndefined();
  });
});
