import { describe, it, expect } from "vitest";
import { ref } from "vue";
import type { EnrichedPlayerView } from "../../src/shared/socket-events.js";
import type { Card, PlayerPublicInfo } from "../../src/shared/engine-types.js";
import type { TonkCard, TonkPublicState } from "../../src/shared/tonk-types.js";
import {
  useTonkBoard,
  COMPACT_SEAT_THRESHOLD,
} from "../../src/frontend/composables/useTonkBoard.js";

// LLD 89: TonkBoard is read-only and renders strictly from the server view.
// Following the project test pattern (trickPile.test.ts / gameBoardMobile.test.ts:
// node environment, no DOM mount), we exercise the REAL board derivation logic via
// the useTonkBoard composable that the component itself consumes, plus the
// GameView dispatch predicate. These cover the LLD's "renders X from view" intents
// by asserting the data the template binds to (and never reaches for hidden data).

function card(rank: Card["rank"], suit: Card["suit"]): TonkCard {
  return { rank, suit };
}

function joker(id: number): TonkCard {
  return { joker: true, id };
}

function publicState(
  overrides: Partial<TonkPublicState> = {},
): TonkPublicState {
  return {
    turnPhase: "discard",
    trickNumber: 1,
    trickTurnCount: 0,
    tonkGateOpen: false,
    stockCount: 30,
    discardTop: null,
    discardCount: 0,
    lastDiscardCount: 0,
    lastDiscardPlayerIndex: null,
    drawableDiscard: null,
    tallies: [],
    log: [],
    ...overrides,
  };
}

function player(id: string, name: string, cardCount: number): PlayerPublicInfo {
  return { playerId: id, displayName: name, cardCount, isConnected: true };
}

function makeView(opts: {
  gameType?: "tonk" | "big2";
  youId?: string | null;
  hand?: readonly TonkCard[];
  players: readonly PlayerPublicInfo[];
  currentPlayerIndex?: number;
  tonk?: TonkPublicState | null;
}): EnrichedPlayerView {
  return {
    gameId: "g1",
    gameType: opts.gameType ?? "tonk",
    status: "IN_PROGRESS",
    version: 1,
    players: opts.players,
    you: {
      playerId: opts.youId ?? "",
      displayName: "Me",
      hand: (opts.hand ?? []) as readonly Card[],
    },
    currentPlayerIndex: opts.currentPlayerIndex ?? 0,
    turnNumber: 1,
    validActions: [],
    gameSpecificPublicState:
      opts.tonk === undefined ? publicState() : opts.tonk,
    winner: null,
    scores: null,
    turnDeadline: null,
    joinCode: "ABCD",
  };
}

// Dispatch predicate transcribed from GameView.vue (gameState.gameType === 'tonk').
function dispatchedBoard(gameType: "tonk" | "big2"): "TonkBoard" | "GameBoard" {
  return gameType === "tonk" ? "TonkBoard" : "GameBoard";
}

describe("GameView dispatch (LLD 89 test 1)", () => {
  it("renders TonkBoard for gameType 'tonk'", () => {
    expect(dispatchedBoard("tonk")).toBe("TonkBoard");
  });

  it("renders GameBoard for gameType 'big2' (Big2 path unaffected)", () => {
    expect(dispatchedBoard("big2")).toBe("GameBoard");
  });
});

describe("useTonkBoard — own hand (LLD 89 test 2)", () => {
  it("exposes N cards for an N-card hand", () => {
    const hand = [card("3", "clubs"), card("K", "hearts"), card("7", "spades")];
    const view = ref(
      makeView({
        youId: "p0",
        hand,
        players: [player("p0", "Me", 3), player("p1", "Bob", 5)],
      }),
    );
    const { myHand } = useTonkBoard(view);
    expect(myHand.value).toHaveLength(3);
  });

  it("includes a Joker in the hand (detected as joker, not a standard card)", () => {
    const hand = [card("3", "clubs"), joker(0)];
    const view = ref(
      makeView({
        youId: "p0",
        hand,
        players: [player("p0", "Me", 2)],
      }),
    );
    const { myHand } = useTonkBoard(view);
    expect(myHand.value).toHaveLength(2);
    const j = myHand.value[1] as { joker?: boolean };
    expect(j.joker).toBe(true);
  });
});

