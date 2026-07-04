import { describe, it, expect } from "vitest";
import { ref, computed } from "vue";
import type { Card, PlayerPublicInfo } from "../../src/shared/engine-types.js";
import type { EnrichedPlayerView } from "../../src/shared/socket-events.js";
import type {
  TonkPublicState,
  TonkLogEntry,
  TonkTrickResult,
} from "../../src/shared/tonk-types.js";

// Transcription of GameView.vue's tonkFinalMove computed, tested in isolation
// (project pattern — node env, no DOM mount).

function card(rank: Card["rank"], suit: Card["suit"]): Card {
  return { rank, suit };
}

function makePlayers(): readonly PlayerPublicInfo[] {
  return [
    { playerId: "me", displayName: "Me", cardCount: 5, isConnected: true },
    { playerId: "p2", displayName: "Bob", cardCount: 6, isConnected: true },
    { playerId: "p3", displayName: "Cara", cardCount: 7, isConnected: true },
  ];
}

function makeTrickResult(trickNumber = 1): TonkTrickResult {
  return {
    trickNumber,
    reason: "tonk",
    tonkCallerIndex: 0,
    revealedHands: [
      [card("A", "spades")],
      [card("K", "hearts")],
      [card("Q", "diamonds")],
    ],
    handValues: [12, 4, 20],
    tallyDeltas: [12, 4, 20],
  };
}

function makeLogEntry(over: Partial<TonkLogEntry> = {}): TonkLogEntry {
  return {
    playerId: "me",
    displayName: "Me",
    type: "callTonk",
    ...over,
  };
}

function makeTonkPublicState(
  log: readonly TonkLogEntry[] = [],
): TonkPublicState {
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
    log,
  };
}

function makeGameView(
  over: Partial<EnrichedPlayerView> = {},
): ReturnType<typeof ref<EnrichedPlayerView>> {
  const view: EnrichedPlayerView = {
    gameId: "g1",
    gameType: "tonk",
    status: "COMPLETED",
    version: 1,
    players: makePlayers() as PlayerPublicInfo[],
    you: {
      playerId: "me",
      displayName: "Me",
      hand: [card("A", "spades"), card("K", "hearts")],
    },
    currentPlayerIndex: 0,
    turnNumber: 3,
    validActions: [],
    gameSpecificPublicState: makeTonkPublicState(),
    winner: "me",
    scores: null,
    turnDeadline: null,
    joinCode: "ABCD",
    ...over,
  };
  return ref(view);
}

interface TonkFinalMove {
  entry: TonkLogEntry;
  players: readonly PlayerPublicInfo[];
}

function makeTonkFinalMoveLogic(
  gameState: ReturnType<typeof ref<EnrichedPlayerView>>,
) {
  const tonkFinalMove = computed<TonkFinalMove | null>(() => {
    if (gameState.value?.gameType !== "tonk") return null;
    const publicState = gameState.value.gameSpecificPublicState as
      | TonkPublicState
      | undefined;
    const log = publicState?.log;
    if (!log || log.length === 0) return null;
    const entry = log[log.length - 1];
    if (!entry.trickResult) return null;
    return { entry, players: gameState.value.players };
  });
  return { tonkFinalMove };
}

describe("GameView — tonkFinalMove derivation", () => {
  it("returns null when gameType is not tonk (Big2 path)", () => {
    const gs = makeGameView({ gameType: "big2" });
    const { tonkFinalMove } = makeTonkFinalMoveLogic(gs);
    expect(tonkFinalMove.value).toBeNull();
  });

  it("returns null when the Tonk log is empty", () => {
    const gs = makeGameView({
      gameSpecificPublicState: makeTonkPublicState([]),
    });
    const { tonkFinalMove } = makeTonkFinalMoveLogic(gs);
    expect(tonkFinalMove.value).toBeNull();
  });

  it("returns null when the last log entry has no trickResult", () => {
    const log: readonly TonkLogEntry[] = [
      makeLogEntry({ type: "discard", trickResult: undefined }),
    ];
    const gs = makeGameView({
      gameSpecificPublicState: makeTonkPublicState(log),
    });
    const { tonkFinalMove } = makeTonkFinalMoveLogic(gs);
    expect(tonkFinalMove.value).toBeNull();
  });

  it("returns the last entry with trickResult when it is present", () => {
    const result = makeTrickResult(2);
    const log: readonly TonkLogEntry[] = [
      makeLogEntry({ type: "discard", trickResult: undefined }),
      makeLogEntry({ type: "callTonk", trickResult: result }),
    ];
    const gs = makeGameView({
      gameSpecificPublicState: makeTonkPublicState(log),
    });
    const { tonkFinalMove } = makeTonkFinalMoveLogic(gs);
    expect(tonkFinalMove.value).not.toBeNull();
    expect(tonkFinalMove.value!.entry).toStrictEqual(log[log.length - 1]);
    expect(tonkFinalMove.value!.entry.trickResult).toStrictEqual(result);
    expect(tonkFinalMove.value!.players).toHaveLength(3);
  });

  it("picks the NEWEST entry (log[length-1]), not an earlier trick-result entry", () => {
    const olderResult = makeTrickResult(1);
    const newerResult = makeTrickResult(2);
    const log: readonly TonkLogEntry[] = [
      makeLogEntry({ type: "callTonk", trickResult: olderResult }),
      makeLogEntry({
        type: "callTonk",
        displayName: "Bob",
        trickResult: newerResult,
      }),
    ];
    const gs = makeGameView({
      gameSpecificPublicState: makeTonkPublicState(log),
    });
    const { tonkFinalMove } = makeTonkFinalMoveLogic(gs);
    expect(tonkFinalMove.value!.entry.trickResult!.trickNumber).toBe(2);
    expect(tonkFinalMove.value!.entry.displayName).toBe("Bob");
  });

  it("returns null when the last entry lacks trickResult even though an earlier one has it", () => {
    const log: readonly TonkLogEntry[] = [
      makeLogEntry({ type: "callTonk", trickResult: makeTrickResult(1) }),
      makeLogEntry({
        type: "draw",
        drawSource: "stock",
        trickResult: undefined,
      }),
    ];
    const gs = makeGameView({
      gameSpecificPublicState: makeTonkPublicState(log),
    });
    const { tonkFinalMove } = makeTonkFinalMoveLogic(gs);
    expect(tonkFinalMove.value).toBeNull();
  });
});
