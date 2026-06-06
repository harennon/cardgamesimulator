import { describe, it, expect } from "vitest";
import { Big2Engine } from "../../../src/backend/engine/big2/big2-engine.js";
import { SeededPRNG } from "../../../src/backend/engine/prng.js";
import type {
  InternalGameState,
  PlayerInfo,
  Card,
} from "../../../src/shared/engine-types.js";
import type { Big2PublicState } from "../../../src/backend/engine/big2/big2-types.js";

const engine = new Big2Engine();

function player(id: string): PlayerInfo {
  return { playerId: id, displayName: id };
}

const PLAYERS4 = ["p1", "p2", "p3", "p4"].map(player);
const config = { maxPlayers: 4, minPlayers: 2, options: {} };

function initGame(players = PLAYERS4, seed = "hiding-test"): InternalGameState {
  return engine.initialize("game1", players, config, new SeededPRNG(seed));
}

function card(rank: Card["rank"], suit: Card["suit"]): Card {
  return { rank, suit };
}

function allCardsInObject(obj: unknown): Card[] {
  // Recursively find all objects that look like { rank, suit }
  const found: Card[] = [];
  function walk(val: unknown): void {
    if (val === null || val === undefined) return;
    if (typeof val !== "object") return;
    const o = val as Record<string, unknown>;
    if (typeof o["rank"] === "string" && typeof o["suit"] === "string") {
      found.push(o as unknown as Card);
    }
    for (const v of Object.values(o)) {
      walk(v);
    }
  }
  walk(obj);
  return found;
}

describe("getPlayerView — information hiding", () => {
  it("PlayerView for player A does not contain cards from player B's hand", () => {
    const state = initGame();
    const gs = state.gameSpecificState as { hands: (readonly Card[])[] };
    const startIdx = state.currentPlayerIndex;
    const otherIdx = (startIdx + 1) % 4;
    const otherHand = gs.hands[otherIdx]!;

    const view = engine.getPlayerView(state, PLAYERS4[startIdx]!.playerId);
    const cardsInView = allCardsInObject(view.gameSpecificPublicState).concat(
      view.you.hand as Card[],
    );

    for (const otherCard of otherHand) {
      // A card from other's hand should NOT appear as a card in the view
      // UNLESS it also happens to be in the requesting player's own hand
      // (impossible — each card is unique)
      const inMyHand = (view.you.hand as Card[]).some(
        (c) => c.rank === otherCard.rank && c.suit === otherCard.suit,
      );
      if (!inMyHand) {
        const leakedInPublic = allCardsInObject(
          view.gameSpecificPublicState,
        ).some((c) => c.rank === otherCard.rank && c.suit === otherCard.suit);
        expect(leakedInPublic).toBe(false);
      }
    }

    // Also verify: no player's public info contains Card objects (only cardCount)
    for (const p of view.players) {
      expect(typeof p.cardCount).toBe("number");
      expect((p as unknown as Record<string, unknown>)["hand"]).toBeUndefined();
    }
  });

  it("PlayerView shows only your own hand in you.hand", () => {
    const state = initGame();
    const gs = state.gameSpecificState as { hands: (readonly Card[])[] };
    const startIdx = state.currentPlayerIndex;
    const myHand = gs.hands[startIdx]!;

    const view = engine.getPlayerView(state, PLAYERS4[startIdx]!.playerId);
    const viewHand = view.you.hand as Card[];

    expect(viewHand.length).toBe(myHand.length);
    // Every card in view is in my actual hand
    for (const c of viewHand) {
      expect(myHand.some((h) => h.rank === c.rank && h.suit === c.suit)).toBe(
        true,
      );
    }
  });

  it("PlayerView shows opponent card counts, not their cards", () => {
    const state = initGame();
    const gs = state.gameSpecificState as { hands: (readonly Card[])[] };
    const startIdx = state.currentPlayerIndex;

    const view = engine.getPlayerView(state, PLAYERS4[startIdx]!.playerId);

    for (let i = 0; i < view.players.length; i++) {
      const p = view.players[i]!;
      expect(typeof p.cardCount).toBe("number");
      expect(p.cardCount).toBe(gs.hands[i]!.length);
    }
  });

  it("gameSpecificPublicState contains no hands array", () => {
    const state = initGame();
    const startIdx = state.currentPlayerIndex;
    const view = engine.getPlayerView(state, PLAYERS4[startIdx]!.playerId);
    const pub = view.gameSpecificPublicState as Big2PublicState;

    // Big2PublicState must not have a 'hands' field
    expect(
      (pub as unknown as Record<string, unknown>)["hands"],
    ).toBeUndefined();
  });

  it("played cards appear in lastPlay visible to all players", () => {
    let state = initGame();
    const gs = state.gameSpecificState as { hands: (readonly Card[])[] };
    const startIdx = state.currentPlayerIndex;
    const lowestCard = gs.hands[startIdx]!.find(
      (c) => c.rank === "3" && c.suit === "clubs",
    )!;

    const result = engine.applyAction(state, {
      type: "playCards",
      playerId: PLAYERS4[startIdx]!.playerId,
      cards: [lowestCard],
    });
    expect(result.success).toBe(true);
    state = result.newState!;

    // Every player can see the last played cards
    for (const p of PLAYERS4) {
      const view = engine.getPlayerView(state, p.playerId);
      const pub = view.gameSpecificPublicState as Big2PublicState;
      expect(pub.lastPlay).not.toBeNull();
      expect(pub.lastPlay!.cards[0]).toEqual(lowestCard);
    }
  });

  it("played cards are removed from the player's own hand view", () => {
    let state = initGame();
    const gs = state.gameSpecificState as { hands: (readonly Card[])[] };
    const startIdx = state.currentPlayerIndex;
    const lowestCard = gs.hands[startIdx]!.find(
      (c) => c.rank === "3" && c.suit === "clubs",
    )!;
    const beforeSize = gs.hands[startIdx]!.length;
    const playerId = PLAYERS4[startIdx]!.playerId;

    const result = engine.applyAction(state, {
      type: "playCards",
      playerId,
      cards: [lowestCard],
    });
    state = result.newState!;

    const view = engine.getPlayerView(state, playerId);
    expect((view.you.hand as Card[]).length).toBe(beforeSize - 1);
    expect(
      (view.you.hand as Card[]).some(
        (c) => c.rank === lowestCard.rank && c.suit === lowestCard.suit,
      ),
    ).toBe(false);
  });
});

describe("getSpectatorView — no hands", () => {
  it("spectator view contains no Card arrays (no hands)", () => {
    const state = initGame();
    const view = engine.getSpectatorView(state, 2);

    // Spectator should see card counts but no actual hands
    for (const p of view.players) {
      expect(typeof p.cardCount).toBe("number");
      expect((p as unknown as Record<string, unknown>)["hand"]).toBeUndefined();
    }

    const pub = view.gameSpecificPublicState as Big2PublicState;
    expect(
      (pub as unknown as Record<string, unknown>)["hands"],
    ).toBeUndefined();
  });

  it("spectator view has no 'you' field", () => {
    const state = initGame();
    const view = engine.getSpectatorView(state, 1);
    expect((view as unknown as Record<string, unknown>)["you"]).toBeUndefined();
  });

  it("spectator view has no validActions field", () => {
    const state = initGame();
    const view = engine.getSpectatorView(state, 1);
    expect(
      (view as unknown as Record<string, unknown>)["validActions"],
    ).toBeUndefined();
  });

  it("spectator count is included in the view", () => {
    const state = initGame();
    const view = engine.getSpectatorView(state, 3);
    expect(view.spectatorCount).toBe(3);
  });
});
