import { Client } from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Direct Postgres connection for tests that need raw DDL (e.g. backfill I4,
 * RPC-signature I7) — things PostgREST / the Supabase JS client cannot do.
 * Connects to the local Supabase Postgres (port 54322, postgres/postgres),
 * matching tests/integration/helpers/setupEnv.ts defaults and the CI
 * `supabase start` stack.
 *
 * The caller owns the connection lifecycle: connect(), run queries, end().
 */
export function makePgClient(): Client {
  return new Client({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 54322),
    user: process.env.DB_USER ?? "postgres",
    password: process.env.DB_PASSWORD ?? "postgres",
    database: process.env.DB_NAME ?? "postgres",
  });
}

/** Reads a migration file's SQL from supabase/migrations/. */
export function readMigrationSql(fileName: string): string {
  return readFileSync(
    resolve(__dirname, "../../../supabase/migrations", fileName),
    "utf8",
  );
}
