import { describe, it, expect } from "vitest";
import { ref, computed } from "vue";
import type { Big2Play } from "../../src/shared/big2-types.js";
import type { Card, PlayerPublicInfo } from "../../src/shared/engine-types.js";
import type {
  TonkLogEntry,
  TonkTrickResult,
} from "../../src/shared/tonk-types.js";
import {
  logActionText,
  trickResultSummary,
} from "../../src/frontend/component/game-ui/tonkDisplay.js";

// LLD 73: GameOverView gains an optional read-only "final play" row that
// surfaces the last cards played after the user leaves the board phase.
//
// The project tests Vue component <script setup> logic in isolation (node
// environment, no DOM mount) — see trickPile.test.ts / gameBoardMobile.test.ts.
// The computeds below are an exact transcription of the row's gating + label
// logic in GameOverView.vue. The template renders the row iff `hasFinalPlay`.

const HAND_TYPE_LABELS: Record<string, string> = {
  single: "Single",
  pair: "Pair",
  straight: "Straight",
  fullHouse: "Full House",
  fourOfAKind: "Four of a Kind",
  straightFlush: "Straight Flush",
};

function card(rank: Card["rank"], suit: Card["suit"]): Card {
  return { rank, suit };
}

function makeFinalPlayLogic(
  finalPlay: ReturnType<typeof ref<Big2Play | null | undefined>>,
  players: ReturnType<typeof ref<readonly PlayerPublicInfo[]>>,
) {
  const hasFinalPlay = computed(
    () => !!finalPlay.value && finalPlay.value.cards.length > 0,
  );

  const finalPlayLabel = computed(() => {
    if (!finalPlay.value) return "";
    return (
      HAND_TYPE_LABELS[finalPlay.value.handType.kind] ??
      finalPlay.value.handType.kind
    );
  });

  const finalPlayByName = computed(() => {
    if (!finalPlay.value) return "";
    const player = (players.value ?? []).find(
      (p) => p.playerId === finalPlay.value!.playerId,
    );
    return player?.displayName ?? finalPlay.value.playerId;
  });

  return { hasFinalPlay, finalPlayLabel, finalPlayByName };
}

function makePlayers(): readonly PlayerPublicInfo[] {
  return [
    { playerId: "p1", displayName: "Alice", cardCount: 0, isConnected: true },
    { playerId: "p2", displayName: "Bob", cardCount: 7, isConnected: true },
  ];
}

describe("GameOverView — final play row gating", () => {
  it("renders the row (one card each) when finalPlay has cards", () => {
    const cards = [card("A", "spades"), card("A", "hearts")];
    const finalPlay = ref<Big2Play | null | undefined>({
      cards,
      handType: { kind: "pair", rank: "A", highCard: card("A", "spades") },
      playerId: "p1",
    });
    const players = ref(makePlayers());
    const t = makeFinalPlayLogic(finalPlay, players);

    expect(t.hasFinalPlay.value).toBe(true);
    // The template iterates finalPlay.cards → one GameCard per card.
    expect(finalPlay.value!.cards).toHaveLength(2);
    expect(t.finalPlayLabel.value).toBe("Pair");
    expect(t.finalPlayByName.value).toBe("Alice");
  });

  it("does NOT render the row when finalPlay is null (forfeit / no play)", () => {
    const finalPlay = ref<Big2Play | null | undefined>(null);
    const players = ref(makePlayers());
    const t = makeFinalPlayLogic(finalPlay, players);

    expect(t.hasFinalPlay.value).toBe(false);
  });

  it("does NOT render the row when finalPlay is undefined (prop omitted)", () => {
    const finalPlay = ref<Big2Play | null | undefined>(undefined);
    const players = ref(makePlayers());
    const t = makeFinalPlayLogic(finalPlay, players);

    expect(t.hasFinalPlay.value).toBe(false);
  });

  it("does NOT render the row when finalPlay has an empty cards array", () => {
    const finalPlay = ref<Big2Play | null | undefined>({
      cards: [],
      handType: { kind: "single", card: card("3", "clubs") },
      playerId: "p1",
    });
    const players = ref(makePlayers());
    const t = makeFinalPlayLogic(finalPlay, players);

    expect(t.hasFinalPlay.value).toBe(false);
  });

  it("falls back to the raw kind when the hand-type label is unknown", () => {
    const finalPlay = ref<Big2Play | null | undefined>({
      cards: [card("3", "clubs")],
      // Cast an unknown kind to exercise the fallback branch.
      handType: { kind: "mystery" } as unknown as Big2Play["handType"],
      playerId: "p1",
    });
    const players = ref(makePlayers());
    const t = makeFinalPlayLogic(finalPlay, players);

    expect(t.hasFinalPlay.value).toBe(true);
    expect(t.finalPlayLabel.value).toBe("mystery");
  });

  it("falls back to the playerId when the player is not found", () => {
    const finalPlay = ref<Big2Play | null | undefined>({
      cards: [card("3", "clubs")],
      handType: { kind: "single", card: card("3", "clubs") },
      playerId: "unknown-id",
    });
    const players = ref(makePlayers());
    const t = makeFinalPlayLogic(finalPlay, players);

    expect(t.finalPlayByName.value).toBe("unknown-id");
  });
});

