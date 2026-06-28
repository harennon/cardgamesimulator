import { describe, it, expect } from "vitest";
import { TonkEngine } from "../../../src/backend/engine/tonk/tonk-engine.js";
import { SeededPRNG } from "../../../src/backend/engine/prng.js";
import type { TonkState } from "../../../src/backend/engine/tonk/tonk-types.js";
import { players } from "./helpers.js";

const engine = new TonkEngine();
const config = (options: Record<string, unknown> = {}) => ({
  maxPlayers: 8,
  minPlayers: 3,
  options,
});

function tonk(state: { gameSpecificState: unknown }): TonkState {
  return state.gameSpecificState as TonkState;
}

describe("initialize — deal for 3-8 players", () => {
  for (const n of [3, 4, 5, 6, 7, 8]) {
    it(`${n} players: 5 dealt each; stock = deckSize - 5*players; init fields`, () => {
      const state = engine.initialize(
        "g",
        players(n),
        config(),
        new SeededPRNG(`init-${n}`),
      );
      const ts = tonk(state);

      expect(state.status).toBe("IN_PROGRESS");
      expect(state.version).toBe(1);
      expect(state.currentPlayerIndex).toBe(0);
      expect(state.turnNumber).toBe(1);
      expect(ts.turnPhase).toBe("discard");
      expect(ts.trickNumber).toBe(1);
      expect(ts.trickTurnCount).toBe(0);
      expect(ts.tallies).toEqual(new Array(n).fill(0));
      expect(ts.discardPile).toEqual([]);
      expect(ts.drawableDiscard).toBeNull();

      expect(ts.hands.length).toBe(n);
      for (const hand of ts.hands) expect(hand.length).toBe(5);
      expect(ts.stock.length).toBe(ts.trickDeckSize - 5 * n);
    });
  }

  it("randomSeed is the supplied prng seed", () => {
    const state = engine.initialize(
      "g",
      players(3),
      config(),
      new SeededPRNG("my-seed"),
    );
    expect(state.randomSeed).toBe("my-seed");
  });

  it("trick-1 discard pile empty, no drawable snapshot", () => {
    const state = engine.initialize(
      "g",
      players(4),
      config(),
      new SeededPRNG("d"),
    );
    const ts = tonk(state);
    expect(ts.discardPile.length).toBe(0);
    expect(ts.drawableDiscard).toBeNull();
  });
});

describe("initialize — player count guards", () => {
  it("throws for < 3 players", () => {
    expect(() =>
      engine.initialize("g", players(2), config(), new SeededPRNG("x")),
    ).toThrow("Tonk requires 3-8 players");
  });

  it("throws for > 8 players", () => {
    expect(() =>
      engine.initialize("g", players(9), config(), new SeededPRNG("x")),
    ).toThrow("Tonk requires 3-8 players");
  });
});

describe("initialize — deckRoundsTarget from config.options", () => {
  it("absent -> default 8 (3 players: deckSize 39)", () => {
    const state = engine.initialize(
      "g",
      players(3),
      config(),
      new SeededPRNG("a"),
    );
    expect(tonk(state).trickDeckSize).toBe(39);
  });

  it("explicit low target cuts more (3 players, target 5 -> deckSize 30)", () => {
    const state = engine.initialize(
      "g",
      players(3),
      config({ deckRoundsTarget: 5 }),
      new SeededPRNG("a"),
    );
    expect(tonk(state).trickDeckSize).toBe(30);
  });

  it("out-of-range target clamped defensively (target 99 -> 12 -> deckSize 51)", () => {
    const state = engine.initialize(
      "g",
      players(3),
      config({ deckRoundsTarget: 99 }),
      new SeededPRNG("a"),
    );
    expect(tonk(state).trickDeckSize).toBe(51);
  });

  it("determinism: same seed -> identical initial hands", () => {
    const a = engine.initialize("g", players(4), config(), new SeededPRNG("s"));
    const b = engine.initialize("g", players(4), config(), new SeededPRNG("s"));
    expect(tonk(a).hands).toEqual(tonk(b).hands);
    expect(tonk(a).stock).toEqual(tonk(b).stock);
  });
});
