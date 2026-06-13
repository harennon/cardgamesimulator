<template>
  <div class="player-hand">
    <GameCard
      v-for="(card, index) in cards"
      :key="`${card.rank}-${card.suit}`"
      :card="card"
      :selected="selectedIndices.has(index)"
      :interactive="interactive"
      size="large"
      class="player-hand__card"
      :class="{
        'player-hand__card--first': index === 0,
        'player-hand__card--interactive': interactive,
      }"
      @click="interactive && emit('toggle-card', index)"
    />
  </div>
</template>

<script lang="ts" setup>
import type { Card } from "@shared/engine-types";
import GameCard from "./GameCard.vue";

defineProps<{
  cards: readonly Card[];
  selectedIndices: Set<number>;
  interactive: boolean;
}>();

const emit = defineEmits<{
  "toggle-card": [index: number];
}>();
</script>

<style scoped>
@import "@/styles/game-variables.css";

.player-hand {
  display: flex;
  align-items: flex-end;
  padding: 8px 16px;
  overflow-x: auto;
}

.player-hand__card {
  margin-left: -20px;
  cursor: default;
}

.player-hand__card--first {
  margin-left: 0;
}

.player-hand__card--interactive {
  cursor: pointer;
}

.player-hand__card--interactive:hover {
  transform: translateY(-8px);
}

.player-hand__card--interactive.player-hand__card:global(
    .card--selected
  ):hover {
  transform: translateY(-24px);
}
</style>
