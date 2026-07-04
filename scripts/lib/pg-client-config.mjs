/**
 * pg.Client connection-config selection for the post-condition runner (issue #173).
 *
 * Pure, credential-free: given an env-shaped object it returns the config object
 * to hand to `new Client(...)`. Kept pure so the risky prod branch is unit-tested
 * WITHOUT connecting to any DB (mirrors scripts/lib/drift-gate.mjs).
 *
 * Two mutually-exclusive modes:
 *   1. SUPABASE_DB_URL set + non-empty → connect via the full connection string.
 *      Used against prod's Supabase POOLER from GitHub Actions (IPv4 runners can't
 *      reach the IPv6-only direct DB). The pooler requires SSL, but its cert may
 *      not validate against the default CA chain, so verification is disabled
 *      (`ssl: { rejectUnauthorized: false }`) — the established PGSSLMODE=no-verify
 *      prod-verify pattern.
 *   2. SUPABASE_DB_URL unset/empty → the existing local/CI behavior: individual
 *      DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME vars defaulting to the local
 *      Supabase Postgres (localhost:54322), no SSL. Untouched.
 */

/**
 * @param {Record<string, string | undefined>} env
 * @returns {import("pg").ClientConfig}
 */
export function buildClientConfig(env) {
  const url = env.SUPABASE_DB_URL;
  if (url !== undefined && url !== "") {
    return { connectionString: url, ssl: { rejectUnauthorized: false } };
  }
  return {
    host: env.DB_HOST ?? "localhost",
    port: Number(env.DB_PORT ?? 54322),
    user: env.DB_USER ?? "postgres",
    password: env.DB_PASSWORD ?? "postgres",
    database: env.DB_NAME ?? "postgres",
  };
}
