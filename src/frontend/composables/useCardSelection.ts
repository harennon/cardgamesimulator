import { ref, computed } from "vue";
import type { Ref, ComputedRef } from "vue";
import type { Card } from "@shared/engine-types";
import type { TonkCard } from "@shared/tonk-types";

// Selection is index-based and rank-agnostic, so one composable serves both the
// Big2 (Card) and Tonk (TonkCard, may include jokers) hands. The composable is
// generic over the hand element type so `selectedCards` preserves it: Big2
// callers still get a `Card[]`, Tonk callers get a `TonkCard[]` (LLD 99
// §Interfaces/Types — useCardSelection widening).
type SelectableCard = Card | TonkCard;

interface UseCardSelectionReturn<T extends SelectableCard> {
  selectedIndices: Ref<Set<number>>;
  selectedCards: ComputedRef<readonly T[]>;
  toggleCard(index: number): void;
  clearSelection(): void;
  selectionCount: ComputedRef<number>;
}

export function useCardSelection<T extends SelectableCard = Card>(
  hand: Ref<readonly T[]>,
): UseCardSelectionReturn<T> {
  const selectedIndices = ref<Set<number>>(new Set());

  const selectedCards = computed<readonly T[]>(() =>
    [...selectedIndices.value]
      .sort((a, b) => a - b)
      .map((i) => hand.value[i])
      .filter((c): c is T => c !== undefined),
  );

  const selectionCount = computed(() => selectedIndices.value.size);

  function toggleCard(index: number): void {
    const next = new Set(selectedIndices.value);
    if (next.has(index)) {
      next.delete(index);
    } else {
      next.add(index);
    }
    selectedIndices.value = next;
  }

  function clearSelection(): void {
    selectedIndices.value = new Set();
  }

  return {
    selectedIndices,
    selectedCards,
    toggleCard,
    clearSelection,
    selectionCount,
  };
}
