import { describe, it, expect } from "vitest";
import { TonkEngine } from "../../../src/backend/engine/tonk/tonk-engine.js";
import { SeededPRNG } from "../../../src/backend/engine/prng.js";
import type {
  InternalGameState,
  PlayerInfo,
} from "../../../src/shared/engine-types.js";
import type {
  TonkState,
  TonkDiscardAction,
} from "../../../src/backend/engine/tonk/tonk-types.js";
import { players, tonk, totalCards } from "./helpers.js";

const engine = new TonkEngine();
const config = { maxPlayers: 8, minPlayers: 3, options: {} };

function checkInvariants(
  state: InternalGameState,
  prevVersion: number,
  prevMaxTally: number,
): void {
  const ts = tonk(state);

  // Card conservation within a trick.
  expect(totalCards(state)).toBe(ts.trickDeckSize);

  if (state.status === "IN_PROGRESS") {
    expect(state.currentPlayerIndex).toBeGreaterThanOrEqual(0);
    expect(state.currentPlayerIndex).toBeLessThan(state.players.length);
    // No deadlock: current player always has at least one valid action.
    const pid = state.players[state.currentPlayerIndex]!.playerId;
    expect(engine.getValidActions(state, pid).length).toBeGreaterThan(0);
  } else {
    expect(state.currentPlayerIndex).toBe(-1);
  }

  // version strictly +1 per applied action.
  expect(state.version).toBe(prevVersion + 1);

  // tallies monotonically non-decreasing (current max >= previous max).
  const maxTally = Math.max(...ts.tallies);
  expect(maxTally).toBeGreaterThanOrEqual(prevMaxTally);
}

function playFullGame(ps: PlayerInfo[], seed: string): InternalGameState {
  let state = engine.initialize("g", ps, config, new SeededPRNG(seed));
  const strat = new SeededPRNG(seed + "-strategy");

  const maxActions = 200000;
  let actions = 0;

  while (state.status !== "COMPLETED" && actions < maxActions) {
    actions++;
    const ts: TonkState = tonk(state);
    const idx = state.currentPlayerIndex;
    const pid = state.players[idx]!.playerId;
    const valid = engine.getValidActions(state, pid);
    expect(valid.length).toBeGreaterThan(0);

    const prevVersion = state.version;
    const prevMaxTally = Math.max(...ts.tallies);

    let result;
    if (ts.turnPhase === "draw") {
      // Mostly draw from stock; occasionally from discard when available.
      const useDiscard = ts.drawableDiscard !== null && strat.next() < 0.3;
      result = engine.applyAction(state, {
        type: "draw",
        playerId: pid,
        source: useDiscard ? "discard" : "stock",
      });
    } else {
      const canTonk = valid.some((a) => a.type === "callTonk");
      // Occasionally call TONK when the gate is open to exercise that path.
      if (canTonk && strat.next() < 0.15) {
        result = engine.applyAction(state, { type: "callTonk", playerId: pid });
      } else {
        // Discard the highest-value card via the engine's own auto-action.
        const auto = engine.getAutoTimeoutAction(state) as TonkDiscardAction;
        result = engine.applyAction(state, {
          type: "discard",
          playerId: pid,
          cards: auto.cards,
        });
      }
    }

    expect(result.success).toBe(true);
    state = result.newState!;
    checkInvariants(state, prevVersion, prevMaxTally);
  }

  return state;
}

describe("full match simulation + invariants", () => {
  for (const n of [3, 4, 5, 6, 8]) {
    it(`${n}-player match terminates with a resolved TRUE LOSER`, () => {
      const state = playFullGame(players(n), `full-${n}p`);
      expect(state.status).toBe("COMPLETED");
      expect(state.winner).not.toBeNull();
      expect(state.scores).toHaveLength(n);

      const ts = tonk(state);
      expect(ts.trueLoserIndex).not.toBeNull();
      expect(ts.lostPlayerIndices.length).toBeGreaterThan(0);

      // Exactly one trueLoser flag.
      const trueLosers = state.scores!.filter(
        (s) => s.breakdown!["trueLoser"] === 1,
      );
      expect(trueLosers.length).toBe(1);

      // breakdown.{lost,trueLoser,finalTally} populated.
      for (const s of state.scores!) {
        expect(typeof s.breakdown!["lost"]).toBe("number");
        expect(typeof s.breakdown!["trueLoser"]).toBe("number");
        expect(s.breakdown!["finalTally"]).toBe(s.score);
      }

      // Loss-centric stats derivation (the §6.3 consumer logic).
      for (const s of state.scores!) {
        const isLoser = s.breakdown!["trueLoser"] === 1;
        const gamesLost = isLoser ? 1 : 0;
        const gamesWon = isLoser ? 0 : 1;
        expect(gamesWon + gamesLost).toBe(1);
      }
    });
  }

  it("deterministic: same seed produces the same final state", () => {
    const a = playFullGame(players(3), "determinism-seed");
    const b = playFullGame(players(3), "determinism-seed");
    expect(a.winner).toBe(b.winner);
    expect(tonk(a).trueLoserIndex).toBe(tonk(b).trueLoserIndex);
    expect(tonk(a).tallies).toEqual(tonk(b).tallies);
  });

  it("completes many random 3-8 player matches without invariant violations", () => {
    for (let i = 0; i < 15; i++) {
      const n = 3 + (i % 6); // 3..8
      const state = playFullGame(players(n), `random-${n}-${i}`);
      expect(state.status).toBe("COMPLETED");
    }
  });
});
