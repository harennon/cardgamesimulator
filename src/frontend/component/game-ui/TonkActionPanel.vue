<template>
  <div class="tonk-action-panel" data-testid="tonk-action-panel">
    <div
      v-if="actionError"
      class="tonk-action-panel__error"
      data-testid="tonk-action-error"
    >
      {{ actionError }}
    </div>

    <div
      v-if="isMyTurn"
      class="tonk-action-panel__stepper"
      data-testid="tonk-phase-stepper"
    >
      <span
        class="tonk-action-panel__step"
        :class="{
          'tonk-action-panel__step--active': turnPhase === 'discard',
          'tonk-action-panel__step--done': turnPhase === 'draw',
        }"
      >
        <span class="tonk-action-panel__step-num">
          <span class="tonk-action-panel__step-numlabel">1</span>
        </span>
        Discard
      </span>
      <span class="tonk-action-panel__arrow">&rarr;</span>
      <span
        class="tonk-action-panel__step"
        :class="{ 'tonk-action-panel__step--active': turnPhase === 'draw' }"
      >
        <span class="tonk-action-panel__step-num">2</span>
        Draw
      </span>
    </div>

    <div
      v-else
      class="tonk-action-panel__turn-pill"
      data-testid="tonk-turn-pill"
    >
      <span class="tonk-action-panel__dot"></span>
      {{ currentPlayerName }} is taking their turn&hellip;
    </div>

    <div class="tonk-action-panel__buttons">
      <template v-if="turnPhase === 'discard'">
        <button
          v-if="canCallTonk"
          class="tonk-action-panel__btn tonk-action-panel__btn--tonk"
          data-testid="tonk-call-tonk-btn"
          :disabled="!isMyTurn || actionPending || !!disabledReason"
          :title="disabledReason ?? undefined"
          :aria-disabled="!!disabledReason || undefined"
          @click="emit('callTonk')"
        >
          Call TONK
        </button>
        <button
          class="tonk-action-panel__btn tonk-action-panel__btn--primary"
          data-testid="tonk-discard-btn"
          :disabled="
            !isMyTurn ||
            selectionCount === 0 ||
            actionPending ||
            !!disabledReason
          "
          :title="disabledReason ?? undefined"
          :aria-disabled="!!disabledReason || undefined"
          @click="emit('discard')"
        >
          Discard<span
            v-if="selectionCount > 1"
            class="tonk-action-panel__count-badge"
            data-testid="tonk-discard-count"
            >{{ selectionCount }}</span
          >
        </button>
      </template>

      <template v-else>
        <button
          class="tonk-action-panel__btn tonk-action-panel__btn--primary tonk-action-panel__btn--source"
          data-testid="tonk-draw-stock-btn"
          :disabled="!isMyTurn || actionPending || !!disabledReason"
          :title="disabledReason ?? undefined"
          :aria-disabled="!!disabledReason || undefined"
          @click="emit('draw', 'stock')"
        >
          <span>Draw stock</span>
          <span class="tonk-action-panel__src-sub"
            >{{ stockCount }} face-down</span
          >
        </button>
        <button
          class="tonk-action-panel__btn tonk-action-panel__btn--ghost tonk-action-panel__btn--source"
          data-testid="tonk-take-discard-btn"
          :disabled="
            !isMyTurn ||
            drawableDiscard === null ||
            actionPending ||
            !!disabledReason
          "
          :title="disabledReason ?? undefined"
          :aria-disabled="!!disabledReason || undefined"
          @click="emit('draw', 'discard')"
        >
          <span>Take discard</span>
          <span
            v-if="drawableDiscard === null"
            class="tonk-action-panel__src-sub"
            >none available</span
          >
        </button>
      </template>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import type { ValidAction } from "@shared/engine-types";
import type {
  TonkCard,
  TonkDrawSource,
  TonkTurnPhase,
} from "@shared/tonk-types";

const props = defineProps<{
  validActions: readonly ValidAction[];
  turnPhase: TonkTurnPhase;
  isMyTurn: boolean;
  selectionCount: number;
  drawableDiscard: TonkCard | null;
  stockCount: number;
  currentPlayerName: string;
  actionError?: string | null;
  actionPending?: boolean;
  /** When non-null, all action buttons are disabled and show this as a hover title. */
  disabledReason?: string | null;
}>();

const emit = defineEmits<{
  discard: [];
  draw: [source: TonkDrawSource];
  callTonk: [];
}>();

