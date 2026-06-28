import { describe, it, expect } from "vitest";
import { TonkEngine } from "../../../src/backend/engine/tonk/tonk-engine.js";
import { SeededPRNG } from "../../../src/backend/engine/prng.js";
import { buildTonkState, c, j, players, tonk } from "./helpers.js";
import type { TonkCard } from "../../../src/backend/engine/tonk/tonk-types.js";
import type { TonkPublicState } from "../../../src/shared/tonk-types.js";

const engine = new TonkEngine();
const config = { maxPlayers: 8, minPlayers: 3, options: {} };

/** Recursively collect all TonkCard-like objects in a value. */
function allCards(obj: unknown): TonkCard[] {
  const found: TonkCard[] = [];
  function walk(val: unknown): void {
    if (val === null || typeof val !== "object") return;
    const o = val as Record<string, unknown>;
    if (
      (typeof o["rank"] === "string" && typeof o["suit"] === "string") ||
      o["joker"] === true
    ) {
      found.push(o as unknown as TonkCard);
    }
    for (const v of Object.values(o)) walk(v);
  }
  walk(obj);
  return found;
}

function key(card: TonkCard): string {
  return "joker" in card ? `J${card.id}` : `${card.rank}${card.suit}`;
}

describe("getPlayerView — information hiding", () => {
  it("never contains another player's hand card or any stock card", () => {
    const state = engine.initialize(
      "g",
      players(4),
      config,
      new SeededPRNG("hide-1"),
    );
    const ts = tonk(state);
    const myHandKeys = new Set(ts.hands[0]!.map(key));

    const view = engine.getPlayerView(state, "p1");
    // Serialize the public state to JSON and assert no leakage.
    const publicCards = allCards(view.gameSpecificPublicState);

    // No stock card appears anywhere in the public view.
    for (const stockCard of ts.stock) {
      expect(publicCards.some((c2) => key(c2) === key(stockCard))).toBe(false);
    }
    // No opponent hand card appears in the public view (cards are unique here).
    for (let i = 1; i < ts.hands.length; i++) {
      for (const oppCard of ts.hands[i]!) {
        const k = key(oppCard);
        if (!myHandKeys.has(k)) {
          expect(publicCards.some((c2) => key(c2) === k)).toBe(false);
        }
      }
    }
  });

  it("opponents appear as cardCount only; no hand field", () => {
    const state = engine.initialize(
      "g",
      players(3),
      config,
      new SeededPRNG("hide-2"),
    );
    const view = engine.getPlayerView(state, "p1");
    for (let i = 0; i < view.players.length; i++) {
      const p = view.players[i]!;
      expect(typeof p.cardCount).toBe("number");
      expect(p.cardCount).toBe(tonk(state).hands[i]!.length);
      expect((p as unknown as Record<string, unknown>)["hand"]).toBeUndefined();
    }
  });

  it("you.hand is exactly the requesting player's hand", () => {
    const state = engine.initialize(
      "g",
      players(3),
      config,
      new SeededPRNG("hide-3"),
    );
    const view = engine.getPlayerView(state, "p2");
    const mine = (view.you.hand as unknown as TonkCard[]).map(key).sort();
    const actual = tonk(state).hands[1]!.map(key).sort();
    expect(mine).toEqual(actual);
  });

  it("stock exposed as a count only (stockCount), never cards", () => {
    const state = engine.initialize(
      "g",
      players(3),
      config,
      new SeededPRNG("hide-4"),
    );
    const view = engine.getPlayerView(state, "p1");
    const pub = view.gameSpecificPublicState as TonkPublicState;
    expect(typeof pub.stockCount).toBe("number");
    expect(pub.stockCount).toBe(tonk(state).stock.length);
    expect(
      (pub as unknown as Record<string, unknown>)["stock"],
    ).toBeUndefined();
  });

  it("discardTop, drawableDiscard, counts, tallies, log are public", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 1,
      tonk: {
        hands: [[], [c("3", "clubs")], [c("4", "clubs")]],
        stock: [c("8", "clubs")],
        discardPile: [c("5", "clubs")],
        drawableDiscard: c("5", "clubs"),
        lastDiscardCount: 1,
        lastDiscardPlayerIndex: 0,
        turnPhase: "discard",
        tallies: [3, 7, 11],
      },
    });
    const view = engine.getPlayerView(state, "p2");
    const pub = view.gameSpecificPublicState as TonkPublicState;
    expect(pub.discardTop).toEqual(c("5", "clubs"));
    expect(pub.drawableDiscard).toEqual(c("5", "clubs"));
    expect(pub.discardCount).toBe(1);
    expect(pub.tallies).toEqual([3, 7, 11]);
  });

  it("validActions populated only on the requesting player's turn", () => {
    const state = engine.initialize(
      "g",
      players(3),
      config,
      new SeededPRNG("hide-5"),
    );
    expect(
      engine.getPlayerView(state, "p1").validActions.length,
    ).toBeGreaterThan(0);
    expect(engine.getPlayerView(state, "p2").validActions).toEqual([]);
  });
});

describe("getSpectatorView — no hands, no stock cards", () => {
  it("contains no hand cards and no stock cards", () => {
    const state = engine.initialize(
      "g",
      players(4),
      config,
      new SeededPRNG("spec-1"),
    );
    const ts = tonk(state);
    const view = engine.getSpectatorView(state, 2);
    const publicCards = allCards(view.gameSpecificPublicState);

    for (const hand of ts.hands) {
      for (const handCard of hand) {
        expect(publicCards.some((c2) => key(c2) === key(handCard))).toBe(false);
      }
    }
    for (const stockCard of ts.stock) {
      expect(publicCards.some((c2) => key(c2) === key(stockCard))).toBe(false);
    }
  });

  it("has no 'you' and no 'validActions' fields", () => {
    const state = engine.initialize(
      "g",
      players(3),
      config,
      new SeededPRNG("spec-2"),
    );
    const view = engine.getSpectatorView(state, 1);
    expect((view as unknown as Record<string, unknown>)["you"]).toBeUndefined();
    expect(
      (view as unknown as Record<string, unknown>)["validActions"],
    ).toBeUndefined();
    expect(view.spectatorCount).toBe(1);
  });

  it("jokers in a hand do not leak into the public view", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("3", "clubs")], [j(0)], [j(1)]],
        stock: [j(2)],
        discardPile: [c("5", "clubs")],
      },
    });
    const view = engine.getSpectatorView(state, 0);
    const publicCards = allCards(view.gameSpecificPublicState);
    // Only the public discard top (5C) should appear — no jokers.
    expect(publicCards.some((card) => "joker" in card)).toBe(false);
  });
});
