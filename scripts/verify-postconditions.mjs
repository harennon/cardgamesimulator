#!/usr/bin/env node
/**
 * Post-condition verification CLI (LLD 77 §6.3, the "release-checklist step").
 *
 * The scripted, NON-SKIPPABLE replacement for the manual post-apply SELECT that
 * caught the LLD 66 incident. Run AFTER migrations are applied to a target DB:
 *   - locally / in CI: after `supabase start` (which applies every migration).
 *   - against prod (HUMAN-OWNED, §9): after `supabase db push`.
 *
 * It (1) asserts 1:1 coverage between supabase/migrations/*.sql and
 * postconditions/*.postcondition.sql, then (2) runs each post-condition against
 * the target DB. Any coverage gap or any RAISEd post-condition => exit 1
 * (release blocked). Fail-closed: warn-only is rejected (LLD 77 §5.4/§6).
 *
 * Credential-free in the repo: connection params come from the environment and
 * default to the local Supabase Postgres. Pointing it at prod is a human-owned
 * step (set SUPABASE_DB_URL to the prod pooler connection string); this file
 * stores no secret. Connection-config selection lives in the pure, unit-tested
 * scripts/lib/pg-client-config.mjs.
 */
import { Client } from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClientConfig } from "./lib/pg-client-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../supabase/migrations");
const POSTCONDITIONS_DIR = resolve(MIGRATIONS_DIR, "postconditions");

const MIGRATION_RE = /^(\d+_.+)\.sql$/;
const POSTCONDITION_RE = /^(\d+_.+)\.postcondition\.sql$/;

function migrationKeys() {
  return readdirSync(MIGRATIONS_DIR)
    .map((f) => MIGRATION_RE.exec(f)?.[1])
    .filter((k) => k !== undefined)
    .sort();
}

function postconditionKeys() {
  return readdirSync(POSTCONDITIONS_DIR)
    .map((f) => POSTCONDITION_RE.exec(f)?.[1])
    .filter((k) => k !== undefined)
    .sort();
}

const migrations = new Set(migrationKeys());
const postconditions = new Set(postconditionKeys());

const missing = [...migrations].filter((k) => !postconditions.has(k)).sort();
const orphaned = [...postconditions].filter((k) => !migrations.has(k)).sort();

let failed = false;

if (missing.length > 0) {
  failed = true;
  console.error(
    `COVERAGE FAIL: migration(s) without a post-condition file: ${missing.join(", ")}`,
  );
}
if (orphaned.length > 0) {
  failed = true;
  console.error(
    `COVERAGE FAIL: post-condition file(s) with no matching migration: ${orphaned.join(", ")}`,
  );
}

const client = new Client(buildClientConfig(process.env));

await client.connect();
try {
  for (const key of postconditionKeys()) {
    const sql = readFileSync(
      resolve(POSTCONDITIONS_DIR, `${key}.postcondition.sql`),
      "utf8",
    );
    try {
      await client.query(sql);
      console.log(`PASS  ${key}`);
    } catch (err) {
      failed = true;
      console.error(
        `FAIL  ${key}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
} finally {
  await client.end();
}

if (failed) {
  console.error("\nPost-condition verification FAILED — release blocked.");
  process.exit(1);
}

console.log("\nAll post-conditions passed.");
