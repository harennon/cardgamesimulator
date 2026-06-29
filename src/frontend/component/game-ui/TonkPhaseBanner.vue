<template>
  <div class="tonk-phase-banner" data-testid="tonk-phase-banner">
    <span class="tonk-phase-banner__turn">{{ turnText }}</span>
    <span
      class="tonk-phase-banner__chip"
      :class="phaseClassName"
      data-testid="tonk-phase-chip"
      >{{ phaseText }}</span
    >
    <span class="tonk-phase-banner__trick" data-testid="tonk-trick-number">{{
      trickText
    }}</span>
  </div>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import type { TonkTurnPhase } from "@shared/tonk-types";
import { phaseClass, phaseLabel, trickLabel, turnLabel } from "./tonkDisplay";

const props = defineProps<{
  turnPhase: TonkTurnPhase;
  trickNumber: number;
  currentPlayerName: string;
  isMyTurn: boolean;
}>();

const turnText = computed(() =>
  turnLabel(props.currentPlayerName, props.isMyTurn),
);
const phaseText = computed(() => phaseLabel(props.turnPhase));
const phaseClassName = computed(() => phaseClass(props.turnPhase));
const trickText = computed(() => trickLabel(props.trickNumber));
</script>

<style scoped>
@import "@/styles/game-variables.css";

.tonk-phase-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 8px 16px;
  font-family: var(--font-ui);
}

.tonk-phase-banner__turn {
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--text-primary);
}

.tonk-phase-banner__chip {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 3px 10px;
  border-radius: 10px;
  color: #1a0f06;
}

.tonk-phase--discard {
  background: var(--tonk-phase-discard);
}

.tonk-phase--draw {
  background: var(--tonk-phase-draw);
}

.tonk-phase-banner__trick {
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--gold-accent);
}

@media (max-width: 767px) {
  .tonk-phase-banner {
    gap: 8px;
    padding: 6px 10px;
  }

  .tonk-phase-banner__turn {
    font-size: 0.85rem;
  }
}
</style>