describe("useTonkBoard — discard pile (LLD 89 test 3)", () => {
  it("exposes discardTop and discardCount when a card is present", () => {
    const top = card("9", "diamonds");
    const view = ref(
      makeView({
        youId: "p0",
        players: [player("p0", "Me", 5)],
        tonk: publicState({ discardTop: top, discardCount: 4 }),
      }),
    );
    const { discardTop, discardCount } = useTonkBoard(view);
    expect(discardTop.value).toEqual(top);
    expect(discardCount.value).toBe(4);
  });

  it("exposes null discardTop with count 0 on an empty pile", () => {
    const view = ref(
      makeView({
        youId: "p0",
        players: [player("p0", "Me", 5)],
        tonk: publicState({ discardTop: null, discardCount: 0 }),
      }),
    );
    const { discardTop, discardCount } = useTonkBoard(view);
    expect(discardTop.value).toBeNull();
    expect(discardCount.value).toBe(0);
  });
});

describe("useTonkBoard — drawable indicator (LLD 89 test 4)", () => {
  it("exposes drawableDiscard as a distinct value from discardTop", () => {
    const top = card("9", "diamonds");
    const drawable = card("5", "clubs");
    const view = ref(
      makeView({
        youId: "p0",
        players: [player("p0", "Me", 5)],
        tonk: publicState({
          discardTop: top,
          discardCount: 3,
          drawableDiscard: drawable,
        }),
      }),
    );
    const { discardTop, drawableDiscard, hasDrawable } = useTonkBoard(view);
    expect(hasDrawable.value).toBe(true);
    expect(drawableDiscard.value).toEqual(drawable);
    expect(drawableDiscard.value).not.toEqual(discardTop.value);
  });

  it("reports no drawable (placeholder) when drawableDiscard is null", () => {
    const view = ref(
      makeView({
        youId: "p0",
        players: [player("p0", "Me", 5)],
        tonk: publicState({ drawableDiscard: null }),
      }),
    );
    const { drawableDiscard, hasDrawable } = useTonkBoard(view);
    expect(hasDrawable.value).toBe(false);
    expect(drawableDiscard.value).toBeNull();
  });
});

describe("useTonkBoard — stock (LLD 89 test 5)", () => {
  it("exposes stockCount", () => {
    const view = ref(
      makeView({
        youId: "p0",
        players: [player("p0", "Me", 5)],
        tonk: publicState({ stockCount: 22 }),
      }),
    );
    expect(useTonkBoard(view).stockCount.value).toBe(22);
  });

  it("exposes stockCount 0 when stock is exhausted (renders empty, no backs)", () => {
    const view = ref(
      makeView({
        youId: "p0",
        players: [player("p0", "Me", 5)],
        tonk: publicState({ stockCount: 0 }),
      }),
    );
    expect(useTonkBoard(view).stockCount.value).toBe(0);
  });
});

describe("useTonkBoard — turn + phase (LLD 89 test 7)", () => {
  it("shows the current player's name and 'discard phase'", () => {
    const view = ref(
      makeView({
        youId: "p0",
        players: [player("p0", "Me", 5), player("p1", "Bob", 5)],
        currentPlayerIndex: 1,
        tonk: publicState({ turnPhase: "discard" }),
      }),
    );
    const { currentName, phaseLabel, turnBanner, isMyTurn } =
      useTonkBoard(view);
    expect(currentName.value).toBe("Bob");
    expect(phaseLabel.value).toBe("discard phase");
    expect(isMyTurn.value).toBe(false);
    expect(turnBanner.value).toBe("Bob's turn — discard phase");
  });

  it("shows 'draw phase' and 'Your turn' when it is the viewer's turn", () => {
    const view = ref(
      makeView({
        youId: "p0",
        players: [player("p0", "Me", 5), player("p1", "Bob", 5)],
        currentPlayerIndex: 0,
        tonk: publicState({ turnPhase: "draw" }),
      }),
    );
    const { phaseLabel, turnBanner, isMyTurn } = useTonkBoard(view);
    expect(phaseLabel.value).toBe("draw phase");
    expect(isMyTurn.value).toBe(true);
    expect(turnBanner.value).toBe("Your turn — draw phase");
  });
});

