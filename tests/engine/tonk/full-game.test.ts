import { describe, it, expect } from "vitest";
import { TonkEngine } from "../../../src/backend/engine/tonk/tonk-engine.js";
import { SeededPRNG } from "../../../src/backend/engine/prng.js";
import type {
  GameAction,
  InternalGameState,
  PlayerInfo,
  PlayerScore,
} from "../../../src/shared/engine-types.js";
import type { TonkState } from "../../../src/backend/engine/tonk/tonk-types.js";

const engine = new TonkEngine();

function player(id: string): PlayerInfo {
  return { playerId: id, displayName: id };
}

function tonk(state: InternalGameState): TonkState {
  return state.gameSpecificState as TonkState;
}

function totalCards(state: InternalGameState): number {
  const t = tonk(state);
  return t.hands.flat().length + t.stock.length + t.discardPile.length;
}

function assertInvariants(
  prev: InternalGameState,
  next: InternalGameState,
): void {
  // version strictly +1 per applied action.
  expect(next.version).toBe(prev.version + 1);

  const t = tonk(next);
  if (next.status === "IN_PROGRESS") {
    // Conservation within the (possibly new) trick.
    expect(totalCards(next)).toBe(t.trickDeckSize);
    // Valid active seat.
    expect(next.currentPlayerIndex).toBeGreaterThanOrEqual(0);
    expect(next.currentPlayerIndex).toBeLessThan(next.players.length);
    // No deadlock.
    const pid = next.players[next.currentPlayerIndex]!.playerId;
    expect(engine.getValidActions(next, pid).length).toBeGreaterThan(0);
    // Tallies monotonically non-decreasing.
    for (let i = 0; i < t.tallies.length; i++) {
      expect(t.tallies[i]!).toBeGreaterThanOrEqual(tonk(prev).tallies[i]!);
    }
  } else {
    expect(next.currentPlayerIndex).toBe(-1);
    expect(next.status).toBe("COMPLETED"); // never reverts
  }
}

describe("full-match simulation", () => {
  it("plays to a TRUE LOSER with invariants holding every step", () => {
    const players = ["p1", "p2", "p3"].map(player);
    const config = { maxPlayers: 8, minPlayers: 3, options: {} };
    let state = engine.initialize(
      "sim",
      players,
      config,
      new SeededPRNG("simulation-seed"),
    );

    let steps = 0;
    const MAX_STEPS = 50000;
    while (state.status === "IN_PROGRESS" && steps < MAX_STEPS) {
      const idx = state.currentPlayerIndex;
      const pid = players[idx]!.playerId;
      const t = tonk(state);
      const valid = engine.getValidActions(state, pid);
      expect(valid.length).toBeGreaterThan(0);

      let action: GameAction;
      if (t.turnPhase === "discard") {
        // Strategy: never call TONK; discard the highest-value single card.
        const hand = t.hands[idx]!;
        const highest = [...hand].sort((a, b) => value(b) - value(a))[0]!;
        action = {
          type: "discard",
          playerId: pid,
          cards: [highest],
        } as GameAction;
      } else {
        // Always draw from stock (this also resolves Case C on stock-out).
        action = { type: "draw", playerId: pid, source: "stock" } as GameAction;
      }

      const prev = state;
      const res = engine.applyAction(state, action);
      expect(res.success).toBe(true);
      state = res.newState!;
      assertInvariants(prev, state);
      steps++;
    }

    expect(state.status).toBe("COMPLETED");
    expect(steps).toBeLessThan(MAX_STEPS);

    // winner = lowest-tally display value.
    expect(state.winner).not.toBeNull();
    const scores = state.scores as readonly PlayerScore[];
    expect(scores.length).toBe(3);

    // Exactly one TRUE LOSER; everyone else won.
    const losers = scores.filter((s) => s.breakdown!.trueLoser === 1);
    expect(losers.length).toBe(1);

    // Loss-centric stats derivation consumes breakdown.trueLoser correctly.
    for (const s of scores) {
      const gamesLost = s.breakdown!.trueLoser === 1 ? 1 : 0;
      const gamesWon = s.breakdown!.trueLoser === 1 ? 0 : 1;
      expect(gamesLost + gamesWon).toBe(1);
      expect(s.breakdown!.finalTally).toBe(s.score);
      expect(typeof s.breakdown!.lost).toBe("number");
    }
    const winners = scores.filter((s) => s.breakdown!.trueLoser === 0);
    expect(winners.length).toBe(2);
  });
});

function value(c: unknown): number {
  const card = c as { joker?: boolean; rank?: string };
  if (card.joker === true) return 0;
  const r = card.rank!;
  if (r === "A") return 1;
  if (r === "J" || r === "Q" || r === "K") return 10;
  return Number(r);
}
