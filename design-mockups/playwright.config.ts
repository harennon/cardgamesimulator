import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "mobile-scroll.spec.ts",
});
