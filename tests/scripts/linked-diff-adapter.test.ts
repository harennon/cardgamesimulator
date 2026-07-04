import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  adaptLinkedDiff,
  classifyStatement,
  splitDdlStatements,
  parseMigrationList,
  mapVersionKeysToFiles,
  pendingDeclaredObjects,
  LinkedDiffError,
  // @ts-expect-error — plain ESM adapter (no .d.ts); typed via JSDoc only.
} from "../../scripts/lib/linked-diff-adapter.mjs";
// @ts-expect-error — plain ESM gate logic (no .d.ts); typed via JSDoc only.
import { evaluateDriftGate } from "../../scripts/lib/drift-gate.mjs";

const ROOT = resolve(__dirname, "../..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase/migrations");
const LINKED = resolve(ROOT, "scripts/fixtures/linked");

function readFixture(name: string): string {
  return readFileSync(resolve(LINKED, name), "utf8");
}
function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(ROOT, rel), "utf8"));
}

/** Real in-tree migrations (basename + SQL), the same input verify-drift.mjs feeds. */
function inTreeMigrations(): { file: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({
      file: f,
      sql: readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"),
    }));
}

type Adapted = {
  objects: { object: string }[];
  expectedFromPending: { object: string }[];
  pending: string[];
};
const ids = (a: Adapted): string[] => a.objects.map((o) => o.object).sort();

// ---------------------------------------------------------------------------
// Linked-prod drift adapter (LLD 77a, issue #91). Pure-function unit tests
// against CAPTURED raw-output fixtures — no prod, no DB, no network. Proves the
// raw db-diff / migration-list text → { objects, expectedFromPending, pending }
// normalization, the confirmed-direction attribution (Gap B) + cross-consistency
// (Gap A), the version-key mapping (A4), and every fail-closed path (F2–F7).
// ---------------------------------------------------------------------------

describe("classifyStatement — the residual object-id grammar", () => {
  it("classifies an ADD-CONSTRAINT (residual add) into constraint:<t>:<name>", () => {
    const [c] = classifyStatement(
      'alter table "public"."player_stats" add constraint "player_stats_pkey1" PRIMARY KEY using index "player_stats_pkey1"',
    );
    expect(c.object).toBe("constraint:player_stats:player_stats_pkey1");
    expect(c.direction).toBe("add");
    expect(c.table).toBe("player_stats");
  });

  it("classifies a DROP CONSTRAINT (prod-missing) into constraint:<t>:<name> with drop direction", () => {
    const [c] = classifyStatement(
      'alter table "public"."game_history" drop constraint "game_history_pkey"',
    );
    expect(c.object).toBe("constraint:game_history:game_history_pkey");
    expect(c.direction).toBe("drop");
  });

  it("classifies a GRANT with one privilege into grant:<role>:<t>:<PRIV> (add)", () => {
    const [g] = classifyStatement(
      'grant insert on table "public"."player_stats" to "anon"',
    );
    expect(g.object).toBe("grant:anon:player_stats:INSERT");
    expect(g.direction).toBe("add");
  });

  it("classifies a REVOKE as a drop-direction grant object", () => {
    const [g] = classifyStatement(
      'revoke select on table "public"."game_history" from "authenticated"',
    );
    expect(g.object).toBe("grant:authenticated:game_history:SELECT");
    expect(g.direction).toBe("drop");
  });

  it("emits one id per privilege for a multi-privilege grant", () => {
    const objs = classifyStatement(
      'grant insert, update on table "public"."games" to "anon"',
    );
    expect(objs.map((o: { object: string }) => o.object)).toEqual([
      "grant:anon:games:INSERT",
      "grant:anon:games:UPDATE",
    ]);
  });

  it("classifies DROP TABLE / DROP INDEX / DROP FUNCTION forms", () => {
    expect(
      classifyStatement('drop table "public"."game_history"')[0].object,
    ).toBe("table:public:game_history");
    expect(
      classifyStatement(
        'drop index if exists "public"."idx_game_history_user_played"',
      )[0].object,
    ).toBe("index:public:idx_game_history_user_played");
    expect(
      classifyStatement(
        'drop function if exists "public"."get_windowed_stats"(p_user_id uuid, p_since timestamp with time zone)',
      )[0].object,
    ).toBe("function:public:get_windowed_stats");
  });

  it("classifies an unquoted CREATE OR REPLACE FUNCTION (the increment_player_stats residual)", () => {
    const [f] = classifyStatement(
      "CREATE OR REPLACE FUNCTION public.increment_player_stats(p_user_id uuid, p_game_type character varying)\n RETURNS void",
    );
    expect(f.object).toBe("function:public:increment_player_stats");
    expect(f.direction).toBe("add");
  });

  it("ignores session-state preamble (set check_function_bodies)", () => {
    expect(classifyStatement("set check_function_bodies = off")).toEqual([]);
  });

  it("THROWS on an unclassifiable statement (F3)", () => {
    expect(() =>
      classifyStatement(
        'alter table "public"."player_stats" enable row level security',
      ),
    ).toThrow(LinkedDiffError);
  });
});

