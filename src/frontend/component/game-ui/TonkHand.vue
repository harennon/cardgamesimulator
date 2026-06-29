<template>
  <div class="tonk-hand" data-testid="tonk-hand">
    <GameCard
      v-for="(card, index) in cards"
      :key="isJoker(card) ? `joker-${card.id}` : `${card.rank}-${card.suit}`"
      :card="card"
      :interactive="selectable"
      :selected="selectable && (selectedIndices?.has(index) ?? false)"
      size="large"
      class="tonk-hand__card"
      :class="{
        'tonk-hand__card--first': index === 0,
        'tonk-hand__card--dimmed': dimmedIndices?.has(index) ?? false,
        'tonk-hand__card--badselect':
          badSelect && (selectedIndices?.has(index) ?? false),
      }"
      @click="selectable && emit('toggle', index)"
    />
  </div>
</template>

<script lang="ts" setup>
import type { TonkCard } from "@shared/tonk-types";
import { isJoker } from "@shared/tonk-types";
import GameCard from "./GameCard.vue";

withDefaults(
  defineProps<{
    cards: readonly TonkCard[];
    selectable?: boolean;
    selectedIndices?: ReadonlySet<number>;
    dimmedIndices?: ReadonlySet<number>;
    badSelect?: boolean;
  }>(),
  { selectable: false, badSelect: false },
);

const emit = defineEmits<{ toggle: [index: number] }>();
</script>

<style scoped>
@import "@/styles/game-variables.css";

.tonk-hand {
  display: flex;
  align-items: flex-end;
  padding: 24px 16px 8px;
  overflow-x: auto;
}

.tonk-hand__card {
  margin-left: var(--card-overlap);
  cursor: default;
  transition:
    opacity 0.15s ease,
    transform var(--card-select-duration) var(--card-select-easing);
}

.tonk-hand__card--first {
  margin-left: 0;
}

.tonk-hand__card--dimmed {
  opacity: 0.42;
}

/* GameCard renders its single root element, so this modifier lands directly on
   the .card element. Override the gold selected lift with a red error lift. */
.tonk-hand__card--badselect {
  transform: translateY(var(--card-selected-lift));
  border-color: #e05555 !important;
  box-shadow:
    0 8px 24px rgba(224, 85, 85, 0.5),
    3px 6px 16px var(--card-shadow) !important;
}

@media (max-width: 767px) {
  .tonk-hand {
    width: 100%;
    padding: 20px 12px 4px;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-x;
    scrollbar-width: none;
  }

  .tonk-hand::-webkit-scrollbar {
    display: none;
  }
}
</style>
