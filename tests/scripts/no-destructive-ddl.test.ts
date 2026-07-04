import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  findDestructiveOps,
  evaluateDestructiveDdl,
  stripCommentsAndStrings,
  // @ts-expect-error — plain ESM gate logic (no .d.ts); typed via JSDoc only.
} from "../../scripts/lib/destructive-ddl.mjs";

const ROOT = resolve(__dirname, "../..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase/migrations");

type Op = { op: string; line: number; text: string };
const ops = (sql: string): Op[] => findDestructiveOps(sql) as Op[];
const opNames = (sql: string): string[] => ops(sql).map((o) => o.op);

// ---------------------------------------------------------------------------
// Destructive-DDL gate (issue #91). Scope is DATA safety: banned = DROP TABLE,
// ALTER TABLE ... DROP COLUMN, DELETE (FROM), TRUNCATE. DROP FUNCTION / DROP INDEX
// destroy no data and are NOT gated. Pure-function unit tests against inline SQL
// — no filesystem, no DB. Proves: each data-destroying statement is caught (incl.
// IF EXISTS + whitespace/case variants), code/derived-object drops pass,
// comments/strings never false-positive, non-destructive DROP/REVOKE forms are
// ignored, allowlist gates per-file + per-operation, and the real 001-010
// migrations pass clean with an empty allowlist.
// ---------------------------------------------------------------------------

