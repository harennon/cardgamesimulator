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
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { evaluateDriftGate } from "./lib/drift-gate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALLOWLIST_PATH = resolve(
  __dirname,
  "../supabase/migrations/expected-diff.allowlist.json",
);

const args = process.argv.slice(2);
const diffFileIdx = args.indexOf("--diff-file");
const useLinked = args.includes("--linked");

/**
 * Load the structured diff. In --diff-file mode (default for CI / local /
 * placeholder targets) read it from disk. In --linked mode (human-owned) invoke
 * the Supabase CLI. The CLI's raw output is normalized by an adapter the
 * operator supplies at wiring time; here we keep the contract explicit.
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
    // `supabase link --project-ref <prod>` and stored the secret. The raw diff
    // is captured here; normalizing it into { objects, pending } is the
    // operator's adapter step at wiring time. We invoke the CLI so the
    // structure is real, but this branch is not exercised by autonomous CI.
    const raw = execFileSync(
      "supabase",
      ["db", "diff", "--linked", "--schema", "public"],
      { encoding: "utf8" },
    );
    console.error(
      "--linked produced a raw diff; supply a normalizer adapter to map it to { objects, pending } before the gate can evaluate it. Raw length:",
      raw.length,
    );
    process.exit(2);
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
