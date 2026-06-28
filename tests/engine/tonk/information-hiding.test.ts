import { describe, it, expect } from "vitest";
import { TonkEngine } from "../../../src/backend/engine/tonk/tonk-engine.js";
import { SeededPRNG } from "../../../src/backend/engine/prng.js";
import { card, makeTonkState } from "./helpers.js";
import type {
  InternalGameState,
  PlayerInfo,
} from "../../../src/shared/engine-types.js";
import type {
  TonkCard,
  TonkPublicState,
} from "../../../src/shared/tonk-types.js";

const engine = new TonkEngine();

function player(id: string): PlayerInfo {
  return { playerId: id, displayName: id };
}

const PLAYERS3 = ["p1", "p2", "p3"].map(player);
const config = { maxPlayers: 8, minPlayers: 3, options: {} };

function initGame(seed = "hide"): InternalGameState {
  return engine.initialize("g1", PLAYERS3, config, new SeededPRNG(seed));
}

function allCardsInObject(obj: unknown): TonkCard[] {
  const found: TonkCard[] = [];
  function walk(val: unknown): void {
    if (val === null || val === undefined) return;
    if (typeof val !== "object") return;
    const o = val as Record<string, unknown>;
    if (typeof o["rank"] === "string" && typeof o["suit"] === "string") {
      found.push(o as unknown as TonkCard);
    }
    if (o["joker"] === true) {
      found.push(o as unknown as TonkCard);
    }
    for (const v of Object.values(o)) {
      walk(v);
    }
  }
  walk(obj);
  return found;
}

function sameCard(a: TonkCard, b: TonkCard): boolean {
  if ("joker" in a || "joker" in b) {
    return "joker" in a && "joker" in b && a.id === b.id;
  }
  return a.suit === b.suit && a.rank === b.rank;
}

describe("getPlayerView — information hiding", () => {
  it("does not contain another player's hand", () => {
    const state = initGame();
    const gs = state.gameSpecificState as { hands: TonkCard[][] };
    const otherHand = gs.hands[1]!;

    const view = engine.getPlayerView(state, "p1");
    const myHand = view.you.hand as TonkCard[];
    const publicCards = allCardsInObject(view.gameSpecificPublicState);

    for (const oc of otherHand) {
      const inMyHand = myHand.some((c) => sameCard(c, oc));
      if (!inMyHand) {
        const leaked = publicCards.some((c) => sameCard(c, oc));
        // It could legitimately appear if it's the discardTop snapshot, but
        // at init discardPile is empty, so nothing should leak.
        expect(leaked).toBe(false);
      }
    }
  });

  it("stock is a count only — no stock array in public state", () => {
    const state = initGame();
    const view = engine.getPlayerView(state, "p1");
    const pub = view.gameSpecificPublicState as TonkPublicState;
    expect(typeof pub.stockCount).toBe("number");
    expect(pub.stockCount).toBeGreaterThan(0);
    expect(
      (pub as unknown as Record<string, unknown>)["stock"],
    ).toBeUndefined();
  });

  it("public state has no hands array", () => {
    const state = initGame();
    const view = engine.getPlayerView(state, "p1");
    const pub = view.gameSpecificPublicState as Record<string, unknown>;
    expect(pub["hands"]).toBeUndefined();
  });

  it("opponents shown as counts, your own hand shown in full", () => {
    const state = initGame();
    const gs = state.gameSpecificState as { hands: TonkCard[][] };
    const view = engine.getPlayerView(state, "p1");
    for (let i = 0; i < view.players.length; i++) {
      expect(view.players[i]!.cardCount).toBe(gs.hands[i]!.length);
      expect(
        (view.players[i] as unknown as Record<string, unknown>)["hand"],
      ).toBeUndefined();
    }
    expect((view.you.hand as TonkCard[]).length).toBe(gs.hands[0]!.length);
  });

  it("discard top, counts, drawableDiscard, tallies are public", () => {
    const state = makeTonkState({
      hands: [[card("3", "clubs")], [card("4", "clubs")], [card("5", "clubs")]],
      stock: [card("7", "diamonds")],
      discardPile: [card("9", "hearts")],
      drawableDiscard: card("9", "hearts"),
      turnPhase: "draw",
      currentPlayerIndex: 0,
      tallies: [10, 20, 30],
    });
    const view = engine.getPlayerView(state, "p1");
    const pub = view.gameSpecificPublicState as TonkPublicState;
    expect(pub.discardTop).toEqual(card("9", "hearts"));
    expect(pub.discardCount).toBe(1);
    expect(pub.drawableDiscard).toEqual(card("9", "hearts"));
    expect(pub.tallies).toEqual([10, 20, 30]);
    expect(pub.stockCount).toBe(1);
  });
});

describe("getSpectatorView — no hands, no stock contents", () => {
  it("contains no hands and no stock array", () => {
    const state = initGame();
    const view = engine.getSpectatorView(state, 2);
    for (const p of view.players) {
      expect(typeof p.cardCount).toBe("number");
      expect((p as unknown as Record<string, unknown>)["hand"]).toBeUndefined();
    }
    const pub = view.gameSpecificPublicState as Record<string, unknown>;
    expect(pub["hands"]).toBeUndefined();
    expect(pub["stock"]).toBeUndefined();
    expect(view.spectatorCount).toBe(2);
  });

  it("has no 'you' and no validActions fields", () => {
    const state = initGame();
    const view = engine.getSpectatorView(state, 1);
    expect((view as unknown as Record<string, unknown>)["you"]).toBeUndefined();
    expect(
      (view as unknown as Record<string, unknown>)["validActions"],
    ).toBeUndefined();
  });
});