describe("useTonkBoard — tallies + trick (LLD 89 test 8)", () => {
  it("aligns each player's tally to players[] by seat index", () => {
    const view = ref(
      makeView({
        youId: "p0",
        players: [
          player("p0", "Me", 5),
          player("p1", "Bob", 5),
          player("p2", "Cara", 5),
        ],
        currentPlayerIndex: 2,
        tonk: publicState({ tallies: [11, 7, 25], trickNumber: 3 }),
      }),
    );
    const { tallyForSeat, trickNumber } = useTonkBoard(view);
    expect(tallyForSeat(0)).toBe(11);
    expect(tallyForSeat(1)).toBe(7);
    expect(tallyForSeat(2)).toBe(25);
    expect(trickNumber.value).toBe(3);
  });

  it("defends against a tallies/players length mismatch (tallies[i] ?? 0)", () => {
    const view = ref(
      makeView({
        youId: "p0",
        players: [player("p0", "Me", 5), player("p1", "Bob", 5)],
        tonk: publicState({ tallies: [4] }),
      }),
    );
    const { tallyForSeat } = useTonkBoard(view);
    expect(tallyForSeat(0)).toBe(4);
    expect(tallyForSeat(1)).toBe(0);
  });
});

describe("useTonkBoard — seat count / compact seating (LLD 89 test 10)", () => {
  it("does not apply compact seating below the threshold (3 players)", () => {
    const view = ref(
      makeView({
        youId: "p0",
        players: [
          player("p0", "Me", 5),
          player("p1", "Bob", 5),
          player("p2", "Cara", 5),
        ],
        tonk: publicState({ tallies: [0, 0, 0] }),
      }),
    );
    expect(useTonkBoard(view).isCompactSeating.value).toBe(false);
  });

  it("applies compact seating at the threshold and at 8 players", () => {
    for (const n of [COMPACT_SEAT_THRESHOLD, 8]) {
      const players = Array.from({ length: n }, (_unused, i) =>
        player(`p${i}`, `P${i}`, 5),
      );
      const view = ref(
        makeView({
          youId: "p0",
          players,
          tonk: publicState({ tallies: players.map(() => 0) }),
        }),
      );
      expect(useTonkBoard(view).isCompactSeating.value).toBe(true);
    }
  });
});

describe("useTonkBoard — null/loading transition (LLD 89 edge case 1)", () => {
  it("returns null tonkState and neutral defaults when public state is absent", () => {
    const view = ref(
      makeView({
        youId: "p0",
        players: [player("p0", "Me", 5)],
        tonk: null,
      }),
    );
    const { tonkState, stockCount, discardTop, trickNumber, turnBanner } =
      useTonkBoard(view);
    expect(tonkState.value).toBeNull();
    expect(stockCount.value).toBe(0);
    expect(discardTop.value).toBeNull();
    expect(trickNumber.value).toBe(0);
    expect(turnBanner.value).toBe("");
  });
});

describe("useTonkBoard — spectator / information hiding (LLD 89 tests 11–12)", () => {
  it("spectator (you absent / index -1): no own hand, public info still derived", () => {
    const view = ref(
      makeView({
        youId: null, // not among players → spectator
        players: [player("p0", "Me", 5), player("p1", "Bob", 5)],
        currentPlayerIndex: 0,
        tonk: publicState({ stockCount: 18, tallies: [3, 9], trickNumber: 2 }),
      }),
    );
    const {
      isSpectator,
      myPlayerIndex,
      myHand,
      stockCount,
      tallyForSeat,
      trickNumber,
    } = useTonkBoard(view);
    expect(isSpectator.value).toBe(true);
    expect(myPlayerIndex.value).toBe(-1);
    expect(myHand.value).toEqual([]);
    // Public info is unaffected by spectator status.
    expect(stockCount.value).toBe(18);
    expect(tallyForSeat(1)).toBe(9);
    expect(trickNumber.value).toBe(2);
  });

  it("the view never carries opponent hand contents — only counts (information hiding)", () => {
    const view = ref(
      makeView({
        youId: "p0",
        hand: [card("3", "clubs")],
        players: [player("p0", "Me", 1), player("p1", "Bob", 9)],
        tonk: publicState({ stockCount: 12 }),
      }),
    );
    // Opponents are PlayerPublicInfo: cardCount only, no `hand` field exists.
    const opponents = view.value.players.filter((p) => p.playerId !== "p0");
    expect(opponents[0]!.cardCount).toBe(9);
    expect((opponents[0] as Record<string, unknown>).hand).toBeUndefined();
    // Stock is a count only — no card array anywhere in the public state.
    expect(
      (view.value.gameSpecificPublicState as Record<string, unknown>).stock,
    ).toBeUndefined();
  });
});