describe("splitDdlStatements — statement boundaries", () => {
  it("splits on ; outside dollar-quoted bodies and drops CLI noise lines", () => {
    const raw = readFixture("db-diff.residual-drift.txt");
    const stmts = splitDdlStatements(raw);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toMatch(/^grant insert/i);
    expect(stmts[1]).toMatch(/add constraint/i);
  });

  it("keeps a function body (with embedded ;) as ONE statement", () => {
    const stmts = splitDdlStatements(readFixture("db-diff.pending-010.txt"));
    const fn = stmts.filter((s) => /increment_player_stats/i.test(s));
    // The whole CREATE OR REPLACE FUNCTION ... $function$ ... $function$ is one
    // statement despite the semicolons inside the body.
    expect(fn).toHaveLength(1);
    expect(fn[0]).toMatch(/\$function\$/);
    expect(fn[0]).toMatch(/last_played_at = NOW\(\)/);
  });
});

describe("parseMigrationList — pending vs applied (V5, A4)", () => {
  it("reads 010 as pending (blank Remote) and 001-009 as applied — REAL capture", () => {
    const { pendingKeys, appliedKeys } = parseMigrationList(
      readFixture("migration-list.pending-010.txt"),
    );
    expect(pendingKeys).toEqual(["010"]);
    expect(appliedKeys).toEqual([
      "001",
      "002",
      "003",
      "004",
      "005",
      "006",
      "007",
      "008",
      "009",
    ]);
  });

  it("reports no pending when every migration has a Remote", () => {
    const { pendingKeys } = parseMigrationList(
      readFixture("migration-list.all-applied.txt"),
    );
    expect(pendingKeys).toEqual([]);
  });

  it("ignores the 'Skipping migration ....json' warnings for the allowlist files", () => {
    const { appliedKeys } = parseMigrationList(
      readFixture("migration-list.all-applied.txt"),
    );
    // The .json warnings must never be parsed as version keys.
    expect(appliedKeys).not.toContain("expected-diff.allowlist.json");
    expect(appliedKeys).not.toContain("destructive-ddl.allowlist.json");
  });

  it("THROWS on a malformed table with no data rows (F6)", () => {
    expect(() =>
      parseMigrationList(readFixture("migration-list.malformed.txt")),
    ).toThrow(LinkedDiffError);
  });
});

describe("mapVersionKeysToFiles — version-key mapping (§4.4 step 4, A4)", () => {
  const files = ["009_add_game_config.sql", "010_create_game_history.sql"];

  it("maps the bare numeric prefix form ('010') to the in-tree filename", () => {
    expect(mapVersionKeysToFiles(["010"], files)).toEqual([
      "010_create_game_history.sql",
    ]);
  });

  it("also maps the full-basename form (guards A4 both ways)", () => {
    expect(
      mapVersionKeysToFiles(["010_create_game_history.sql"], files),
    ).toEqual(["010_create_game_history.sql"]);
  });

  it("THROWS when a pending key maps to zero in-tree files (F5)", () => {
    expect(() => mapVersionKeysToFiles(["999"], files)).toThrow(
      LinkedDiffError,
    );
  });
});

describe("pendingDeclaredObjects — what a pending migration declares (Gap A/B source)", () => {
  it("collects the created table + function names from migration 010", () => {
    const mig010 = inTreeMigrations().find((m) => m.file.startsWith("010_"))!;
    const { tables, functions, byName } = pendingDeclaredObjects([mig010]);
    expect(tables.has("game_history")).toBe(true);
    expect(functions.has("get_windowed_stats")).toBe(true);
    expect(byName.get("game_history")).toBe("010_create_game_history.sql");
  });
});

