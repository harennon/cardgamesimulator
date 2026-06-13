import { ref, computed } from "vue";
import type { Ref, ComputedRef } from "vue";
import type { Card } from "@shared/engine-types";

interface UseCardSelectionReturn {
  selectedIndices: Ref<Set<number>>;
  selectedCards: ComputedRef<readonly Card[]>;
  toggleCard(index: number): void;
  clearSelection(): void;
  selectionCount: ComputedRef<number>;
}

export function useCardSelection(
  hand: Ref<readonly Card[]>,
): UseCardSelectionReturn {
  const selectedIndices = ref<Set<number>>(new Set());

  const selectedCards = computed<readonly Card[]>(() =>
    [...selectedIndices.value]
      .sort((a, b) => a - b)
      .map((i) => hand.value[i])
      .filter((c): c is Card => c !== undefined),
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
