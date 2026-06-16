import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@shared", replacement: resolve(__dirname, "./src/shared") },
      {
        find: /^@\/service\/(authService|guestService)/,
        replacement: resolve(__dirname, "./src/frontend/service/$1"),
      },
      { find: "@", replacement: resolve(__dirname, "./src/backend") },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts", "!tests/integration/**"],
    environment: "node",
  },
});
