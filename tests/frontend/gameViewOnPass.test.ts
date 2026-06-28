import { describe, it, expect, vi } from "vitest";
import { ref } from "vue";
import type { Card } from "../../src/shared/engine-types.js";
import { useCardSelection } from "../../src/frontend/composables/useCardSelection.js";

// ---------------------------------------------------------------------------
// Tests for the onPass / onPlay selection-clearing behavior in GameView.vue
// (LLD 52). Following the project pattern (see gameOverTransition.test.ts), we
// replicate the two handlers in isolation, wiring the REAL useCardSelection
// composable to a mockable pass()/playCards(), then assert against the
// composable's selection state. The fix under test is the unconditional
// clearSelection() call added to onPass().
// ---------------------------------------------------------------------------

function makeHand(count: number): Card[] {
  return Array.from({ length: count }, () => ({
    suit: "clubs" as const,
    rank: "3" as const,
  }));
}

type ActionResult = { success: boolean; error?: string };

/**
 * Replicates onPass / onPlay from GameView.vue against the real card-selection
 * composable. pass()/playCards() are injected so each test controls the
 * server outcome.
 */
function createHandlers(
  handSize: number,
  pass: (gameId: string) => Promise<ActionResult>,
  playCards: (gameId: string, cards: readonly Card[]) => Promise<ActionResult>,
) {
  const gameId = "game-1";
  const hand = ref<readonly Card[]>(makeHand(handSize));
  const {
    selectedIndices,
    selectedCards,
    selectionCount,
    toggleCard,
    clearSelection,
  } = useCardSelection(hand);

  async function onPlay(): Promise<void> {
    const result = await playCards(gameId, selectedCards.value);
    if (result.success) {
      clearSelection();
    }
  }

  async function onPass(): Promise<void> {
    await pass(gameId);
    clearSelection();
  }

  return {
    gameId,
    selectedIndices,
    selectionCount,
    toggleCard,
    onPlay,
    onPass,
  };
}

describe("GameView onPass selection clearing (LLD 52)", () => {
  it("clears selection after onPass resolves when one card is selected", async () => {
    const pass = vi.fn(async () => ({ success: true }));
    const playCards = vi.fn(async () => ({ success: true }));
    const { selectionCount, toggleCard, onPass } = createHandlers(
      5,
      pass,
      playCards,
    );

    toggleCard(2);
    expect(selectionCount.value).toBe(1);

    await onPass();

    expect(selectionCount.value).toBe(0);
  });

  it("clears selection after onPass resolves when several cards are selected", async () => {
    const pass = vi.fn(async () => ({ success: true }));
    const playCards = vi.fn(async () => ({ success: true }));
    const { selectionCount, toggleCard, onPass } = createHandlers(
      5,
      pass,
      playCards,
    );

    toggleCard(0);
    toggleCard(2);
    toggleCard(4);
    expect(selectionCount.value).toBe(3);

    await onPass();

    expect(selectionCount.value).toBe(0);
  });

  it("is a no-op and does not throw when no cards are selected", async () => {
    const pass = vi.fn(async () => ({ success: true }));
    const playCards = vi.fn(async () => ({ success: true }));
    const { selectionCount, onPass } = createHandlers(5, pass, playCards);

    expect(selectionCount.value).toBe(0);
    await expect(onPass()).resolves.toBeUndefined();
    expect(selectionCount.value).toBe(0);
  });

  it("calls pass exactly once with the gameId per onPass invocation", async () => {
    const pass = vi.fn(async () => ({ success: true }));
    const playCards = vi.fn(async () => ({ success: true }));
    const { gameId, toggleCard, onPass } = createHandlers(5, pass, playCards);

    toggleCard(1);
    await onPass();

    expect(pass).toHaveBeenCalledTimes(1);
    expect(pass).toHaveBeenCalledWith(gameId);
    expect(playCards).not.toHaveBeenCalled();
  });

  it("clears selection even when pass resolves as a failure (unconditional clear)", async () => {
    const pass = vi.fn(async () => ({ success: false, error: "Cannot pass" }));
    const playCards = vi.fn(async () => ({ success: true }));
    const { selectionCount, toggleCard, onPass } = createHandlers(
      5,
      pass,
      playCards,
    );

    toggleCard(0);
    toggleCard(3);
    expect(selectionCount.value).toBe(2);

    await onPass();

    expect(selectionCount.value).toBe(0);
  });

  it("is idempotent across a rapid double-press of pass", async () => {
    const pass = vi.fn(async () => ({ success: true }));
    const playCards = vi.fn(async () => ({ success: true }));
    const { selectionCount, toggleCard, onPass } = createHandlers(
      5,
      pass,
      playCards,
    );

    toggleCard(0);
    await onPass();
    expect(selectionCount.value).toBe(0);

    await onPass();
    expect(selectionCount.value).toBe(0);
    expect(pass).toHaveBeenCalledTimes(2);
  });
});

describe("GameView onPlay selection clearing unchanged (LLD 52 regression)", () => {
  it("clears selection only when play succeeds", async () => {
    const pass = vi.fn(async () => ({ success: true }));
    const playCards = vi.fn(async () => ({ success: true }));
    const { selectionCount, toggleCard, onPlay } = createHandlers(
      5,
      pass,
      playCards,
    );

    toggleCard(1);
    toggleCard(2);
    expect(selectionCount.value).toBe(2);

    await onPlay();

    expect(selectionCount.value).toBe(0);
    expect(playCards).toHaveBeenCalledTimes(1);
  });

  it("does NOT clear selection when play fails", async () => {
    const pass = vi.fn(async () => ({ success: true }));
    const playCards = vi.fn(async () => ({
      success: false,
      error: "Invalid play",
    }));
    const { selectionCount, toggleCard, onPlay } = createHandlers(
      5,
      pass,
      playCards,
    );

    toggleCard(1);
    toggleCard(2);
    expect(selectionCount.value).toBe(2);

    await onPlay();

    // Selection must survive a failed play so the user can retry.
    expect(selectionCount.value).toBe(2);
  });
});
