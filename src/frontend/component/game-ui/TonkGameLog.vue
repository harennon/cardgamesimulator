<template>
  <div class="game-log">
    <div class="game-log__header">Game Log</div>
    <div ref="scrollEl" class="game-log__entries">
      <template v-for="(entry, i) in entries" :key="i">
        <div class="log-entry" :class="`log-entry--${entry.type}`">
          <span class="log-entry__name">{{ entry.displayName }}</span>

          <template v-if="entry.type === 'discard'">
            <span class="log-entry__action"
              >discarded
              {{
                entry.discardCount ?? entry.discarded?.length ?? 0
              }}&times;</span
            >
            <span v-if="entry.discarded?.length" class="log-entry__cards">
              <TonkCardView
                v-for="(card, c) in entry.discarded"
                :key="c"
                :card="card"
                size="small"
              />
            </span>
          </template>

          <span v-else-if="entry.type === 'draw'" class="log-entry__action">
            drew from {{ entry.drawSource }}
          </span>

          <span v-else-if="entry.type === 'callTonk'" class="log-entry__action">
            called TONK
          </span>
        </div>

        <div v-if="entry.trickResult" class="trick-result">
          <div class="trick-result__head">
            Trick {{ entry.trickResult.trickNumber }} —
            {{
              entry.trickResult.reason === "tonk" ? "TONK called" : "stock out"
            }}
          </div>
          <div
            v-for="(value, seat) in entry.trickResult.handValues"
            :key="seat"
            class="trick-result__seat"
          >
            <span class="trick-result__seat-name">{{
              seatName(seat as number)
            }}</span>
            <span class="trick-result__seat-value">{{ value }}</span>
            <span class="trick-result__seat-delta"
              >+{{ entry.trickResult.tallyDeltas[seat] ?? 0 }}</span
            >
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, watch, nextTick } from "vue";
import type { TonkLogEntry } from "@shared/tonk-types";
import TonkCardView from "./TonkCardView.vue";

const props = defineProps<{
  entries: readonly TonkLogEntry[];
  seatNames?: readonly string[];
}>();

const scrollEl = ref<HTMLElement | null>(null);

function seatName(seat: number): string {
  return props.seatNames?.[seat] ?? `Seat ${seat + 1}`;
}

// Auto-scroll to bottom — mirrors GameLog.vue.
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
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}

.log-entry__name {
  font-weight: 600;
  color: var(--text-primary);
}

.log-entry--callTonk .log-entry__action {
  color: var(--gold-accent);
  font-weight: 600;
}

.log-entry__cards {
  display: inline-flex;
  gap: 2px;
}

.trick-result {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  color: var(--text-muted);
  background: rgba(201, 168, 76, 0.08);
  border: 1px solid var(--table-rim-light);
  border-radius: 6px;
  padding: 6px 8px;
  margin: 2px 0;
}

.trick-result__head {
  color: var(--gold-accent);
  font-weight: 700;
  margin-bottom: 3px;
}

.trick-result__seat {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.trick-result__seat-name {
  color: var(--text-primary);
  flex: 1;
}

.trick-result__seat-delta {
  color: var(--text-muted);
}
</style>
