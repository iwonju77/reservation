import { defineConfig } from "vitest/config";
import "dotenv/config";

export default defineConfig({
  test: {
    include: ["**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 15_000,
    fileParallelism: false,
  },
});
