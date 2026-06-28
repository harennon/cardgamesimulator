import { config } from "dotenv";
import { defineConfig, devices } from "@playwright/test";

config({ path: ".env" });

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // Multiplayer tests share game state — run serially
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // Serial execution — games share Supabase state
  reporter: process.env.CI
    ? [["html", { open: "never" }], ["github"]]
    : [["html", { open: "on-failure" }]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "on-first-retry",
  },
  projects: [
    {
      name: "setup",
      testMatch: /global-setup\.ts/,
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
  ],
  webServer: [
    {
      command: "node build/backend/index.js",
      url: "http://localhost:3000/health",
      reuseExistingServer: true,
      timeout: 30_000,
      env: {
        SUPABASE_URL: process.env.SUPABASE_URL || "http://localhost:54321",
        SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET || "",
        DB_HOST: process.env.DB_HOST || "localhost",
        DB_PORT: process.env.DB_PORT || "54322",
        DB_USER: process.env.DB_USER || "postgres",
        DB_PASSWORD: process.env.DB_PASSWORD || "postgres",
        DB_NAME: process.env.DB_NAME || "postgres",
        NODE_ENV: "test",
      },
    },
    {
      command: "npx vite --port 5173",
      url: "http://localhost:5173",
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