// Visibility/enabled state derives ONLY from validActions + turnPhase — never
// from a client-side rule re-computation (LLD 99 §Approach A).
const canCallTonk = computed(() =>
  props.validActions.some((a) => a.type === "callTonk"),
);
</script>

<style scoped>
@import "@/styles/game-variables.css";

.tonk-action-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  height: 100%;
  padding: 12px 16px;
  background: var(--table-rim);
  border-top: 2px solid var(--table-rim-light);
}

.tonk-action-panel__error {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-ui);
  font-size: 0.8rem;
  color: var(--error-text);
  background: rgba(224, 85, 85, 0.1);
  border: 1px solid rgba(224, 85, 85, 0.35);
  border-radius: 6px;
  padding: 7px 11px;
  text-align: center;
}

.tonk-action-panel__error::before {
  content: "!";
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--error-text);
  color: #1a0f06;
  font-weight: 700;
  font-size: 0.72rem;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tonk-action-panel__stepper {
  display: flex;
  align-items: center;
  font-family: var(--font-ui);
  font-size: 0.74rem;
  font-weight: 600;
}

.tonk-action-panel__step {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--text-muted);
  padding: 3px 4px;
}

.tonk-action-panel__step-num {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1.5px solid var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.68rem;
  font-family: monospace;
}

.tonk-action-panel__step--active {
  color: var(--gold-accent);
}

.tonk-action-panel__step--active .tonk-action-panel__step-num {
  border-color: var(--gold-accent);
  background: var(--gold-accent);
  color: #1a0f06;
}

.tonk-action-panel__step--done {
  color: var(--text-primary);
}

.tonk-action-panel__step--done .tonk-action-panel__step-num {
  border-color: var(--text-primary);
  background: transparent;
  color: var(--text-primary);
}

.tonk-action-panel__step--done .tonk-action-panel__step-num::after {
  content: "✓";
}

.tonk-action-panel__step--done .tonk-action-panel__step-numlabel {
  display: none;
}

.tonk-action-panel__arrow {
  color: var(--text-muted);
  margin: 0 8px;
  font-size: 0.9rem;
}

.tonk-action-panel__turn-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-ui);
  font-size: 0.74rem;
  font-weight: 600;
  padding: 5px 12px;
  border-radius: 20px;
  background: rgba(0, 0, 0, 0.3);
  color: var(--text-muted);
}

.tonk-action-panel__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

.tonk-action-panel__buttons {
  display: flex;
  gap: 12px;
  justify-content: center;
  flex-wrap: wrap;
}

.tonk-action-panel__btn {
  font-family: var(--font-ui);
  font-size: 0.92rem;
  font-weight: 600;
  padding: 11px 26px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  transition: all 0.15s ease;
  min-height: 44px;
}

.tonk-action-panel__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.tonk-action-panel__btn--primary {
  background: var(--gold-accent);
  color: #1a0f06;
}

.tonk-action-panel__btn--primary:not(:disabled):hover {
  background: #d4b45a;
  box-shadow: 0 4px 16px var(--gold-glow);
}

.tonk-action-panel__btn--ghost {
  background: transparent;
  color: var(--text-primary);
  border: 1.5px solid var(--text-muted);
}

.tonk-action-panel__btn--ghost:not(:disabled):hover {
  border-color: var(--text-primary);
  background: rgba(232, 220, 200, 0.08);
}

/* Call TONK is the quiet/secondary control — never the visual primary, so it is
   never the accidental default action (LLD 99 §Frontend Design). */
.tonk-action-panel__btn--tonk {
  background: transparent;
  color: #b8324a;
  border: 1.5px solid #b8324a;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.tonk-action-panel__btn--tonk:not(:disabled):hover {
  background: #b8324a;
  color: #fff;
  box-shadow: 0 4px 18px rgba(184, 50, 74, 0.45);
}

.tonk-action-panel__count-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  margin-left: 8px;
  border-radius: 9px;
  background: rgba(0, 0, 0, 0.25);
  font-size: 0.74rem;
  font-family: monospace;
}

.tonk-action-panel__btn--source {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px 22px;
  min-width: 120px;
}

.tonk-action-panel__src-sub {
  font-size: 0.68rem;
  font-weight: 400;
  opacity: 0.8;
}

@media (max-width: 767px) {
  .tonk-action-panel {
    height: var(--mobile-actions-height);
    gap: 8px;
    padding: 8px 12px;
  }
}
</style>