// ---------------------------------------------------------------------------
// Tonk Final Move block (LLD 144)
// ---------------------------------------------------------------------------

function makeTonkPlayers(): readonly PlayerPublicInfo[] {
  return [
    { playerId: "me", displayName: "Me", cardCount: 5, isConnected: true },
    { playerId: "p2", displayName: "Bob", cardCount: 6, isConnected: true },
    { playerId: "p3", displayName: "Cara", cardCount: 7, isConnected: true },
  ];
}

function makeTrickResult(): TonkTrickResult {
  return {
    trickNumber: 3,
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

function makeCallTonkEntry(): TonkLogEntry {
  return {
    playerId: "me",
    displayName: "Me",
    type: "callTonk",
    trickResult: makeTrickResult(),
  };
}

function makeDrawEntry(source: "stock" | "discard" = "stock"): TonkLogEntry {
  return {
    playerId: "p2",
    displayName: "Bob",
    type: "draw",
    drawSource: source,
    trickResult: makeTrickResult(),
  };
}

interface TonkFinalMove {
  entry: TonkLogEntry;
  players: readonly PlayerPublicInfo[];
}

function makeTonkFinalMoveLogic(
  tonkFinalMove: ReturnType<typeof ref<TonkFinalMove | null | undefined>>,
) {
  const hasTonkFinalMove = computed(() => !!tonkFinalMove.value);

  const tonkFinalMoveAction = computed(() =>
    tonkFinalMove.value ? logActionText(tonkFinalMove.value.entry) : "",
  );

  const tonkFinalMoveBy = computed(
    () => tonkFinalMove.value?.entry.displayName ?? "",
  );

  const tonkFinalMoveOutcome = computed(() =>
    tonkFinalMove.value
      ? (trickResultSummary(
          tonkFinalMove.value.entry,
          tonkFinalMove.value.players,
        ) ?? "")
      : "",
  );

  return {
    hasTonkFinalMove,
    tonkFinalMoveAction,
    tonkFinalMoveBy,
    tonkFinalMoveOutcome,
  };
}

describe("GameOverView — Tonk Final Move block (LLD 144)", () => {
  it("hasTonkFinalMove is true when tonkFinalMove is present", () => {
    const tfm = ref<TonkFinalMove | null | undefined>({
      entry: makeCallTonkEntry(),
      players: makeTonkPlayers(),
    });
    const t = makeTonkFinalMoveLogic(tfm);
    expect(t.hasTonkFinalMove.value).toBe(true);
  });

  it("hasTonkFinalMove is false when tonkFinalMove is null", () => {
    const tfm = ref<TonkFinalMove | null | undefined>(null);
    const t = makeTonkFinalMoveLogic(tfm);
    expect(t.hasTonkFinalMove.value).toBe(false);
  });

  it("hasTonkFinalMove is false when tonkFinalMove is undefined (prop omitted)", () => {
    const tfm = ref<TonkFinalMove | null | undefined>(undefined);
    const t = makeTonkFinalMoveLogic(tfm);
    expect(t.hasTonkFinalMove.value).toBe(false);
  });

  it("tonkFinalMoveAction returns 'called TONK' for a callTonk entry", () => {
    const tfm = ref<TonkFinalMove | null | undefined>({
      entry: makeCallTonkEntry(),
      players: makeTonkPlayers(),
    });
    const t = makeTonkFinalMoveLogic(tfm);
    expect(t.tonkFinalMoveAction.value).toBe("called TONK");
  });

  it("tonkFinalMoveAction returns draw-source text for a draw entry", () => {
    const tfm = ref<TonkFinalMove | null | undefined>({
      entry: makeDrawEntry("stock"),
      players: makeTonkPlayers(),
    });
    const t = makeTonkFinalMoveLogic(tfm);
    expect(t.tonkFinalMoveAction.value).toBe("drew from stock");
  });

  it("tonkFinalMoveAction returns discard-source text for a draw-from-discard entry", () => {
    const tfm = ref<TonkFinalMove | null | undefined>({
      entry: makeDrawEntry("discard"),
      players: makeTonkPlayers(),
    });
    const t = makeTonkFinalMoveLogic(tfm);
    expect(t.tonkFinalMoveAction.value).toBe("drew from discard");
  });

  it("tonkFinalMoveBy returns the entry's displayName", () => {
    const tfm = ref<TonkFinalMove | null | undefined>({
      entry: makeCallTonkEntry(),
      players: makeTonkPlayers(),
    });
    const t = makeTonkFinalMoveLogic(tfm);
    expect(t.tonkFinalMoveBy.value).toBe("Me");
  });

  it("tonkFinalMoveOutcome equals trickResultSummary for the entry", () => {
    const entry = makeCallTonkEntry();
    const players = makeTonkPlayers();
    const tfm = ref<TonkFinalMove | null | undefined>({ entry, players });
    const t = makeTonkFinalMoveLogic(tfm);
    const expected = trickResultSummary(entry, players) ?? "";
    expect(t.tonkFinalMoveOutcome.value).toBe(expected);
    expect(t.tonkFinalMoveOutcome.value).not.toBe("");
  });

  it("tonkFinalMoveOutcome coalesces to '' when trickResultSummary returns null (no trickResult)", () => {
    const entryNoResult: TonkLogEntry = {
      playerId: "me",
      displayName: "Me",
      type: "callTonk",
      // no trickResult → trickResultSummary returns null
    };
    const tfm = ref<TonkFinalMove | null | undefined>({
      entry: entryNoResult,
      players: makeTonkPlayers(),
    });
    const t = makeTonkFinalMoveLogic(tfm);
    expect(t.tonkFinalMoveOutcome.value).toBe("");
  });

  it("mutual exclusivity: Big2 finalPlay set + tonkFinalMove null → hasTonkFinalMove false", () => {
    const finalPlay = ref<Big2Play | null | undefined>({
      cards: [card("3", "clubs")],
      handType: { kind: "single", card: card("3", "clubs") },
      playerId: "p1",
    });
    const players = ref(makePlayers());
    const big2Logic = makeFinalPlayLogic(finalPlay, players);

    const tfm = ref<TonkFinalMove | null | undefined>(null);
    const tonkLogic = makeTonkFinalMoveLogic(tfm);

    expect(big2Logic.hasFinalPlay.value).toBe(true);
    expect(tonkLogic.hasTonkFinalMove.value).toBe(false);
  });

  it("mutual exclusivity: tonkFinalMove set + Big2 finalPlay null → hasFinalPlay false", () => {
    const finalPlay = ref<Big2Play | null | undefined>(null);
    const players = ref(makePlayers());
    const big2Logic = makeFinalPlayLogic(finalPlay, players);

    const tfm = ref<TonkFinalMove | null | undefined>({
      entry: makeCallTonkEntry(),
      players: makeTonkPlayers(),
    });
    const tonkLogic = makeTonkFinalMoveLogic(tfm);

    expect(big2Logic.hasFinalPlay.value).toBe(false);
    expect(tonkLogic.hasTonkFinalMove.value).toBe(true);
  });
});
