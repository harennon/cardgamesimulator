import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "./src/shared"),
      "@": resolve(__dirname, "./src/backend"),
    },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 15_000,
    // Run integration tests serially to avoid parallel interference on shared DB state.
    maxWorkers: 1,
    minWorkers: 1,
    // setupFiles runs in each worker before any test file is imported.
    // This sets env vars before module-level code in authMiddleware/socketAuth fires.
    setupFiles: ["tests/integration/helpers/setupEnv.ts"],
  },
});