describe("findDestructiveOps — clean SQL passes", () => {
  it("finds nothing in an add-only CREATE/ALTER migration", () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS t (id UUID PRIMARY KEY, name TEXT NOT NULL);
      ALTER TABLE t ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}'::jsonb;
      CREATE INDEX IF NOT EXISTS idx_t_name ON t (name);
    `;
    expect(ops(sql)).toEqual([]);
  });
});

describe("findDestructiveOps — each data-destroying statement type is caught", () => {
  it("catches DROP TABLE", () => {
    expect(opNames("DROP TABLE games;")).toEqual(["DROP TABLE"]);
  });

  it("catches DROP TABLE IF EXISTS", () => {
    expect(opNames("DROP TABLE IF EXISTS games;")).toEqual(["DROP TABLE"]);
  });

  it("catches ALTER TABLE ... DROP COLUMN", () => {
    expect(opNames("ALTER TABLE games DROP COLUMN join_code;")).toEqual([
      "DROP COLUMN",
    ]);
  });

  it("catches DROP COLUMN IF EXISTS", () => {
    expect(
      opNames("ALTER TABLE games DROP COLUMN IF EXISTS join_code;"),
    ).toEqual(["DROP COLUMN"]);
  });

  it("catches DELETE (as DELETE FROM)", () => {
    expect(
      opNames("DELETE FROM player_stats WHERE user_id = '00000000';"),
    ).toEqual(["DELETE"]);
  });

  it("catches TRUNCATE", () => {
    expect(opNames("TRUNCATE player_stats;")).toEqual(["TRUNCATE"]);
    expect(opNames("TRUNCATE TABLE player_stats;")).toEqual(["TRUNCATE"]);
  });
});

describe("findDestructiveOps — code/derived-object drops are NOT gated (destroy no data)", () => {
  it("does not flag DROP FUNCTION (incl. IF EXISTS)", () => {
    expect(ops("DROP FUNCTION increment_player_stats(UUID);")).toEqual([]);
    expect(
      ops("DROP FUNCTION IF EXISTS increment_player_stats(UUID);"),
    ).toEqual([]);
  });

  it("does not flag DROP INDEX (incl. IF EXISTS)", () => {
    expect(ops("DROP INDEX idx_games_status;")).toEqual([]);
    expect(ops("DROP INDEX IF EXISTS idx_games_status;")).toEqual([]);
  });
});

describe("findDestructiveOps — formatting robustness", () => {
  it("is case-insensitive", () => {
    expect(opNames("drop table games;")).toEqual(["DROP TABLE"]);
    expect(opNames("Delete From games where 1=1;")).toEqual(["DELETE"]);
  });

  it("tolerates extra whitespace between keywords", () => {
    expect(opNames("DROP   TABLE games;")).toEqual(["DROP TABLE"]);
  });

  it("tolerates newlines/tabs between keywords", () => {
    expect(opNames("DROP\n  TABLE IF EXISTS games;")).toEqual(["DROP TABLE"]);
    expect(opNames("ALTER TABLE t DROP\tCOLUMN c;")).toEqual(["DROP COLUMN"]);
  });

  it("reports the correct 1-indexed line", () => {
    const sql = "SELECT 1;\nSELECT 2;\nDROP TABLE games;\n";
    expect(ops(sql)).toEqual([
      { op: "DROP TABLE", line: 3, text: "DROP TABLE" },
    ]);
  });
});

describe("findDestructiveOps — comments and string literals never false-positive", () => {
  it("ignores a banned keyword in a line comment", () => {
    expect(ops("-- DROP TABLE games would be bad\nSELECT 1;")).toEqual([]);
  });

  it("ignores a banned keyword in a block comment (multi-line)", () => {
    expect(
      ops("/* TODO: maybe\n DROP TABLE games;\n later */\nSELECT 1;"),
    ).toEqual([]);
  });

  it("ignores a banned keyword inside a string literal", () => {
    expect(
      ops("INSERT INTO log (msg) VALUES ('DELETE FROM everything');"),
    ).toEqual([]);
  });

  it("ignores banned keywords across '' escaped quotes in a string", () => {
    expect(ops("RAISE EXCEPTION 'don''t TRUNCATE the table';")).toEqual([]);
  });

  it("still catches a real statement that follows a comment on the same file", () => {
    const sql = "-- comment mentioning TRUNCATE\nTRUNCATE games;";
    expect(ops(sql)).toEqual([{ op: "TRUNCATE", line: 2, text: "TRUNCATE" }]);
  });
});

describe("findDestructiveOps — non-destructive DROP/REVOKE forms are ignored", () => {
  it("does not flag ALTER COLUMN ... DROP DEFAULT", () => {
    expect(
      ops("ALTER TABLE player_stats ALTER COLUMN game_type DROP DEFAULT;"),
    ).toEqual([]);
  });

  it("does not flag DROP CONSTRAINT (incl. IF EXISTS)", () => {
    expect(
      ops(
        "ALTER TABLE player_stats DROP CONSTRAINT IF EXISTS player_stats_pkey;",
      ),
    ).toEqual([]);
  });

  it("does not flag the DELETE privilege token in GRANT/REVOKE", () => {
    expect(
      ops("GRANT SELECT, INSERT, UPDATE, DELETE ON games TO authenticated;"),
    ).toEqual([]);
    expect(ops("REVOKE INSERT, UPDATE, DELETE ON games FROM anon;")).toEqual(
      [],
    );
  });
});

describe("stripCommentsAndStrings — preserves offsets", () => {
  it("blanks comments/strings but keeps length and newlines", () => {
    const sql = "SELECT 1; -- DROP TABLE x\nTRUNCATE y;";
    const cleaned = stripCommentsAndStrings(sql);
    expect(cleaned.length).toBe(sql.length);
    // Newlines preserved so line numbers are stable.
    expect(cleaned.split("\n").length).toBe(sql.split("\n").length);
    // The comment text is gone; the real statement survives.
    expect(cleaned).not.toContain("DROP TABLE");
    expect(cleaned).toContain("TRUNCATE");
  });
});

describe("evaluateDestructiveDdl — allowlist gating (fail-closed)", () => {
  it("fails a destructive statement with no allowlist entry", () => {
    const result = evaluateDestructiveDdl(
      [{ file: "099_bad.sql", sql: "DROP TABLE games;" }],
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(["099_bad.sql: DROP TABLE (line 1)"]);
  });

  it("passes when the destructive op is allowlisted for that file", () => {
    const result = evaluateDestructiveDdl(
      [{ file: "099_dedup.sql", sql: "DELETE FROM games WHERE id IS NULL;" }],
      { "099_dedup.sql": ["DELETE"] },
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("still fails a destructive op NOT covered by that file's allowlist entry", () => {
    // File is allowlisted for DELETE only; the DROP TABLE is still a violation.
    const result = evaluateDestructiveDdl(
      [
        {
          file: "099_mixed.sql",
          sql: "DELETE FROM games WHERE id IS NULL;\nDROP TABLE feedback;",
        },
      ],
      { "099_mixed.sql": ["DELETE"] },
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(["099_mixed.sql: DROP TABLE (line 2)"]);
  });

  it("does not let one file's allowlist entry cover another file", () => {
    const result = evaluateDestructiveDdl(
      [
        { file: "a.sql", sql: "DROP TABLE t;" },
        { file: "b.sql", sql: "DROP TABLE t;" },
      ],
      { "a.sql": ["DROP TABLE"] },
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(["b.sql: DROP TABLE (line 1)"]);
  });
});

// ---------------------------------------------------------------------------
// The committed migrations 001-010 must PASS the gate as shipped. Under the
// data-safety scope none of them contains a data-destroying statement — 005's
// DROP FUNCTION and the various DROP INDEX/CONSTRAINT/DEFAULT and GRANT/REVOKE
// DELETE forms are all outside the ban — so the gate passes with an EMPTY
// allowlist. If a future migration trips the gate, this test surfaces it rather
// than the rule being silently loosened.
// ---------------------------------------------------------------------------
describe("evaluateDestructiveDdl — real migrations 001-010 pass with an empty allowlist", () => {
  const allMigrations = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()
    .map((file) => ({
      file,
      sql: readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"),
    }));
  // Isolate only 001-010 for the empty-allowlist invariant check.
  const migrations001to010 = allMigrations.filter((m) =>
    /^0(0[1-9]|10)_/.test(m.file),
  );

  it("scans all committed migrations (at least 10)", () => {
    expect(allMigrations.length).toBeGreaterThanOrEqual(10);
  });

  it("migrations 001-010 contain zero data-destroying statements (nothing to allowlist)", () => {
    const result = evaluateDestructiveDdl(migrations001to010, {});
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // LLD 149: migration 011 (prune_game_history) introduces a reviewed DELETE.
  // The gate MUST flag it without the allowlist entry, and MUST pass with it.
  // The allowlist entry must be exactly {DELETE} — not an over-broad exception.
  // ---------------------------------------------------------------------------
  it("migration 011 is flagged by the gate without an allowlist entry (gate is load-bearing)", () => {
    const m011 = allMigrations.find(
      (m) => m.file === "011_prune_game_history.sql",
    );
    expect(m011).toBeDefined();
    const result = evaluateDestructiveDdl([m011!], {});
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining(["011_prune_game_history.sql: DELETE (line 15)"]),
    );
  });

  it("migration 011 reports exactly one DELETE op (not DROP TABLE/COLUMN/TRUNCATE)", () => {
    const m011 = allMigrations.find(
      (m) => m.file === "011_prune_game_history.sql",
    );
    expect(m011).toBeDefined();
    const result = evaluateDestructiveDdl([m011!], {});
    expect(result.findings).toHaveLength(1);
    const ops011 = result.findings[0]!.ops;
    expect(ops011).toHaveLength(1);
    expect(ops011[0]!.op).toBe("DELETE");
  });

  it("all migrations 001-011 pass the gate with the shipped allowlist", () => {
    const raw = JSON.parse(
      readFileSync(
        resolve(MIGRATIONS_DIR, "destructive-ddl.allowlist.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const { $comment: _c, ...allowlist } = raw;
    const result = evaluateDestructiveDdl(allMigrations, allowlist);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("the shipped allowlist has exactly one entry (011_prune_game_history.sql: DELETE)", () => {
    const raw = JSON.parse(
      readFileSync(
        resolve(MIGRATIONS_DIR, "destructive-ddl.allowlist.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const { $comment: _c, ...allowlist } = raw;
    expect(Object.keys(allowlist)).toEqual(["011_prune_game_history.sql"]);
    expect(allowlist["011_prune_game_history.sql"]).toEqual(["DELETE"]);
  });
});
