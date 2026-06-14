/**
 * Vitest setupFile for integration tests.
 * Runs in each worker process before any test file is imported.
 * Loads .env from project root, then sets defaults for anything still missing.
 */
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(__dirname, "../../../.env") });

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.DB_HOST ??= "localhost";
process.env.DB_PORT ??= "54322";
process.env.DB_USER ??= "postgres";
process.env.DB_PASSWORD ??= "postgres";
process.env.DB_NAME ??= "postgres";
process.env.NODE_ENV ??= "test";

if (!process.env.SUPABASE_JWT_SECRET) {
  throw new Error(
    "SUPABASE_JWT_SECRET is not set. Run `supabase start` and export the env vars before running integration tests.",
  );
}
