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
// LLD 95 / 77a: 009_add_game_config.sql is APPLIED to prod. The real capture
// (2026-07-04, scripts/fixtures/captures/prod-migration-list.txt) shows Remote=009
// — so 009 is NOT pending and must NOT be in expectedPending / clean-diff.json's
// pending, or the gate correctly fails staleExpected. This is the reconciled state
// (was pending pre-capture; LLD 77a §8.2 required reconciling fixtures to reality).
// ---------------------------------------------------------------------------
describe("evaluateDriftGate — 009 game_config APPLIED (LLD 77a reconciliation)", () => {
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

  it("009 is applied to prod, so it is NOT in the fixture's pending nor the allowlist", () => {
    expect(fixture.pending).not.toContain("009_add_game_config.sql");
    expect(allowlist.expectedPending).not.toContain("009_add_game_config.sql");
  });

  it("fails staleExpected if 009 (already applied) is falsely still expected-pending", () => {
    // Simulate the stale-allowlist trap: 009 remains in expectedPending after it
    // was applied to prod. The gate must catch it (Edge Case 8 / PR #107 footgun).
    const result = evaluateDriftGate({
      observed: (fixture.objects as { object: string }[]) ?? [],
      expectedFromPending:
        (fixture.expectedFromPending as { object: string }[]) ?? [],
      allowlist: {
        expectedPending: [
          "009_add_game_config.sql",
          ...((allowlist.expectedPending as string[]) ?? []),
        ],
        acknowledgedResidual:
          (allowlist.acknowledgedResidual as unknown[]) ?? [],
      },
      actualPending: fixture.pending as string[],
    });
    expect(result.ok).toBe(false);
    expect(result.staleExpected).toContain("009_add_game_config.sql");
    expect(result.reasons.join(" ")).toMatch(/Stale expectedPending/);
  });

  it("fails missingExpected if 009 becomes actually-pending again but is not allowlisted", () => {
    // The mirror trap: a rollback makes 009 pending on prod again; the allowlist
    // must be updated or the gate blocks (the #156 property).
    const result = gateWith([
      "009_add_game_config.sql",
      ...(fixture.pending as string[]),
    ]);
    expect(result.ok).toBe(false);
    expect(result.missingExpected).toContain("009_add_game_config.sql");
    expect(result.reasons.join(" ")).toMatch(/missing from expectedPending/);
  });
});

// ---------------------------------------------------------------------------
// LLD 011: 010 is now APPLIED to prod (post-010 capture, Remote=010) and
// 011_lock_down_game_history.sql is pending. The Phase-0 allowlist acknowledges
// the six game_history stray write grants (G6) that 011 REVOKEs; 011's own
// ENABLE RLS + CREATE POLICY are self-attributed to pending 011 by the adapter
// (LLD 77b) and never reach the fixture's objects. Same fixture <-> allowlist
// coupling rule as 009/010 (the PR #107 footgun): 011 must be in BOTH the
// fixture's pending array AND the allowlist's expectedPending, else the gate
// fails staleExpected.
// ---------------------------------------------------------------------------
const G6 = [
  "grant:anon:game_history:DELETE",
  "grant:anon:game_history:INSERT",
  "grant:anon:game_history:UPDATE",
  "grant:authenticated:game_history:DELETE",
  "grant:authenticated:game_history:INSERT",
  "grant:authenticated:game_history:UPDATE",
];

