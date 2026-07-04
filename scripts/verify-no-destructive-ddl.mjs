#!/usr/bin/env node
/**
 * Destructive-DDL gate CLI (issue #91 — fail-closed `supabase db push` to prod).
 *
 * Because migrations may eventually be applied to prod by automation, this gate
 * ensures migration SQL never DESTROYS DATA. Postgres role privileges cannot
 * express "alter but not delete" (both flow from indivisible table ownership), so
 * the ban is enforced here at the CI/review layer where the SQL is visible and
 * parseable — mirroring the drift-gate philosophy.
 *
 * Scans supabase/migrations/*.sql and FAILS (exit 1) if any migration contains a
 * data-destroying statement (DROP TABLE, ALTER TABLE ... DROP COLUMN, DELETE,
 * TRUNCATE — including IF EXISTS variants) that is not covered by an explicit,
 * per-file + per-operation entry in the sibling destructive-ddl.allowlist.json.
 * DROP FUNCTION / DROP INDEX are NOT banned (they destroy no data). Fail-closed:
 * no allowlist match => build blocked.
 *
 * The pure scan/verdict logic lives in scripts/lib/destructive-ddl.mjs and is
 * unit-tested against inline SQL with no filesystem access.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateDestructiveDdl } from "./lib/destructive-ddl.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../supabase/migrations");
const ALLOWLIST_PATH = resolve(
  MIGRATIONS_DIR,
  "destructive-ddl.allowlist.json",
);

const MIGRATION_RE = /^\d+_.+\.sql$/;

function loadMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => MIGRATION_RE.test(f))
    .sort()
    .map((file) => ({
      file,
      sql: readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"),
    }));
}

/**
 * The allowlist is a plain map { "<migration>.sql": ["DELETE", ...] }
 * plus an ignored `$comment` policy note. Drop the `$comment` before evaluating.
 */
function loadAllowlist() {
  const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
  const { $comment, ...entries } = raw;
  void $comment;
  return entries;
}

const migrations = loadMigrations();
const allowlist = loadAllowlist();
const result = evaluateDestructiveDdl(migrations, allowlist);

if (result.ok) {
  console.log(
    `Destructive-DDL gate PASSED — ${migrations.length} migration(s) scanned; no un-allowlisted destructive statements.`,
  );
  process.exit(0);
}

console.error("Destructive-DDL gate FAILED — build blocked.\n");
for (const v of result.violations) {
  console.error(`  - ${v}`);
}
console.error(
  "\nMigrations must never destroy data (no DROP TABLE / DROP COLUMN / DELETE /\n" +
    "TRUNCATE). If a data-destroying statement is intentional and reviewed,\n" +
    "allowlist it explicitly in supabase/migrations/destructive-ddl.allowlist.json,\n" +
    "keyed by the migration filename and the exact operation, e.g.:\n\n" +
    '  { "010_example.sql": ["DROP TABLE"] }\n\n' +
    "The override is deliberately per-file + per-operation so it stays auditable.",
);
process.exit(1);
