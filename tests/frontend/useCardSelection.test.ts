import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ref } from "vue";
import type { Card } from "../../src/shared/engine-types.js";
import { useCardSelection } from "../../src/frontend/composables/useCardSelection.js";

function makeHand(count: number): Card[] {
  const ranks = [
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "J",
    "Q",
    "K",
    "A",
    "2",
  ] as const;
  return Array.from({ length: count }, (_, i) => ({
    suit: "clubs" as const,
    rank: ranks[i % ranks.length],
  }));
}

// By default, mock requestAnimationFrame to run callbacks synchronously so
// existing tests remain straightforward. Tests that need to verify batching
// behaviour override this mock locally.
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useCardSelection", () => {
  describe("initial state", () => {
    it("starts with no cards selected", () => {
      const hand = ref<readonly Card[]>(makeHand(5));
      const { selectedIndices, selectionCount } = useCardSelection(hand);
      expect(selectedIndices.value.size).toBe(0);
      expect(selectionCount.value).toBe(0);
    });

    it("selectedCards is empty when nothing is selected", () => {
      const hand = ref<readonly Card[]>(makeHand(5));
      const { selectedCards } = useCardSelection(hand);
      expect(selectedCards.value).toEqual([]);
    });
  });

  describe("toggleCard", () => {
    it("selects a card by index", () => {
      const hand = ref<readonly Card[]>(makeHand(5));
      const { toggleCard, selectedIndices, selectionCount } =
        useCardSelection(hand);

      toggleCard(2);

      expect(selectedIndices.value.has(2)).toBe(true);
      expect(selectionCount.value).toBe(1);
    });

    it("deselects an already-selected card", () => {
      const hand = ref<readonly Card[]>(makeHand(5));
      const { toggleCard, selectedIndices, selectionCount } =
        useCardSelection(hand);

      toggleCard(2);
      toggleCard(2);

      expect(selectedIndices.value.has(2)).toBe(false);
      expect(selectionCount.value).toBe(0);
    });

    it("can select multiple cards", () => {
      const hand = ref<readonly Card[]>(makeHand(5));
      const { toggleCard, selectionCount } = useCardSelection(hand);

      toggleCard(0);
      toggleCard(2);
      toggleCard(4);

      expect(selectionCount.value).toBe(3);
    });

    it("does not affect other selected indices when toggling one", () => {
      const hand = ref<readonly Card[]>(makeHand(5));
      const { toggleCard, selectedIndices } = useCardSelection(hand);

      toggleCard(0);
      toggleCard(1);
      toggleCard(0); // deselect 0

      expect(selectedIndices.value.has(0)).toBe(false);
      expect(selectedIndices.value.has(1)).toBe(true);
    });
  });

  describe("selectedCards", () => {
    it("returns the cards at the selected indices", () => {
      const cards = makeHand(5);
      const hand = ref<readonly Card[]>(cards);
      const { toggleCard, selectedCards } = useCardSelection(hand);

      toggleCard(1);
      toggleCard(3);

      expect(selectedCards.value).toEqual([cards[1], cards[3]]);
    });

    it("returns cards in index-sorted order regardless of toggle order", () => {
      const cards = makeHand(5);
      const hand = ref<readonly Card[]>(cards);
      const { toggleCard, selectedCards } = useCardSelection(hand);

      toggleCard(4);
      toggleCard(0);
      toggleCard(2);

      expect(selectedCards.value).toEqual([cards[0], cards[2], cards[4]]);
    });

    it("filters out undefined for out-of-range indices", () => {
      const cards = makeHand(3);
      const hand = ref<readonly Card[]>(cards);
      const { toggleCard, selectedCards } = useCardSelection(hand);

      toggleCard(1);
      toggleCard(99);

      expect(selectedCards.value).toEqual([cards[1]]);
    });

    it("updates reactively when hand changes", () => {
      const initialCards = makeHand(5);
      const hand = ref<readonly Card[]>(initialCards);
      const { toggleCard, selectedCards } = useCardSelection(hand);

      toggleCard(0);

      const newCards = makeHand(5);
      hand.value = newCards;

      expect(selectedCards.value).toEqual([newCards[0]]);
    });
  });

  describe("clearSelection", () => {
    it("removes all selected indices", () => {
      const hand = ref<readonly Card[]>(makeHand(5));
      const { toggleCard, clearSelection, selectedIndices, selectionCount } =
        useCardSelection(hand);

      toggleCard(0);
      toggleCard(2);
      toggleCard(4);
      clearSelection();

      expect(selectedIndices.value.size).toBe(0);
      expect(selectionCount.value).toBe(0);
    });

    it("clearSelection on empty selection is a no-op", () => {
      const hand = ref<readonly Card[]>(makeHand(5));
      const { clearSelection, selectionCount } = useCardSelection(hand);

      clearSelection();

      expect(selectionCount.value).toBe(0);
    });

    it("selectedCards is empty after clear", () => {
      const hand = ref<readonly Card[]>(makeHand(5));
      const { toggleCard, clearSelection, selectedCards } =
        useCardSelection(hand);

      toggleCard(1);
      toggleCard(3);
      clearSelection();

      expect(selectedCards.value).toEqual([]);
    });
  });

  describe("selectionCount", () => {
    it("tracks count accurately through a sequence of toggles and clears", () => {
      const hand = ref<readonly Card[]>(makeHand(10));
      const { toggleCard, clearSelection, selectionCount } =
        useCardSelection(hand);

      toggleCard(0);
      expect(selectionCount.value).toBe(1);

      toggleCard(1);
      toggleCard(2);
      expect(selectionCount.value).toBe(3);

      toggleCard(1);
      expect(selectionCount.value).toBe(2);

      clearSelection();
      expect(selectionCount.value).toBe(0);
    });
  });

  describe("rAF batching", () => {
    it("batches two rapid toggles within the same frame into one update", () => {
      // Collect pending rAF callbacks without executing them immediately.
      const rafQueue: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return rafQueue.length - 1;
      });

      const hand = ref<readonly Card[]>(makeHand(5));
      const { toggleCard, selectedIndices } = useCardSelection(hand);

      // Both calls land before any rAF fires.
      toggleCard(0);
      toggleCard(1);

      // Nothing applied yet.
      expect(selectedIndices.value.size).toBe(0);

      // Fire all pending frames.
      for (const cb of rafQueue) cb(0);

      expect(selectedIndices.value.has(0)).toBe(true);
      expect(selectedIndices.value.has(1)).toBe(true);
    });

    it("toggle-then-untoggle in the same frame results in no selection", () => {
      const rafQueue: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return rafQueue.length - 1;
      });

      const hand = ref<readonly Card[]>(makeHand(5));
      const { toggleCard, selectedIndices } = useCardSelection(hand);

      toggleCard(0);
      toggleCard(0); // undo

      for (const cb of rafQueue) cb(0);

      expect(selectedIndices.value.has(0)).toBe(false);
    });

    it("clearSelection called after toggleCard cancels the pending rAF update", () => {
      const rafQueue: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return rafQueue.length - 1;
      });

      const hand = ref<readonly Card[]>(makeHand(5));
      const { toggleCard, clearSelection, selectedIndices } =
        useCardSelection(hand);

      toggleCard(0);
      clearSelection(); // must nullify pending before rAF fires

      // Fire all pending frames.
      for (const cb of rafQueue) cb(0);

      // The clear must win — selection must remain empty.
      expect(selectedIndices.value.size).toBe(0);
    });
  });
});
