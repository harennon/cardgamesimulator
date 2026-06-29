<template>
  <div class="tonk-tally-panel" data-testid="tonk-tally-panel">
    <div class="tonk-tally-panel__header">Tallies — lower wins</div>
    <div class="tonk-tally-panel__trick" data-testid="tonk-tally-trick">
      {{ trickText }}
    </div>
    <div class="tonk-tally-panel__rows">
      <div
        v-for="(row, rank) in rows"
        :key="row.seatIndex"
        class="tonk-tally-row"
        :class="{ 'tonk-tally-row--near': isNear(row.tally) }"
        data-testid="tonk-tally-row"
      >
        <span class="tonk-tally-row__rank">{{ rank + 1 }}</span>
        <span class="tonk-tally-row__name">{{ nameFor(row.seatIndex) }}</span>
        <span class="tonk-tally-row__score">{{ row.tally }}</span>
        <div class="tonk-tally-row__bar">
          <div
            class="tonk-tally-row__bar-fill"
            :style="{ width: `${progress(row.tally) * 100}%` }"
            data-testid="tonk-tally-bar"
          ></div>
        </div>
      </div>
    </div>
    <div class="tonk-tally-panel__footer">
      Game ends when anyone reaches 150
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import type { PlayerPublicInfo } from "@shared/engine-types";
import {
  isNearLine,
  lossLineProgress,
  rankedTallies,
  trickLabel,
} from "./tonkDisplay";

const props = defineProps<{
  players: readonly PlayerPublicInfo[];
  tallies: readonly number[];
  trickNumber: number;
}>();

const rows = computed(() => rankedTallies(props.tallies));
const trickText = computed(() => trickLabel(props.trickNumber));

function nameFor(seatIndex: number): string {
  return props.players[seatIndex]?.displayName ?? "";
}
function progress(tally: number): number {
  return lossLineProgress(tally);
}
function isNear(tally: number): boolean {
  return isNearLine(tally);
}
</script>

<style scoped>
@import "@/styles/game-variables.css";

.tonk-tally-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--panel-bg);
  border-left: 2px solid var(--table-rim-light);
  overflow: hidden;
}

.tonk-tally-panel__header {
  font-family: var(--font-ui);
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--gold-accent);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  padding: 10px 12px 4px;
}

.tonk-tally-panel__trick {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--text-muted);
  padding: 0 12px 8px;
  border-bottom: 1px solid var(--table-rim-light);
}

.tonk-tally-panel__rows {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tonk-tally-row {
  display: grid;
  grid-template-columns: 18px 1fr auto;
  grid-template-areas:
    "rank name score"
    "bar  bar  bar";
  align-items: center;
  gap: 2px 6px;
  font-family: var(--font-ui);
  font-size: 0.78rem;
  color: var(--text-primary);
}

.tonk-tally-row__rank {
  grid-area: rank;
  color: var(--text-muted);
  font-size: 0.7rem;
}

.tonk-tally-row__name {
  grid-area: name;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tonk-tally-row__score {
  grid-area: score;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.tonk-tally-row__bar {
  grid-area: bar;
  height: 4px;
  border-radius: 2px;
  background: rgba(0, 0, 0, 0.35);
  overflow: hidden;
}

.tonk-tally-row__bar-fill {
  height: 100%;
  background: var(--gold-accent);
  transition: width 0.3s ease;
}

.tonk-tally-row--near .tonk-tally-row__bar-fill {
  background: var(--tonk-near-150);
}

.tonk-tally-row--near .tonk-tally-row__score {
  color: var(--tonk-near-150);
}

.tonk-tally-panel__footer {
  font-family: var(--font-ui);
  font-size: 0.65rem;
  color: var(--text-muted);
  padding: 6px 12px 10px;
  border-top: 1px solid var(--table-rim-light);
}

@media (prefers-reduced-motion: reduce) {
  .tonk-tally-row__bar-fill {
    transition: none;
  }
}
</style>
