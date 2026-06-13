<template>
  <div class="game-log">
    <div class="game-log__header">Game Log</div>
    <div ref="scrollEl" class="game-log__entries">
      <div
        v-for="(entry, i) in entries"
        :key="i"
        class="log-entry"
        :class="`log-entry--${entry.action}`"
      >
        <span class="log-entry__name">{{ entry.displayName }}</span>
        <span v-if="entry.action === 'pass'" class="log-entry__action"
          >passed</span
        >
        <span v-else class="log-entry__action">
          played
          <span v-if="entry.handType" class="log-entry__hand-type">{{
            HAND_TYPE_LABELS[entry.handType] ?? entry.handType
          }}</span>
          <span v-if="entry.cards" class="log-entry__cards">
            ({{
              entry.cards
                .map((c: Card) => `${c.rank}${SUIT_SYMBOLS[c.suit]}`)
                .join(" ")
            }})
          </span>
        </span>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, watch, nextTick } from "vue";
import type { Big2HistoryEntry } from "@shared/big2-types";
import type { Card } from "@shared/engine-types";

const props = defineProps<{
  entries: readonly Big2HistoryEntry[];
}>();

const scrollEl = ref<HTMLElement | null>(null);

const SUIT_SYMBOLS: Record<string, string> = {
  clubs: "♣",
  diamonds: "♦",
  hearts: "♥",
  spades: "♠",
};

const HAND_TYPE_LABELS: Record<string, string> = {
  single: "Single",
  pair: "Pair",
  straight: "Straight",
  fullHouse: "Full House",
  fourOfAKind: "Four of a Kind",
  straightFlush: "Straight Flush",
};

// Auto-scroll to bottom when mounted (ref becomes non-null)
watch(
  () => scrollEl.value,
  (el) => {
    if (el) el.scrollTop = el.scrollHeight;
  },
);
watch(
  () => props.entries.length,
  async () => {
    await nextTick();
    if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
  },
);
</script>

<style scoped>
@import "@/styles/game-variables.css";

.game-log {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--panel-bg);
  border-left: 2px solid var(--table-rim-light);
  overflow: hidden;
}

.game-log__header {
  font-family: var(--font-ui);
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--gold-accent);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--table-rim-light);
  flex-shrink: 0;
}

.game-log__entries {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.game-log__entries::-webkit-scrollbar {
  width: 4px;
}

.game-log__entries::-webkit-scrollbar-track {
  background: transparent;
}

.game-log__entries::-webkit-scrollbar-thumb {
  background: var(--table-rim-light);
  border-radius: 2px;
}

.log-entry {
  font-family: var(--font-ui);
  font-size: 0.75rem;
  color: var(--text-muted);
  line-height: 1.4;
}

.log-entry__name {
  font-weight: 600;
  color: var(--text-primary);
  margin-right: 4px;
}

.log-entry__action {
  margin-right: 4px;
}

.log-entry__hand-type {
  color: var(--gold-accent);
  font-weight: 500;
  margin-right: 4px;
}

.log-entry__cards {
  color: var(--text-muted);
  font-size: 0.7rem;
}

.log-entry--pass {
  opacity: 0.7;
}
</style>
