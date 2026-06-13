/**
 * Vitest setupFile for integration tests.
 * Runs in each worker process before any test file is imported.
 * Sets env var defaults so module-level code in authMiddleware and socketAuth
 * can read SUPABASE_JWT_SECRET without throwing at import time.
 */
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
