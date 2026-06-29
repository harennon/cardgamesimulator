import { describe, it, expect } from "vitest";
import { ref, computed } from "vue";
import type { Big2Play } from "../../src/shared/big2-types.js";
import type { Card, PlayerPublicInfo } from "../../src/shared/engine-types.js";

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
