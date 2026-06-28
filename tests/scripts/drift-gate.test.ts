import { describe, it, expect } from "vitest";
// @ts-expect-error — plain ESM gate logic (no .d.ts); typed via JSDoc only.
import { evaluateDriftGate } from "../../scripts/lib/drift-gate.mjs";

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
