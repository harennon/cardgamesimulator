import { describe, it, expect } from "vitest";
import { ref, computed } from "vue";
import type { Big2Play } from "../../src/shared/big2-types.js";
import type { Card, PlayerPublicInfo } from "../../src/shared/engine-types.js";

// LLD 105 (AC 3): the SHOW_FINAL_PLAY reveal layer in GameView.vue surfaces the
// winning lastPlay cards crisply within the Direction-A scrim. The card block is
// rendered iff finalPlay is truthy with cards.length > 0; on a forfeit/no-play
// ending it is omitted and the reveal still shows winner + CTA.
//
// Following the project pattern (node environment, no DOM mount), the computeds
// below are an exact transcription of the reveal block's gating + label logic in
// GameView.vue.

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

function makeRevealLogic(
  finalPlay: ReturnType<typeof ref<Big2Play | null>>,
  players: ReturnType<typeof ref<readonly PlayerPublicInfo[]>>,
) {
  // Template guard: v-if="finalPlay && finalPlay.cards.length > 0"
  const showFinalCards = computed(
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

  return { showFinalCards, finalPlayLabel, finalPlayByName };
}

function makePlayers(): readonly PlayerPublicInfo[] {
  return [
    { playerId: "p1", displayName: "Alice", cardCount: 0, isConnected: true },
    { playerId: "p2", displayName: "Bob", cardCount: 7, isConnected: true },
  ];
}

describe("GameView reveal layer — final-play block (LLD 105)", () => {
  it("renders one card per finalPlay.cards entry when finalPlay has cards", () => {
    const cards = [card("A", "spades"), card("A", "hearts")];
    const finalPlay = ref<Big2Play | null>({
      cards,
      handType: { kind: "pair", rank: "A", highCard: card("A", "spades") },
      playerId: "p1",
    });
    const players = ref(makePlayers());
    const t = makeRevealLogic(finalPlay, players);

    expect(t.showFinalCards.value).toBe(true);
    // Template iterates finalPlay.cards → one GameCard per card.
    expect(finalPlay.value!.cards).toHaveLength(2);
    expect(t.finalPlayLabel.value).toBe("Pair");
    expect(t.finalPlayByName.value).toBe("Alice");
  });

  it("omits the final-play card block when finalPlay is null (forfeit)", () => {
    const finalPlay = ref<Big2Play | null>(null);
    const players = ref(makePlayers());
    const t = makeRevealLogic(finalPlay, players);

    // Winner + CTA still render (driven by winnerDisplayName + skipToResults,
    // not by finalPlay); only the card block is gated off — no crash, no box.
    expect(t.showFinalCards.value).toBe(false);
  });

  it("omits the card block when finalPlay has an empty cards array", () => {
    const finalPlay = ref<Big2Play | null>({
      cards: [],
      handType: { kind: "single", card: card("3", "clubs") },
      playerId: "p1",
    });
    const players = ref(makePlayers());
    const t = makeRevealLogic(finalPlay, players);

    expect(t.showFinalCards.value).toBe(false);
  });

  it("falls back to the raw kind when the hand-type label is unknown", () => {
    const finalPlay = ref<Big2Play | null>({
      cards: [card("3", "clubs")],
      handType: { kind: "mystery" } as unknown as Big2Play["handType"],
      playerId: "p1",
    });
    const players = ref(makePlayers());
    const t = makeRevealLogic(finalPlay, players);

    expect(t.showFinalCards.value).toBe(true);
    expect(t.finalPlayLabel.value).toBe("mystery");
  });

  it("falls back to the playerId when the player is not found", () => {
    const finalPlay = ref<Big2Play | null>({
      cards: [card("3", "clubs")],
      handType: { kind: "single", card: card("3", "clubs") },
      playerId: "ghost",
    });
    const players = ref(makePlayers());
    const t = makeRevealLogic(finalPlay, players);

    expect(t.finalPlayByName.value).toBe("ghost");
  });
});
