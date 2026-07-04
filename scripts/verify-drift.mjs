#!/usr/bin/env node
/**
 * Drift-detection gate CLI (LLD 77 §5).
 *
 * Fail-closed: exits 1 on any unexpected residual drift, stale allowlist, or
 * missing pending migration (§5.4 — warn-only is rejected). Exits 0 only when
 * prod schema equals the applied-migration cumulative effect plus the
 * allowlisted expected-pending set.
 *
 * Credential-free in the repo. Two modes:
 *   --diff-file <path>   Read a captured/fixture structured diff (the
 *                        AUTONOMOUS-SAFE / local / placeholder target, and the
 *                        CI default). No prod access.
 *   --linked             Read the live diff via `supabase db diff --linked`.
 *                        HUMAN-OWNED (§9): requires a prod link + secret; never
 *                        wired in the repo.
 *
 * The structured-diff shape is intentionally minimal: { "objects": [ {object},
 * ... ], "pending": [ "<migration filename>", ... ] }. The pure verdict logic
 * lives in scripts/lib/drift-gate.mjs and is unit-tested against fixtures.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { evaluateDriftGate } from "./lib/drift-gate.mjs";
import {
  adaptLinkedDiff,
  LinkedDiffError,
} from "./lib/linked-diff-adapter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../supabase/migrations");
const ALLOWLIST_PATH = resolve(MIGRATIONS_DIR, "expected-diff.allowlist.json");

/**
 * Read every in-tree migration (`supabase/migrations/NNN_*.sql`) as
 * { file: basename, sql: contents }, sorted. The adapter needs the SQL text to
 * attribute db-diff drops/revokes to the pending migration that declares them
 * (LLD 77a §4.3/§4.4). Non-`.sql` allowlist files are excluded.
 * @returns {{file:string, sql:string}[]}
 */
function listMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({
      file: f,
      sql: readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"),
    }));
}

/**
 * Run a CLI command capturing stdout. Fail-closed (F2): a non-zero exit throws
 * (execFileSync default), which the --linked branch turns into a hard block.
 * @param {string} cmd
 * @param {string[]} cmdArgs
 * @returns {string}
 */
function runCli(cmd, cmdArgs) {
  return execFileSync(cmd, cmdArgs, { encoding: "utf8" });
}

const args = process.argv.slice(2);
const diffFileIdx = args.indexOf("--diff-file");
const useLinked = args.includes("--linked");

/**
 * Load the structured diff. In --diff-file mode (default for CI / local /
 * placeholder targets) read it from disk. In --linked mode (human-owned) invoke
 * the Supabase CLI and normalize its raw stdout via the pure linked-diff adapter
 * (LLD 77a). All parse/attribution risk lives in that adapter, which fails closed
 * on any ambiguity; this branch stays thin (run the CLI, hand stdout over).
 */
function loadStructuredDiff() {
  if (diffFileIdx !== -1) {
    const path = args[diffFileIdx + 1];
    if (!path) {
      console.error("Usage: verify-drift.mjs --diff-file <path>");
      process.exit(2);
    }
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  }
  if (useLinked) {
    // HUMAN-OWNED wiring point (§9). The operator must have run
    // `supabase link --project-ref <prod>` (with SUPABASE_ACCESS_TOKEN) before
    // this. Two independent sources: db diff (residual) + migration list
    // (pending). F2: a non-zero CLI exit throws below → caught → exit(2).
    let dbDiffStdout;
    let migrationListStdout;
    try {
      dbDiffStdout = runCli("supabase", [
        "db",
        "diff",
        "--linked",
        "--schema",
        "public",
      ]);
      migrationListStdout = runCli("supabase", [
        "migration",
        "list",
        "--linked",
      ]);
    } catch (err) {
      console.error(
        "Drift gate FAILED — a `supabase --linked` command exited non-zero (F2). A failed command is NEVER treated as 'no drift'.\n",
      );
      console.error(`  ${err.stderr ?? err.message ?? err}`);
      process.exit(2);
    }
    try {
      return adaptLinkedDiff(
        { dbDiffStdout, migrationListStdout },
        listMigrations(),
      );
    } catch (err) {
      // Fail-closed: any unclassifiable statement / unmappable key / malformed
      // table (F3–F7, Gap-A) blocks the release. exit(2) = "could not evaluate".
      if (err instanceof LinkedDiffError) {
        console.error(
          "Drift gate FAILED — the linked-prod diff could not be normalized (fail-closed).\n",
        );
        console.error(`  ${err.message}`);
        process.exit(2);
      }
      throw err;
    }
  }
  console.error(
    "verify-drift.mjs: provide --diff-file <path> (autonomous/local) or --linked (human-owned, needs prod link).",
  );
  process.exit(2);
}

const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
const structuredDiff = loadStructuredDiff();

const result = evaluateDriftGate({
  observed: structuredDiff.objects ?? [],
  expectedFromPending: structuredDiff.expectedFromPending ?? [],
  allowlist: {
    expectedPending: allowlist.expectedPending ?? [],
    acknowledgedResidual: allowlist.acknowledgedResidual ?? [],
  },
  actualPending: structuredDiff.pending ?? [],
});

if (result.ok) {
  console.log(
    "Drift gate PASSED — prod schema matches the applied migrations.",
  );
  process.exit(0);
}

console.error("Drift gate FAILED — build blocked.\n");
for (const reason of result.reasons) {
  console.error(`  - ${reason}`);
}
process.exit(1);