describe("adaptLinkedDiff — REAL pending-010 capture (Gap B worked example)", () => {
  const adapted = adaptLinkedDiff(
    {
      dbDiffStdout: readFixture("db-diff.pending-010.txt"),
      migrationListStdout: readFixture("migration-list.pending-010.txt"),
    },
    inTreeMigrations(),
  ) as Adapted;

  it("derives pending = [010] only (009 is applied per the real capture)", () => {
    expect(adapted.pending).toEqual(["010_create_game_history.sql"]);
  });

  it("drops the ENTIRE game_history cluster as attributable to pending 010", () => {
    // table + 2 indexes + pkey constraint + 15 revokes + get_windowed_stats — none
    // may survive as residual; every piece attributes to migration 010 (Gap B).
    const surviving = ids(adapted);
    expect(surviving).not.toContain("table:public:game_history");
    expect(surviving).not.toContain("index:public:game_history_pkey");
    expect(surviving).not.toContain(
      "index:public:idx_game_history_user_played",
    );
    expect(surviving).not.toContain(
      "constraint:game_history:game_history_pkey",
    );
    expect(surviving).not.toContain("function:public:get_windowed_stats");
    expect(
      surviving.filter((id) => id.includes(":game_history:")),
    ).toHaveLength(0);
    expect(surviving.filter((id) => id.includes("game_history"))).toHaveLength(
      0,
    );
  });

  it("surfaces increment_player_stats as the LONE residual (not attributable to pending)", () => {
    expect(ids(adapted)).toEqual(["function:public:increment_player_stats"]);
  });

  it("keeps expectedFromPending empty (E1 seam)", () => {
    expect(adapted.expectedFromPending).toEqual([]);
  });
});

describe("adaptLinkedDiff — clean sentinel", () => {
  it("returns objects: [] on the exact 'No schema changes found' sentinel", () => {
    const adapted = adaptLinkedDiff(
      {
        dbDiffStdout: readFixture("db-diff.clean.txt"),
        migrationListStdout: readFixture("migration-list.all-applied.txt"),
      },
      inTreeMigrations(),
    ) as Adapted;
    expect(adapted.objects).toEqual([]);
    expect(adapted.pending).toEqual([]);
  });
});

describe("adaptLinkedDiff — fail-closed paths", () => {
  it("F3: THROWS on an unclassifiable db diff statement", () => {
    expect(() =>
      adaptLinkedDiff(
        {
          dbDiffStdout: readFixture("db-diff.unclassifiable.txt"),
          migrationListStdout: readFixture("migration-list.all-applied.txt"),
        },
        inTreeMigrations(),
      ),
    ).toThrow(LinkedDiffError);
  });

  it("F4: THROWS on empty-but-not-sentinel db diff output", () => {
    expect(() =>
      adaptLinkedDiff(
        {
          dbDiffStdout: readFixture("db-diff.empty-not-sentinel.txt"),
          migrationListStdout: readFixture("migration-list.all-applied.txt"),
        },
        inTreeMigrations(),
      ),
    ).toThrow(LinkedDiffError);
  });

  it("F5: THROWS when a pending version key maps to no in-tree file", () => {
    expect(() =>
      adaptLinkedDiff(
        {
          dbDiffStdout: readFixture("db-diff.clean.txt"),
          migrationListStdout: readFixture("migration-list.unmappable.txt"),
        },
        inTreeMigrations(),
      ),
    ).toThrow(LinkedDiffError);
  });

  it("F6: THROWS on a malformed migration list table", () => {
    expect(() =>
      adaptLinkedDiff(
        {
          dbDiffStdout: readFixture("db-diff.clean.txt"),
          migrationListStdout: readFixture("migration-list.malformed.txt"),
        },
        inTreeMigrations(),
      ),
    ).toThrow(LinkedDiffError);
  });

  it("Gap A: a prod-missing DROP not attributable to any pending migration is surfaced as residual, never silently dropped", () => {
    // A drop of an object from an ALREADY-APPLIED migration (nothing pending) must
    // NOT be swallowed — it is real drift. Here `player_stats` is not a pending
    // table, so a drop of its constraint surfaces as residual.
    const dbDiffStdout = [
      "Diffing schemas: public",
      "",
      'alter table "public"."player_stats" drop constraint "player_stats_pkey";',
      "",
    ].join("\n");
    const adapted = adaptLinkedDiff(
      {
        dbDiffStdout,
        migrationListStdout: readFixture("migration-list.all-applied.txt"),
      },
      inTreeMigrations(),
    ) as Adapted;
    expect(ids(adapted)).toContain("constraint:player_stats:player_stats_pkey");
  });
});

