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
    include: ["tests/**/*.test.ts", "!tests/integration/**"],
    environment: "node",
  },
});
