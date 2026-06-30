import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error — plain ESM gate logic (no .d.ts); typed via JSDoc only.
import { evaluateDriftGate } from "../../scripts/lib/drift-gate.mjs";

const ROOT = resolve(__dirname, "../..");
function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(ROOT, rel), "utf8"));
}

// ---------------------------------------------------------------------------
// Drift-detection gate logic (LLD 77 §5). Pure-function unit tests against
// captured/fixture diffs — no prod, no DB. Proves: residual computation,
// fail-closed semantics, stale-allowlist detection, and that an
// acknowledgedResidual suppresses exactly its one object.
// ---------------------------------------------------------------------------

const emptyAllowlist = { expectedPending: [], acknowledgedResidual: [] };

describe("evaluateDriftGate — residual computation (§5.3)", () => {
  it("passes when observed − expected − acknowledged is empty", () => {
    const result = evaluateDriftGate({
      observed: [],
      expectedFromPending: [],
      allowlist: emptyAllowlist,
      actualPending: [],
    });
    expect(result.ok).toBe(true);
    expect(result.residual).toEqual([]);
    expect(result.reasons).toEqual([]);
  });

  it("fails (fail-closed) when an unexpected object remains in the residual", () => {
    const result = evaluateDriftGate({
      observed: [{ object: "constraint:player_stats:player_stats_pkey1" }],
      expectedFromPending: [],
      allowlist: emptyAllowlist,
      actualPending: [],
    });
    expect(result.ok).toBe(false);
    expect(result.residual).toEqual([
      "constraint:player_stats:player_stats_pkey1",
    ]);
    expect(result.reasons.join(" ")).toMatch(/Unexpected drift/);
  });

  it("subtracts diff objects attributable to applying expectedPending", () => {
    const result = evaluateDriftGate({
      observed: [{ object: "column:player_stats:deck_rounds_target" }],
      expectedFromPending: [
        { object: "column:player_stats:deck_rounds_target" },
      ],
      allowlist: {
        expectedPending: ["007_tonk_deck_rounds_target.sql"],
        acknowledgedResidual: [],
      },
      actualPending: ["007_tonk_deck_rounds_target.sql"],
    });
    expect(result.ok).toBe(true);
    expect(result.residual).toEqual([]);
  });
});

describe("evaluateDriftGate — acknowledgedResidual (§5.4)", () => {
  it("suppresses exactly the one acknowledged object and nothing else", () => {
    const result = evaluateDriftGate({
      observed: [
        { object: "grant:anon:games:INSERT" },
        { object: "grant:anon:player_stats:INSERT" },
      ],
      expectedFromPending: [],
      allowlist: {
        expectedPending: [],
        acknowledgedResidual: [
          {
            object: "grant:anon:games:INSERT",
            reason: "TypeORM-era residue; cleanup tracked",
            issue: "#83",
          },
        ],
      },
      actualPending: [],
    });
    // Only the un-acknowledged object remains → still fails, on that one object.
    expect(result.ok).toBe(false);
    expect(result.residual).toEqual(["grant:anon:player_stats:INSERT"]);
  });

  it("passes when every observed drift object is acknowledged", () => {
    const result = evaluateDriftGate({
      observed: [{ object: "grant:anon:games:INSERT" }],
      expectedFromPending: [],
      allowlist: {
        expectedPending: [],
        acknowledgedResidual: [
          { object: "grant:anon:games:INSERT", reason: "r", issue: "#83" },
        ],
      },
      actualPending: [],
    });
    expect(result.ok).toBe(true);
    expect(result.residual).toEqual([]);
  });

  it("flags an acknowledgedResidual entry that matched no observed drift", () => {
    const result = evaluateDriftGate({
      observed: [],
      expectedFromPending: [],
      allowlist: {
        expectedPending: [],
        acknowledgedResidual: [
          { object: "grant:anon:games:INSERT", reason: "r", issue: "#83" },
        ],
      },
      actualPending: [],
    });
    expect(result.ok).toBe(false);
    expect(result.unusedAcknowledged).toEqual(["grant:anon:games:INSERT"]);
    expect(result.reasons.join(" ")).toMatch(/matched no observed drift/);
  });
});

