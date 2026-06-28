<template>
  <div v-if="currentTrick.length > 0" class="trick-pile">
    <button
      type="button"
      class="trick-pile__stack"
      :aria-label="`Show current trick (${badgeCount} ${badgeCount === 1 ? 'play' : 'plays'})`"
      data-testid="trick-pile-toggle"
      @click="toggle"
    >
      <span
        v-for="(entry, i) in stackLayers"
        :key="`layer-${i}`"
        class="trick-pile__layer"
        :style="layerStyle(i)"
      >
        <GameCard :card="topCardOf(entry)" size="small" />
      </span>
      <span class="trick-pile__badge" data-testid="trick-pile-badge">{{
        badgeCount
      }}</span>
    </button>

    <Teleport to="body">
      <div
        v-if="expanded"
        class="trick-overlay"
        data-testid="trick-overlay"
        @click="collapse"
      >
        <div class="trick-overlay__panel" @click.stop>
          <div class="trick-overlay__header">
            <span>This Trick</span>
            <button
              type="button"
              class="trick-overlay__close"
              aria-label="Close trick view"
              @click="collapse"
            >
              &times;
            </button>
          </div>
          <div class="trick-overlay__entries">
            <div
              v-for="(entry, i) in currentTrick"
              :key="`entry-${i}`"
              class="trick-entry"
              :class="`trick-entry--${entry.action}`"
            >
              <span class="trick-entry__name">{{ entry.displayName }}</span>
              <template v-if="entry.action === 'pass'">
                <span class="trick-entry__pass">passed</span>
              </template>
              <template v-else>
                <span v-if="entry.handType" class="trick-entry__hand-type">{{
                  HAND_TYPE_LABELS[entry.handType] ?? entry.handType
                }}</span>
                <span class="trick-entry__cards">
                  <GameCard
                    v-for="card in entry.cards"
                    :key="`${card.rank}-${card.suit}`"
                    :card="card"
                    size="medium"
                  />
                </span>
              </template>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script lang="ts" setup>
import { computed, ref, watch, onUnmounted } from "vue";
import type { Big2HistoryEntry } from "@shared/big2-types";
import type { Card } from "@shared/engine-types";
import GameCard from "./GameCard.vue";

const HAND_TYPE_LABELS: Record<string, string> = {
  single: "Single",
  pair: "Pair",
  straight: "Straight",
  fullHouse: "Full House",
  fourOfAKind: "Four of a Kind",
  straightFlush: "Straight Flush",
};

// Max layered cards shown in the collapsed stack; deeper plays stack under.
const MAX_LAYERS = 4;

const props = defineProps<{
  playHistory: readonly Big2HistoryEntry[];
  trickStartIndex: number;
}>();

const currentTrick = computed<readonly Big2HistoryEntry[]>(() =>
  props.playHistory.slice(props.trickStartIndex),
);

const playEntries = computed<Big2HistoryEntry[]>(() =>
  currentTrick.value.filter((e) => e.action === "play"),
);

const badgeCount = computed<number>(() => playEntries.value.length);

// Collapsed stack: only plays are cards. Top of the pile = most recent play.
// We render up to MAX_LAYERS, ordered so the last (most recent) sits on top.
const stackLayers = computed<Big2HistoryEntry[]>(() => {
  const plays = playEntries.value;
  return plays.slice(Math.max(0, plays.length - MAX_LAYERS));
});

function topCardOf(entry: Big2HistoryEntry): Card {
  return entry.cards![0]!;
}

function layerStyle(i: number): Record<string, string> {
  const offset = i * 6;
  return {
    left: `${offset}px`,
    top: `${offset}px`,
    zIndex: String(i + 1),
  };
}

const expanded = ref(false);

function toggle(): void {
  expanded.value = !expanded.value;
}

function collapse(): void {
  expanded.value = false;
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") collapse();
}

watch(expanded, (open) => {
  if (open) {
    document.addEventListener("keydown", onKeydown);
  } else {
    document.removeEventListener("keydown", onKeydown);
  }
});

// Force-collapse when the trick resets (current trick becomes empty).
watch(
  () => currentTrick.value.length,
  (len) => {
    if (len === 0) collapse();
  },
);

onUnmounted(() => {
  document.removeEventListener("keydown", onKeydown);
});
</script>

<style scoped>
@import "@/styles/game-variables.css";

.trick-pile {
  display: flex;
  align-items: flex-start;
}

.trick-pile__stack {
  position: relative;
  width: calc(28px + 18px);
  height: calc(40px + 18px);
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  /* min tap target */
  min-width: 44px;
  min-height: 44px;
}

.trick-pile__layer {
  position: absolute;
  display: block;
}

.trick-pile__badge {
  position: absolute;
  top: -8px;
  right: -8px;
  z-index: 10;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 9px;
  background: var(--gold-accent);
  color: #1a0f06;
  font-family: var(--font-ui);
  font-size: 0.65rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 1px 4px var(--card-shadow);
}

.trick-overlay {
  position: fixed;
  inset: 0;
  z-index: 400;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  padding: 16px;
}

.trick-overlay__panel {
  width: min(420px, 100%);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--panel-bg);
  border: 1.5px solid var(--table-rim-light);
  border-radius: 12px;
  overflow: hidden;
}

.trick-overlay__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  font-family: var(--font-ui);
  font-size: 0.8rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--gold-accent);
  border-bottom: 1px solid var(--table-rim-light);
}

.trick-overlay__close {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 1.4rem;
  cursor: pointer;
  min-width: 44px;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.trick-overlay__entries {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.trick-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-family: var(--font-ui);
  font-size: 0.8rem;
  color: var(--text-muted);
}

.trick-entry__name {
  font-weight: 600;
  color: var(--text-primary);
}

.trick-entry__hand-type {
  color: var(--gold-accent);
  font-weight: 500;
}

.trick-entry__cards {
  display: flex;
  gap: 4px;
}

.trick-entry--pass {
  opacity: 0.7;
}

.trick-entry__pass {
  font-style: italic;
}

@media (max-width: 767px) {
  .trick-pile__stack {
    transform: scale(0.85);
    transform-origin: top left;
  }

  .trick-overlay__panel {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .trick-overlay {
    backdrop-filter: none;
  }
}
</style>