// ---------------------------------------------------------------------------
// Index attribution must NOT over-match on a coincidental substring. A DROP INDEX
// names only the index, not its table; attribution resolves the index's true
// owning table as the LONGEST in-tree table matching the naming convention, so a
// short pending table name that merely prefixes a longer applied table's index
// cannot silently swallow a genuine residual (code-review Finding: latent
// silent-pass). Self-contained synthetic migrations per testing-principles.
// ---------------------------------------------------------------------------
describe("adaptLinkedDiff — index attribution rejects coincidental substrings", () => {
  // Applied migration owns `game_history` + its index; a SEPARATE pending
  // migration declares a SHORT table `game` whose name prefixes the index.
  const migrations = [
    {
      file: "001_applied.sql",
      sql: "CREATE TABLE game_history (id uuid);\nCREATE INDEX idx_game_history_user_played ON game_history (id);",
    },
    { file: "002_pending_game.sql", sql: "CREATE TABLE game (id uuid);" },
  ];
  const listGamePending = [
    "   Local | Remote | Time (UTC)",
    "  -------|--------|------------",
    "   `001` | `001`  | `001`",
    "   `002` | ` `    | `002`",
  ].join("\n");

  it("surfaces a genuine drop of an APPLIED table's index as residual (does NOT attribute to the short pending `game`)", () => {
    const dbDiffStdout = [
      "Diffing schemas: public",
      "",
      'drop index if exists "public"."idx_game_history_user_played";',
      "",
    ].join("\n");
    const adapted = adaptLinkedDiff(
      { dbDiffStdout, migrationListStdout: listGamePending },
      migrations,
    ) as Adapted;
    // The index is owned by the APPLIED `game_history` (longest match), not the
    // pending `game`, so it must survive as residual, not be swallowed.
    expect(ids(adapted)).toContain("index:public:idx_game_history_user_played");
  });

  it("still attributes an index to its OWN pending table (happy path)", () => {
    // Now `game_history` itself is the pending migration; its index must be
    // attributed and dropped (not surfaced).
    const migrationsPendingOwner = [
      {
        file: "001_pending_gh.sql",
        sql: "CREATE TABLE game_history (id uuid);\nCREATE INDEX idx_game_history_user_played ON game_history (id);",
      },
    ];
    const listOwnerPending = [
      "   Local | Remote | Time (UTC)",
      "  -------|--------|------------",
      "   `001` | ` `    | `001`",
    ].join("\n");
    const dbDiffStdout = [
      "Diffing schemas: public",
      "",
      'drop index if exists "public"."idx_game_history_user_played";',
      "",
    ].join("\n");
    const adapted = adaptLinkedDiff(
      { dbDiffStdout, migrationListStdout: listOwnerPending },
      migrationsPendingOwner,
    ) as Adapted;
    expect(ids(adapted)).not.toContain(
      "index:public:idx_game_history_user_played",
    );
    expect(adapted.objects).toEqual([]);
  });

  it("REAL capture: idx_game_history_user_played still attributes to pending game_history", () => {
    const adapted = adaptLinkedDiff(
      {
        dbDiffStdout: readFixture("db-diff.pending-010.txt"),
        migrationListStdout: readFixture("migration-list.pending-010.txt"),
      },
      inTreeMigrations(),
    ) as Adapted;
    expect(
      ids(adapted).filter((id) => id.includes("game_history")),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: raw CLI text → adapter → the REAL evaluateDriftGate + the shipped
// allowlist. Still credential-free. Proves the raw→structured→verdict chain.
// ---------------------------------------------------------------------------
describe("adaptLinkedDiff → evaluateDriftGate (end-to-end, credential-free)", () => {
  const allowlist = readJson(
    "supabase/migrations/expected-diff.allowlist.json",
  );

  function gate(a: Adapted) {
    return evaluateDriftGate({
      observed: a.objects,
      expectedFromPending: a.expectedFromPending,
      allowlist: {
        expectedPending: (allowlist.expectedPending as string[]) ?? [],
        acknowledgedResidual:
          (allowlist.acknowledgedResidual as unknown[]) ?? [],
      },
      actualPending: a.pending,
    });
  }

  it("REAL pending-010 capture PASSES (game_history cluster dropped; increment_player_stats acknowledged)", () => {
    const adapted = adaptLinkedDiff(
      {
        dbDiffStdout: readFixture("db-diff.pending-010.txt"),
        migrationListStdout: readFixture("migration-list.pending-010.txt"),
      },
      inTreeMigrations(),
    ) as Adapted;
    const result = gate(adapted);
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("SYNTHETIC genuine-drift capture FAILS (non-attributable, non-acknowledged residual)", () => {
    const adapted = adaptLinkedDiff(
      {
        dbDiffStdout: readFixture("db-diff.residual-drift.txt"),
        migrationListStdout: readFixture("migration-list.all-applied.txt"),
      },
      inTreeMigrations(),
    ) as Adapted;
    const result = gate(adapted);
    expect(result.ok).toBe(false);
    expect(result.residual).toContain(
      "constraint:player_stats:player_stats_pkey1",
    );
    expect(result.residual).toContain("grant:anon:player_stats:INSERT");
    expect(result.reasons.join(" ")).toMatch(/Unexpected drift/);
  });
});