describe("evaluateDriftGate — 011 game_history lockdown pending (LLD 011)", () => {
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

  it("Phase 2 (011 applied): nothing pending, allowlist expects nothing, G6 removed", () => {
    // 011 has been applied to prod (Prod Migrate run 2026-07-04), so it is no
    // longer pending; 010 was applied earlier. Both are absent from pending and
    // expectedPending.
    expect(fixture.pending).toEqual([]);
    expect(allowlist.expectedPending).toEqual([]);
    expect(fixture.pending).not.toContain("011_lock_down_game_history.sql");
    expect(fixture.pending).not.toContain("010_create_game_history.sql");
  });

  it("the six G6 stray grants are GONE from both objects and the allowlist (011 revoked them on prod)", () => {
    const objects = (fixture.objects as { object: string }[]).map(
      (o) => o.object,
    );
    const acked = (allowlist.acknowledgedResidual as { object: string }[]).map(
      (a) => a.object,
    );
    for (const g of G6) {
      expect(objects).not.toContain(g);
      expect(acked).not.toContain(g);
    }
    // increment_player_stats stays acknowledged (#91) — cosmetic re-emission.
    expect(acked).toContain("function:public:increment_player_stats");
    // RLS/policy never appear (self-attribute to their migration, drop as benign).
    expect(objects).not.toContain("rls:public:game_history");
    expect(objects).not.toContain("policy:public:game_history:ALL");
  });

  it("passes against the real fixture + allowlist as shipped (residual ∅, no unusedAcknowledged)", () => {
    const result = gateWith(fixture.pending as string[]);
    expect(result.ok).toBe(true);
    expect(result.residual).toEqual([]);
    expect(result.unusedAcknowledged).toEqual([]);
    expect(result.reasons).toEqual([]);
  });

  it("fails missingExpected when an un-allowlisted migration becomes pending", () => {
    const result = gateWith(["012_hypothetical.sql"]);
    expect(result.ok).toBe(false);
    expect(result.missingExpected).toContain("012_hypothetical.sql");
    expect(result.reasons.join(" ")).toMatch(/missing from expectedPending/);
  });
});

// ---------------------------------------------------------------------------
// LLD 011: acknowledgedResidual subtracts EXACTLY the six G6 grants — proving
// the transient ack is fail-closed. Removing one ack surfaces that one grant as
// residual; an ack matching no observed drift is flagged unusedAcknowledged
// (the Phase-2 self-enforcement mechanism, Edge Case 11).
// ---------------------------------------------------------------------------
describe("evaluateDriftGate — G6 acknowledgedResidual is fail-closed (LLD 011)", () => {
  const observed = G6.map((object) => ({ object }));
  const acknowledgedResidual = G6.map((object) => ({
    object,
    reason: "Live TypeORM-era stray write grant that 011 REVOKEs; transient.",
    issue: "#176",
  }));

  it("subtracts exactly G6 → residual ∅, no unusedAcknowledged", () => {
    const result = evaluateDriftGate({
      observed,
      expectedFromPending: [],
      allowlist: {
        expectedPending: ["011_lock_down_game_history.sql"],
        acknowledgedResidual,
      },
      actualPending: ["011_lock_down_game_history.sql"],
    });
    expect(result.ok).toBe(true);
    expect(result.residual).toEqual([]);
    expect(result.unusedAcknowledged).toEqual([]);
  });

  it("removing one ack surfaces exactly that grant as residual (fail-closed)", () => {
    const result = evaluateDriftGate({
      observed,
      expectedFromPending: [],
      allowlist: {
        expectedPending: ["011_lock_down_game_history.sql"],
        // drop the ack for grant:anon:game_history:INSERT
        acknowledgedResidual: acknowledgedResidual.filter(
          (a) => a.object !== "grant:anon:game_history:INSERT",
        ),
      },
      actualPending: ["011_lock_down_game_history.sql"],
    });
    expect(result.ok).toBe(false);
    expect(result.residual).toEqual(["grant:anon:game_history:INSERT"]);
  });

  it("flags an ack that matches no observed drift as unusedAcknowledged (Phase-2 self-enforcement)", () => {
    // Simulate the post-011-applied world: the grants are gone from prod
    // (observed empty) but the six acks are still present → the gate FAILS,
    // forcing the Phase-2 cleanup.
    const result = evaluateDriftGate({
      observed: [],
      expectedFromPending: [],
      allowlist: {
        expectedPending: [],
        acknowledgedResidual,
      },
      actualPending: [],
    });
    expect(result.ok).toBe(false);
    expect(result.unusedAcknowledged).toEqual([...G6].sort());
    expect(result.reasons.join(" ")).toMatch(/matched no observed drift/);
  });
});
