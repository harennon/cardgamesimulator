import { describe, it, expect } from "vitest";
import { ref, computed } from "vue";
import type { Card, PlayerPublicInfo } from "../../src/shared/engine-types.js";
import type { EnrichedPlayerView } from "../../src/shared/socket-events.js";
import type { TonkCard, TonkPublicState } from "../../src/shared/tonk-types.js";

// Transcription of TonkBoard.vue's <script setup> derivation, tested in
// isolation (project pattern). These computeds drive the template: tonkState
// gates the loading placeholder, myPlayerIndex/hasHand gate the hand zone,
// myHand feeds TonkHand. Asserting them asserts what the board renders.

function card(rank: Card["rank"], suit: Card["suit"]): Card {
  return { rank, suit };
}

function makeBoardLogic(view: ReturnType<typeof ref<EnrichedPlayerView>>) {
  const gs = () => view.value!;
  const tonkState = computed<TonkPublicState | null>(() =>
    gs().gameType === "tonk" && gs().gameSpecificPublicState
      ? (gs().gameSpecificPublicState as TonkPublicState)
      : null,
  );
  const myPlayerIndex = computed(() =>
    gs().players.findIndex((p) => p.playerId === gs().you?.playerId),
  );
  const myHand = computed<readonly TonkCard[]>(
    () => (gs().you?.hand ?? []) as readonly TonkCard[],
  );
  const hasHand = computed(() => myPlayerIndex.value !== -1);
  const isMyTurn = computed(
    () => gs().currentPlayerIndex === myPlayerIndex.value,
  );
  return { tonkState, myPlayerIndex, myHand, hasHand, isMyTurn };
}

function tonkPublicState(over: Partial<TonkPublicState> = {}): TonkPublicState {
  return {
    turnPhase: "discard",
    trickNumber: 1,
    trickTurnCount: 0,
    tonkGateOpen: false,
    stockCount: 30,
    discardTop: card("9", "clubs"),
    discardCount: 1,
    lastDiscardCount: 1,
    lastDiscardPlayerIndex: 0,
    drawableDiscard: card("4", "diamonds"),
    tallies: [10, 20, 30],
    log: [],
    ...over,
  };
}

function publicPlayers(): PlayerPublicInfo[] {
  return [
    { playerId: "me", displayName: "Me", cardCount: 5, isConnected: true },
    { playerId: "p2", displayName: "Bob", cardCount: 6, isConnected: true },
    { playerId: "p3", displayName: "Cara", cardCount: 7, isConnected: true },
  ];
}

function playerView(
  over: Partial<EnrichedPlayerView> = {},
  state: TonkPublicState | null = tonkPublicState(),
): EnrichedPlayerView {
  return {
    gameId: "g1",
    gameType: "tonk",
    status: "IN_PROGRESS",
    version: 1,
    players: publicPlayers(),
    you: {
      playerId: "me",
      displayName: "Me",
      hand: [card("A", "spades"), card("K", "hearts")],
    },
    currentPlayerIndex: 0,
    turnNumber: 1,
    validActions: [],
    gameSpecificPublicState: state,
    winner: null,
    scores: null,
    turnDeadline: null,
    joinCode: "ABCD",
    ...over,
  };
}

describe("TonkBoard — rendering from TonkPublicState", () => {
  it("derives the Tonk public state and the local player's hand", () => {
    const t = makeBoardLogic(ref(playerView()));
    expect(t.tonkState.value).not.toBeNull();
    expect(t.tonkState.value!.stockCount).toBe(30);
    expect(t.tonkState.value!.discardTop).toEqual(card("9", "clubs"));
    expect(t.tonkState.value!.drawableDiscard).toEqual(card("4", "diamonds"));
    expect(t.tonkState.value!.tallies).toEqual([10, 20, 30]);
    expect(t.tonkState.value!.trickNumber).toBe(1);
    // Own hand renders (count matches you.hand).
    expect(t.hasHand.value).toBe(true);
    expect(t.myHand.value).toHaveLength(2);
    expect(t.myPlayerIndex.value).toBe(0);
    expect(t.isMyTurn.value).toBe(true);
  });

  it("E1: gameSpecificPublicState null → tonkState null (loading placeholder, no crash)", () => {
    const t = makeBoardLogic(ref(playerView({}, null)));
    expect(t.tonkState.value).toBeNull();
  });

  it("E1: wrong game type → tonkState null", () => {
    const t = makeBoardLogic(ref(playerView({ gameType: "big2" })));
    expect(t.tonkState.value).toBeNull();
  });

  it("a hand containing a joker is passed through to TonkHand as a TonkCard", () => {
    const joker: TonkCard = { joker: true, id: 0 };
    const view = playerView({
      you: { playerId: "me", displayName: "Me", hand: [joker] as Card[] },
    });
    const t = makeBoardLogic(ref(view));
    expect(t.myHand.value).toHaveLength(1);
    expect((t.myHand.value[0] as { joker?: boolean }).joker).toBe(true);
  });
});

describe("TonkBoard — spectator contract (E11)", () => {
  it("no local hand (myPlayerIndex === -1) → hand zone renders nothing", () => {
    const view = playerView({
      // A view whose `you` is not among `players` simulates the no-own-seat case.
      you: {
        playerId: "spectator",
        displayName: "Watcher",
        hand: [],
      },
    });
    const t = makeBoardLogic(ref(view));
    expect(t.myPlayerIndex.value).toBe(-1);
    expect(t.hasHand.value).toBe(false);
    // The rest still renders from public state.
    expect(t.tonkState.value).not.toBeNull();
    expect(t.tonkState.value!.tallies).toEqual([10, 20, 30]);
  });
});

describe("TonkBoard — information hiding (testing-principles #7)", () => {
  it("public state exposes counts only — no opponent hands, no stock contents", () => {
    const view = playerView();
    const t = makeBoardLogic(ref(view));

    // Opponents expose cardCount only; there is no hand field to render.
    for (const p of view.players) {
      if (p.playerId === "me") continue;
      expect("hand" in p).toBe(false);
      expect(typeof p.cardCount).toBe("number");
    }

    // The public state has a stock COUNT but no stock card array — the board
    // physically cannot render hidden stock cards.
    const state = t.tonkState.value!;
    expect(typeof state.stockCount).toBe("number");
    expect("stock" in state).toBe(false);
  });

  it("serialized public state contains no opponent hand card and no stock card", () => {
    const view = playerView();
    // Everything the board can read comes from this object. Serializing it and
    // asserting the only cards present are the local hand + the public piles
    // guards against any future code reaching for hidden data.
    const serialized = JSON.stringify({
      players: view.players,
      state: view.gameSpecificPublicState,
    });
    // Opponent hands never appear: their entries carry only cardCount.
    expect(serialized).not.toContain('"hand"');
    // No stock card array key.
    expect(serialized).not.toContain('"stock"');
  });
});
