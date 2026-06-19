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

  // Accumulates toggles that arrive within the same animation frame so rapid
  // multi-taps are batched into a single reactive update.
  let pending: Set<number> | null = null;

  function toggleCard(index: number): void {
    const base = pending ?? selectedIndices.value;
    const next = new Set(base);
    if (next.has(index)) {
      next.delete(index);
    } else {
      next.add(index);
    }
    pending = next;
    requestAnimationFrame(() => {
      // Guard: a prior rAF in the same batch may have already flushed pending,
      // or clearSelection may have nullified it. Only write if still pending.
      if (pending !== null) {
        selectedIndices.value = pending;
        pending = null;
      }
    });
  }

  function clearSelection(): void {
    pending = null;
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
