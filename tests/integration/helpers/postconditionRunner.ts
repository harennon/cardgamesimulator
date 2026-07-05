import type { Client } from "pg";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { readPostconditionSql } from "./prodShapedFixture.js";

/**
 * Post-condition verification runner (LLD 77 §6.3).
 *
 * - Discovers postconditions/*.postcondition.sql and asserts 1:1 coverage with
 *   the migration files in supabase/migrations/ (a migration with no
 *   post-condition file is a gate failure — prevents "forgot to verify").
 * - Executes each post-condition against a target DB; a post-condition that
 *   RAISEs surfaces as a failure so the caller can exit non-zero (release
 *   blocked).
 *
 * Credential-free: the runner takes an already-connected pg Client, so it runs
 * identically against the prod-shaped fixture, a clean `supabase start` DB, and
 * (human-owned, §9) a prod connection. It never opens a connection itself.
 */

const MIGRATIONS_DIR = resolve(__dirname, "../../../supabase/migrations");
const POSTCONDITIONS_DIR = resolve(MIGRATIONS_DIR, "postconditions");

const MIGRATION_RE = /^(\d+_.+)\.sql$/;
const POSTCONDITION_RE = /^(\d+_.+)\.postcondition\.sql$/;

/** A migration's logical key, e.g. "004_player_stats_game_type". */
function migrationKeys(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .map((f) => MIGRATION_RE.exec(f)?.[1])
    .filter((k): k is string => k !== undefined)
    .sort();
}

/** A post-condition's logical key (the migration key it covers). */
function postconditionKeys(): string[] {
  return readdirSync(POSTCONDITIONS_DIR)
    .map((f) => POSTCONDITION_RE.exec(f)?.[1])
    .filter((k): k is string => k !== undefined)
    .sort();
}

export interface CoverageResult {
  /** Migrations that have no co-located post-condition file. */
  missing: string[];
  /** Post-condition files that do not correspond to any migration. */
  orphaned: string[];
}

/** Asserts 1:1 coverage between migrations and post-condition files. */
export function checkCoverage(): CoverageResult {
  const migrations = new Set(migrationKeys());
  const postconditions = new Set(postconditionKeys());

  const missing = [...migrations].filter((k) => !postconditions.has(k)).sort();
  const orphaned = [...postconditions].filter((k) => !migrations.has(k)).sort();

  return { missing, orphaned };
}

export interface PostconditionFailure {
  /** The migration key whose post-condition failed. */
  key: string;
  /** The RAISE EXCEPTION message (or other error) the post-condition produced. */
  message: string;
}

export interface VerifyResult {
  coverage: CoverageResult;
  /** Post-conditions that raised. Empty means every post-condition passed. */
  failures: PostconditionFailure[];
  /** True iff coverage is exact AND no post-condition raised. */
  ok: boolean;
}

export interface RunPostconditionsOptions {
  /**
   * When set, only postconditions whose key is lexicographically <= this value
   * are executed. Use when a fixture was only migrated up to a certain migration
   * and later postconditions cannot be satisfied (e.g. they reference live-only
   * schemas like `storage.*` or hardcode `nspname = 'public'`).
   *
   * Example: `upToKey: '012_prune_game_history'` runs 001..012 only.
   */
  upToKey?: string;
}

/**
 * Runs every post-condition against the provided (connected) client and reports
 * coverage + failures. Does not throw on a failed post-condition — collects it.
 * The caller decides how to fail (exit non-zero / expect()).
 *
 * Run order matches migration order so messages are deterministic.
 */
export async function runPostconditions(
  client: Client,
  options?: RunPostconditionsOptions,
): Promise<VerifyResult> {
  const coverage = checkCoverage();
  const failures: PostconditionFailure[] = [];

  const keys = options?.upToKey
    ? postconditionKeys().filter((k) => k <= options.upToKey!)
    : postconditionKeys();

  for (const key of keys) {
    try {
      await client.query(readPostconditionSql(`${key}.postcondition.sql`));
    } catch (err) {
      failures.push({
        key,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const coverageClean =
    coverage.missing.length === 0 && coverage.orphaned.length === 0;
  return { coverage, failures, ok: coverageClean && failures.length === 0 };
}
