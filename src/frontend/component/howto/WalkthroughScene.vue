<script setup lang="ts">
import { computed } from "vue";
import GameCard from "@/component/game-ui/GameCard.vue";
import type { WalkthroughScene } from "./walkthroughTypes";

// A pure presentational mapper: a static WalkthroughScene descriptor -> real
// components (GameCard rows / a callout). It receives ONLY the static scene
// value — never live game state (LLD 111 decision 7).
const props = defineProps<{
  scene: WalkthroughScene;
}>();

const selectedSet = computed(
  () =>
    new Set(
      props.scene.kind === "cards" ? (props.scene.selectedIndices ?? []) : [],
    ),
);

const highlightSet = computed(
  () =>
    new Set(
      props.scene.kind === "cards" ? (props.scene.highlightIndices ?? []) : [],
    ),
);
</script>

<template>
  <div class="wt-scene" data-testid="howto-scene">
    <div v-if="scene.kind === 'cards'" class="wt-scene__cards">
      <span
        v-for="(c, i) in scene.cards"
        :key="i"
        class="wt-scene__card"
        :class="{ 'wt-scene__card--highlight': highlightSet.has(i) }"
      >
        <GameCard :card="c" size="small" :selected="selectedSet.has(i)" />
      </span>
    </div>

    <div v-else class="wt-scene__callout">
      <div class="wt-scene__callout-icon" aria-hidden="true">
        {{ scene.icon }}
      </div>
      <div
        v-for="(line, i) in scene.lines"
        :key="i"
        class="wt-scene__callout-line"
      >
        {{ line }}
      </div>
    </div>
  </div>
</template>

<style scoped>
@import "@/styles/game-variables.css";

.wt-scene {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.wt-scene__cards {
  display: flex;
  gap: 6px;
  justify-content: center;
  flex-wrap: wrap;
  /* Room for lifted (selected) cards so they are not clipped. */
  padding-top: 16px;
}

.wt-scene__card {
  display: inline-flex;
  border-radius: 6px;
}

/* Dashed outline on the "lowest card" (mockup .mcard.lo). */
.wt-scene__card--highlight {
  outline: 2px dashed var(--gold-accent);
  outline-offset: 2px;
}

.wt-scene__callout {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  text-align: center;
}

.wt-scene__callout-icon {
  font-size: 2rem;
  line-height: 1;
  filter: drop-shadow(0 0 12px var(--gold-glow));
}

.wt-scene__callout-line {
  font-family: var(--font-ui);
  font-size: 0.85rem;
  color: var(--text-primary);
}
</style>
