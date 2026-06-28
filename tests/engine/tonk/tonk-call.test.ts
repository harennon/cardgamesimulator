import { describe, it, expect } from "vitest";
import { TonkEngine } from "../../../src/backend/engine/tonk/tonk-engine.js";
import { buildTonkState, c, tonk } from "./helpers.js";

const engine = new TonkEngine();

describe("callTonk gating", () => {
  it("rejected before everyone has had a turn (gate closed)", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("3", "clubs")], [c("9", "clubs")], [c("9", "hearts")]],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
        trickTurnCount: 2, // < players.length (3)
      },
    });
    const res = engine.applyAction(state, { type: "callTonk", playerId: "p1" });
    expect(res.success).toBe(false);
    expect(res.error).toBe(
      "TONK can only be called after every player has had a turn.",
    );
  });

  it("rejected outside discard phase (after discarding)", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("3", "clubs")], [c("9", "clubs")], [c("9", "hearts")]],
        stock: [c("8", "clubs")],
        turnPhase: "draw",
        trickTurnCount: 3,
      },
    });
    const res = engine.applyAction(state, { type: "callTonk", playerId: "p1" });
    expect(res.success).toBe(false);
    expect(res.error).toBe(
      "TONK can only be called at the start of your turn.",
    );
  });
});

describe("TONK scoring", () => {
  it("Case A — caller strictly lowest: others add hand value, caller 0", () => {
    // p1 hand value 3 (strictly lowest), p2 = 9, p3 = 19.
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          [c("3", "clubs")],
          [c("9", "clubs")],
          [c("9", "hearts"), c("10", "spades")],
        ],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
        trickTurnCount: 3,
        tallies: [10, 20, 30],
      },
    });
    const res = engine.applyAction(state, { type: "callTonk", playerId: "p1" });
    expect(res.success).toBe(true);
    const out = tonk(res.newState!);
    // caller (p1) +0; p2 +9; p3 +19.
    expect(out.tallies).toEqual([10, 29, 49]);
    expect(res.newState!.status).toBe("IN_PROGRESS"); // no one >= 150
  });

  it("Case B — caller tied: caller +30, others +0", () => {
    // p1 = 9, p2 = 9 (tie). Caller not strictly lowest -> Case B.
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("9", "clubs")], [c("9", "hearts")], [c("10", "spades")]],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
        trickTurnCount: 3,
        tallies: [0, 0, 0],
      },
    });
    const res = engine.applyAction(state, { type: "callTonk", playerId: "p1" });
    expect(res.success).toBe(true);
    expect(tonk(res.newState!).tallies).toEqual([30, 0, 0]);
  });

  it("Case B — caller beaten: caller +30, others +0", () => {
    // p1 = 10, p2 = 3 (lower than caller) -> Case B.
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("10", "clubs")], [c("3", "hearts")], [c("K", "spades")]],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
        trickTurnCount: 3,
        tallies: [5, 5, 5],
      },
    });
    const res = engine.applyAction(state, { type: "callTonk", playerId: "p1" });
    expect(res.success).toBe(true);
    expect(tonk(res.newState!).tallies).toEqual([35, 5, 5]);
  });

  it("trick result is appended to the log with revealed hands", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("3", "clubs")], [c("9", "clubs")], [c("10", "spades")]],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
        trickTurnCount: 3,
      },
    });
    const res = engine.applyAction(state, { type: "callTonk", playerId: "p1" });
    const out = tonk(res.newState!);
    const last = out.log[out.log.length - 1]!;
    expect(last.type).toBe("callTonk");
    expect(last.trickResult).toBeDefined();
    expect(last.trickResult!.reason).toBe("tonk");
    expect(last.trickResult!.tonkCallerIndex).toBe(0);
    expect(last.trickResult!.revealedHands.length).toBe(3);
    expect(last.trickResult!.handValues).toEqual([3, 9, 10]);
  });
});
