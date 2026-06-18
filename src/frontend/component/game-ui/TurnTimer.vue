<template>
  <div
    class="turn-timer"
    :class="`turn-timer--${urgency}`"
    data-testid="turn-timer"
  >
    <div v-if="turnDeadline !== null" class="turn-timer__ring-wrap">
      <svg class="turn-timer__ring" viewBox="0 0 44 44" aria-hidden="true">
        <circle
          class="turn-timer__ring-track"
          cx="22"
          cy="22"
          r="18"
          fill="none"
          stroke-width="4"
        />
        <circle
          class="turn-timer__ring-fill"
          cx="22"
          cy="22"
          r="18"
          fill="none"
          stroke-width="4"
          :stroke-dasharray="CIRCUMFERENCE"
          :stroke-dashoffset="ringOffset"
          stroke-linecap="round"
          transform="rotate(-90 22 22)"
        />
      </svg>
      <span
        class="turn-timer__seconds"
        :style="{ fontVariantNumeric: 'tabular-nums' }"
      >
        {{ remainingSeconds }}
      </span>
    </div>

    <div
      class="turn-timer__label"
      :class="{ 'turn-timer__label--mine': isMyTurn }"
    >
      <span v-if="isMyTurn">Your turn</span>
      <span v-else>{{ currentPlayerName }}'s turn</span>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, toRef } from "vue";
import { useTurnCountdown } from "@/composables/useTurnCountdown";

const CIRCUMFERENCE = 2 * Math.PI * 18; // ≈ 113.1

const props = defineProps<{
  turnDeadline: number | null;
  isMyTurn: boolean;
  currentPlayerName: string;
  totalSeconds: number;
}>();

const deadlineRef = toRef(props, "turnDeadline");
const totalSecondsRef = toRef(props, "totalSeconds");

const { remainingSeconds, fraction, urgency } = useTurnCountdown(
  deadlineRef,
  totalSecondsRef,
);

const ringOffset = computed(() => CIRCUMFERENCE * (1 - fraction.value));
</script>

<style scoped>
@import "@/styles/game-variables.css";

.turn-timer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.turn-timer__ring-wrap {
  position: relative;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.turn-timer__ring {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.turn-timer__ring-track {
  stroke: rgba(138, 126, 110, 0.2);
}

.turn-timer__ring-fill {
  stroke: var(--gold-accent);
  transition:
    stroke-dashoffset 0.9s linear,
    stroke 0.3s ease;
}

.turn-timer--warning .turn-timer__ring-fill {
  stroke: #e09a30;
}

.turn-timer--critical .turn-timer__ring-fill {
  stroke: #e05555;
}

.turn-timer__seconds {
  position: relative;
  font-family: var(--font-ui);
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1;
}

.turn-timer--critical .turn-timer__seconds {
  color: #e05555;
}

.turn-timer__label {
  font-family: var(--font-ui);
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-muted);
  padding: 4px 16px;
  border-radius: 20px;
  background: var(--panel-bg);
  border: 1px solid rgba(138, 126, 110, 0.3);
  transition:
    color 0.2s ease,
    border-color 0.2s ease;
}

.turn-timer__label--mine {
  color: var(--gold-accent);
  border-color: var(--gold-accent);
  animation: glow 2s ease-in-out infinite;
}

@keyframes glow {
  0%,
  100% {
    box-shadow: 0 0 8px var(--gold-glow);
  }
  50% {
    box-shadow:
      0 0 20px var(--gold-glow),
      0 0 40px rgba(201, 168, 76, 0.1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .turn-timer__ring-fill {
    transition: none;
  }

  .turn-timer__label--mine {
    animation: none;
  }
}
</style>
