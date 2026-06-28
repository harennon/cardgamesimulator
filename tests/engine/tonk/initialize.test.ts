import { describe, it, expect } from "vitest";
import { TonkEngine } from "../../../src/backend/engine/tonk/tonk-engine.js";
import { SeededPRNG } from "../../../src/backend/engine/prng.js";
import { isJoker } from "../../../src/shared/tonk-types.js";
import type { PlayerInfo, Card } from "../../../src/shared/engine-types.js";
import type { TonkCard } from "../../../src/shared/tonk-types.js";
import type { TonkState } from "../../../src/backend/engine/tonk/tonk-types.js";

const engine = new TonkEngine();

function player(id: string): PlayerInfo {
  return { playerId: id, displayName: id };
}

function players(n: number): PlayerInfo[] {
  return Array.from({ length: n }, (_, i) => player(`p${i + 1}`));
}

const config = (options: Record<string, unknown> = {}) => ({
  maxPlayers: 8,
  minPlayers: 3,
  options,
});

function cardKey(c: TonkCard): string {
  return isJoker(c)
    ? `joker:${c.id}`
    : `${(c as Card).rank}:${(c as Card).suit}`;
}

describe("initialize — player count validation", () => {
  it("throws for < 3 players", () => {
    expect(() =>
      engine.initialize("g", players(2), config(), new SeededPRNG("s")),
    ).toThrowError("Tonk requires 3-8 players");
  });
  it("throws for > 8 players", () => {
    expect(() =>
      engine.initialize("g", players(9), config(), new SeededPRNG("s")),
    ).toThrowError("Tonk requires 3-8 players");
  });
  it("accepts 3 players", () => {
    const s = engine.initialize("g", players(3), config(), new SeededPRNG("s"));
    expect(s.status).toBe("IN_PROGRESS");
  });
  it("accepts 8 players", () => {
    const s = engine.initialize("g", players(8), config(), new SeededPRNG("s"));
    expect(s.status).toBe("IN_PROGRESS");
  });
});

describe("initialize — initial state", () => {
  it("deals 5 each, sets trick-1 defaults", () => {
    const s = engine.initialize("g", players(3), config(), new SeededPRNG("s"));
    const t = s.gameSpecificState as TonkState;
    expect(t.hands.length).toBe(3);
    for (const h of t.hands) expect(h.length).toBe(5);
    expect(t.discardPile).toEqual([]);
    expect(t.drawableDiscard).toBeNull();
    expect(t.turnPhase).toBe("discard");
    expect(t.trickNumber).toBe(1);
    expect(t.trickTurnCount).toBe(0);
    expect(t.tallies).toEqual([0, 0, 0]);
    expect(s.currentPlayerIndex).toBe(0);
    expect(s.turnNumber).toBe(1);
    expect(s.version).toBe(1);
    expect(s.winner).toBeNull();
    expect(s.scores).toBeNull();
    expect(s.randomSeed).toBe("s");
  });

  it("3 players default: deckRoundsTarget 8, numDecks 1, cut → trickDeckSize 39", () => {
    const s = engine.initialize("g", players(3), config(), new SeededPRNG("s"));
    const t = s.gameSpecificState as TonkState;
    expect(t.deckRoundsTarget).toBe(8);
    expect(t.numDecks).toBe(1);
    expect(t.trickDeckSize).toBe(39);
    expect(t.stock.length).toBe(39 - 15);
  });

  it("6 players default: numDecks 2, trickDeckSize 78", () => {
    const s = engine.initialize("g", players(6), config(), new SeededPRNG("s"));
    const t = s.gameSpecificState as TonkState;
    expect(t.numDecks).toBe(2);
    expect(t.trickDeckSize).toBe(78);
    expect(t.stock.length).toBe(78 - 30);
  });

  it("absent deckRoundsTarget defaults to 8", () => {
    const s = engine.initialize("g", players(3), config(), new SeededPRNG("s"));
    expect((s.gameSpecificState as TonkState).deckRoundsTarget).toBe(8);
  });

  it("out-of-range deckRoundsTarget is clamped defensively to [5,12]", () => {
    const hi = engine.initialize(
      "g",
      players(3),
      config({ deckRoundsTarget: 99 }),
      new SeededPRNG("s"),
    );
    const lo = engine.initialize(
      "g",
      players(3),
      config({ deckRoundsTarget: 1 }),
      new SeededPRNG("s"),
    );
    expect((hi.gameSpecificState as TonkState).deckRoundsTarget).toBe(12);
    expect((lo.gameSpecificState as TonkState).deckRoundsTarget).toBe(5);
  });

  it("respects in-range deckRoundsTarget", () => {
    const s = engine.initialize(
      "g",
      players(3),
      config({ deckRoundsTarget: 12 }),
      new SeededPRNG("s"),
    );
    const t = s.gameSpecificState as TonkState;
    expect(t.deckRoundsTarget).toBe(12);
    // 3p target 12 → cut 3 → trickDeckSize 51.
    expect(t.trickDeckSize).toBe(51);
  });

  it("deterministic: same seed → identical trick-1 deck", () => {
    const a = engine.initialize("g", players(3), config(), new SeededPRNG("x"));
    const b = engine.initialize("g", players(3), config(), new SeededPRNG("x"));
    const ta = a.gameSpecificState as TonkState;
    const tb = b.gameSpecificState as TonkState;
    expect(ta.hands.map((h) => h.map(cardKey))).toEqual(
      tb.hands.map((h) => h.map(cardKey)),
    );
    expect(ta.stock.map(cardKey)).toEqual(tb.stock.map(cardKey));
  });
});
