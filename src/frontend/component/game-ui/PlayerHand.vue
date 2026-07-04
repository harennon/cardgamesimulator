<template>
  <div class="player-hand" :class="{ dealing }">
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
      :style="{ '--i': index }"
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
  dealing?: boolean;
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
  justify-content: flex-start;
  margin-inline: auto;
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

@media (hover: hover) {
  .player-hand__card--interactive:hover {
    transform: translateY(var(--card-hover-lift));
  }

  .player-hand__card--interactive.player-hand__card:global(
      .card--selected
    ):hover {
    transform: translateY(var(--card-selected-hover-lift));
  }
}

/* Deal-in animation (variant A: slide-up). The .dealing class is set by the
   parent board for one animation window at round start, then cleared. */
.player-hand.dealing .player-hand__card {
  transform-origin: bottom center;
  animation: dealSlide var(--deal-duration) var(--deal-easing) both;
  animation-delay: calc(var(--i) * var(--deal-stagger));
}

@keyframes dealSlide {
  from {
    opacity: 0;
    transform: translateY(46px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .player-hand.dealing .player-hand__card {
    animation: none;
  }
}

@media (max-width: 767px) {
  .player-hand {
    width: 100%;
    margin-inline: 0;
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
