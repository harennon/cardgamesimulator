<template>
  <div class="tonk-hand" data-testid="tonk-hand">
    <GameCard
      v-for="(card, index) in cards"
      :key="isJoker(card) ? `joker-${card.id}` : `${card.rank}-${card.suit}`"
      :card="card"
      :interactive="false"
      size="large"
      class="tonk-hand__card"
      :class="{ 'tonk-hand__card--first': index === 0 }"
    />
  </div>
</template>

<script lang="ts" setup>
import type { TonkCard } from "@shared/tonk-types";
import { isJoker } from "@shared/tonk-types";
import GameCard from "./GameCard.vue";

defineProps<{
  cards: readonly TonkCard[];
}>();
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
}

.tonk-hand__card--first {
  margin-left: 0;
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
