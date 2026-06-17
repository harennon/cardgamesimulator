<template>
  <div class="action-panel">
    <div v-if="actionError" class="action-panel__error">{{ actionError }}</div>
    <div class="action-panel__buttons">
      <button
        v-if="canPass"
        class="action-panel__btn action-panel__btn--pass"
        :disabled="!isMyTurn || actionPending"
        @click="emit('pass')"
      >
        Pass
      </button>
      <button
        v-if="canPlay"
        class="action-panel__btn action-panel__btn--play"
        :disabled="!isMyTurn || selectedCardCount === 0 || actionPending"
        @click="emit('play')"
      >
        Play
      </button>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import type { ValidAction } from "@shared/engine-types";

const props = defineProps<{
  validActions: readonly ValidAction[];
  selectedCardCount: number;
  isMyTurn: boolean;
  actionError?: string | null;
  actionPending?: boolean;
}>();

const emit = defineEmits<{
  play: [];
  pass: [];
}>();

const canPlay = computed(() =>
  props.validActions.some((a) => a.type === "playCards"),
);
const canPass = computed(() =>
  props.validActions.some((a) => a.type === "pass"),
);
</script>

<style scoped>
@import "@/styles/game-variables.css";

.action-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  padding: 0 16px;
  background: var(--table-rim);
  border-top: 2px solid var(--table-rim-light);
}

.action-panel__error {
  font-family: var(--font-ui);
  font-size: 0.8rem;
  color: #e05555;
  text-align: center;
}

.action-panel__buttons {
  display: flex;
  gap: 12px;
}

.action-panel__btn {
  font-family: var(--font-ui);
  font-size: 0.95rem;
  font-weight: 600;
  padding: 10px 28px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  transition:
    background 0.15s ease,
    opacity 0.15s ease,
    box-shadow 0.15s ease;
}

.action-panel__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.action-panel__btn--play {
  background: var(--gold-accent);
  color: #1a0f06;
}

.action-panel__btn--play:not(:disabled):hover {
  background: #d4b45a;
  box-shadow: 0 4px 16px var(--gold-glow);
}

.action-panel__btn--pass {
  background: transparent;
  color: var(--text-primary);
  border: 1.5px solid var(--text-muted);
}

.action-panel__btn--pass:not(:disabled):hover {
  border-color: var(--text-primary);
  background: rgba(232, 220, 200, 0.08);
}

@media (max-width: 767px) {
  .action-panel {
    height: var(--mobile-actions-height);
  }

  .action-panel__btn {
    padding: 10px 28px;
    font-size: 0.85rem;
  }
}
</style>