describe("evaluateDriftGate — stale-allowlist detection (§5.3 rule 5)", () => {
  it("fails when an expectedPending entry is already applied (not actually pending)", () => {
    const result = evaluateDriftGate({
      observed: [],
      expectedFromPending: [],
      allowlist: {
        expectedPending: ["006_fix_player_stats_composite_pk.sql"],
        acknowledgedResidual: [],
      },
      actualPending: [],
    });
    expect(result.ok).toBe(false);
    expect(result.staleExpected).toEqual([
      "006_fix_player_stats_composite_pk.sql",
    ]);
    expect(result.reasons.join(" ")).toMatch(/Stale expectedPending/);
  });

  it("fails when an actually-pending migration is missing from expectedPending", () => {
    const result = evaluateDriftGate({
      observed: [],
      expectedFromPending: [],
      allowlist: { expectedPending: [], acknowledgedResidual: [] },
      actualPending: ["007_tonk_deck_rounds_target.sql"],
    });
    expect(result.ok).toBe(false);
    expect(result.missingExpected).toEqual(["007_tonk_deck_rounds_target.sql"]);
    expect(result.reasons.join(" ")).toMatch(/missing from expectedPending/);
  });

  it("passes when expectedPending exactly equals the actually-pending set", () => {
    const result = evaluateDriftGate({
      observed: [],
      expectedFromPending: [],
      allowlist: {
        expectedPending: ["007_tonk_deck_rounds_target.sql"],
        acknowledgedResidual: [],
      },
      actualPending: ["007_tonk_deck_rounds_target.sql"],
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LLD 95: 009_add_game_config.sql is pending against prod. The drift gate must
// pass against the in-tree fixture + allowlist, and the fixture<->allowlist
// coupling (Edge Case 8) is enforced: 009 must be in BOTH the fixture's pending
// array AND the allowlist's expectedPending, else the gate fails staleExpected.
// ---------------------------------------------------------------------------
describe("evaluateDriftGate — 009 game_config pending (LLD 95 §Edge Case 8)", () => {
  const fixture = readJson("scripts/fixtures/clean-diff.json");
  const allowlist = readJson(
    "supabase/migrations/expected-diff.allowlist.json",
  );

  function gateWith(actualPending: string[]) {
    return evaluateDriftGate({
      observed: (fixture.objects as { object: string }[]) ?? [],
      expectedFromPending:
        (fixture.expectedFromPending as { object: string }[]) ?? [],
      allowlist: {
        expectedPending: (allowlist.expectedPending as string[]) ?? [],
        acknowledgedResidual:
          (allowlist.acknowledgedResidual as unknown[]) ?? [],
      },
      actualPending,
    });
  }

  it("the in-tree fixture lists 009 as pending and the allowlist expects it", () => {
    expect(fixture.pending).toContain("009_add_game_config.sql");
    expect(allowlist.expectedPending).toContain("009_add_game_config.sql");
  });

  it("passes against the real fixture + allowlist as shipped", () => {
    const result = gateWith(fixture.pending as string[]);
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("fails staleExpected when 009 is dropped from the fixture's pending (documents the coupling)", () => {
    // Simulate forgetting to add 009 to clean-diff.json's pending array while it
    // remains in the allowlist's expectedPending — the exact CI trap (Edge Case 8).
    const result = gateWith(["010_create_game_history.sql"]);
    expect(result.ok).toBe(false);
    expect(result.staleExpected).toContain("009_add_game_config.sql");
    expect(result.reasons.join(" ")).toMatch(/Stale expectedPending/);
  });
});

// ---------------------------------------------------------------------------
// LLD 101: 010_create_game_history.sql is pending against prod. Same fixture
// <-> allowlist coupling rule as 009 (drift-gate stale-allowlist, the PR #107
// footgun): 010 must be in BOTH the fixture's pending array AND the allowlist's
// expectedPending, else the gate fails staleExpected.
// ---------------------------------------------------------------------------
describe("evaluateDriftGate — 010 game_history pending (LLD 101)", () => {
  const fixture = readJson("scripts/fixtures/clean-diff.json");
  const allowlist = readJson(
    "supabase/migrations/expected-diff.allowlist.json",
  );

  function gateWith(actualPending: string[]) {
    return evaluateDriftGate({
      observed: (fixture.objects as { object: string }[]) ?? [],
      expectedFromPending:
        (fixture.expectedFromPending as { object: string }[]) ?? [],
      allowlist: {
        expectedPending: (allowlist.expectedPending as string[]) ?? [],
        acknowledgedResidual:
          (allowlist.acknowledgedResidual as unknown[]) ?? [],
      },
      actualPending,
    });
  }

  it("the in-tree fixture lists 010 as pending and the allowlist expects it", () => {
    expect(fixture.pending).toContain("010_create_game_history.sql");
    expect(allowlist.expectedPending).toContain("010_create_game_history.sql");
  });

  it("passes against the real fixture + allowlist as shipped", () => {
    const result = gateWith(fixture.pending as string[]);
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("fails staleExpected when 010 is dropped from the fixture's pending (documents the coupling)", () => {
    // 010 stays in expectedPending but is dropped from the actually-pending set
    // — the stale-allowlist trap that reddened PR #107 (Edge Case 8).
    const result = gateWith(["009_add_game_config.sql"]);
    expect(result.ok).toBe(false);
    expect(result.staleExpected).toContain("010_create_game_history.sql");
    expect(result.reasons.join(" ")).toMatch(/Stale expectedPending/);
  });
});
