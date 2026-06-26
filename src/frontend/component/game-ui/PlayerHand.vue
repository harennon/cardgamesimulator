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
      @click="onCardClick(index)"
      @touchstart="onCardTouch(index)"
    />
  </div>
</template>

<script lang="ts" setup>
import type { Card } from "@shared/engine-types";
import GameCard from "./GameCard.vue";

const props = defineProps<{
  cards: readonly Card[];
  selectedIndices: Set<number>;
  interactive: boolean;
}>();

const emit = defineEmits<{
  "toggle-card": [index: number];
}>();

function debugPush(type: "touch" | "state" | "info", msg: string) {
  const fn = (window as unknown as Record<string, unknown>).__devOverlayPush;
  if (typeof fn === "function")
    (fn as (t: string, m: string) => void)(type, msg);
}

function onCardClick(index: number) {
  if (!props.interactive) return;
  debugPush("touch", `click[${index}]`);
  emit("toggle-card", index);
}

function onCardTouch(index: number) {
  debugPush("touch", `touchstart[${index}]`);
}
</script>

<style scoped>
@import "@/styles/game-variables.css";

.player-hand {
  display: flex;
  align-items: flex-end;
  padding: 24px 16px 8px;
  overflow-x: auto;
}

.player-hand__card {
  margin-left: var(--card-overlap);
  cursor: default;
}

.player-hand__card--first {
  margin-left: 0;
}

.player-hand__card--interactive {
  cursor: pointer;
}

.player-hand__card--interactive:hover {
  transform: translateY(var(--card-hover-lift));
}

.player-hand__card--interactive.player-hand__card:global(
    .card--selected
  ):hover {
  transform: translateY(var(--card-selected-hover-lift));
}

@media (max-width: 767px) {
  .player-hand {
    width: 100%;
    padding: 20px 12px 4px;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-x;
    scrollbar-width: none;
  }

  .player-hand::-webkit-scrollbar {
    display: none;
  }
}
</style>
