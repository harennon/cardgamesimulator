<template>
  <div class="tonk-log" data-testid="tonk-log">
    <div class="tonk-log__header">Game Log</div>
    <div ref="scrollEl" class="tonk-log__entries">
      <template v-for="(entry, i) in entries" :key="i">
        <div class="tonk-log-entry" :class="`tonk-log-entry--${entry.type}`">
          <span class="tonk-log-entry__name">{{ entry.displayName }}</span>
          <span class="tonk-log-entry__action">{{ actionText(entry) }}</span>
        </div>
        <div
          v-if="entry.trickResult"
          class="tonk-log-entry tonk-log-entry--result"
          data-testid="tonk-log-trick-result"
        >
          {{ trickSummary(entry) }}
        </div>
      </template>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, watch, nextTick } from "vue";
import type { PlayerPublicInfo } from "@shared/engine-types";
import type { TonkLogEntry } from "@shared/tonk-types";
import { logActionText, trickResultSummary } from "./tonkDisplay";

const props = defineProps<{
  entries: readonly TonkLogEntry[];
  players: readonly PlayerPublicInfo[];
}>();

const scrollEl = ref<HTMLElement | null>(null);

function actionText(entry: TonkLogEntry): string {
  return logActionText(entry);
}
function trickSummary(entry: TonkLogEntry): string {
  return trickResultSummary(entry, props.players) ?? "";
}

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

.tonk-log {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--panel-bg);
  border-left: 2px solid var(--table-rim-light);
  overflow: hidden;
}

.tonk-log__header {
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

.tonk-log__entries {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tonk-log__entries::-webkit-scrollbar {
  width: 4px;
}

.tonk-log__entries::-webkit-scrollbar-track {
  background: transparent;
}

.tonk-log__entries::-webkit-scrollbar-thumb {
  background: var(--table-rim-light);
  border-radius: 2px;
}

.tonk-log-entry {
  font-family: var(--font-ui);
  font-size: 0.75rem;
  color: var(--text-muted);
  line-height: 1.4;
}

.tonk-log-entry__name {
  font-weight: 600;
  color: var(--text-primary);
  margin-right: 4px;
}

.tonk-log-entry--callTonk .tonk-log-entry__action {
  color: var(--gold-accent);
  font-weight: 600;
}

.tonk-log-entry--result {
  color: var(--gold-accent);
  font-size: 0.7rem;
  font-style: italic;
  padding: 2px 0 4px;
  border-bottom: 1px solid var(--table-rim-light);
}
</style>
