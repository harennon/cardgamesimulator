<template>
  <div
    v-if="turnDeadline !== null"
    class="opponent-timer"
    :class="`opponent-timer--${urgency}`"
    data-testid="opponent-timer"
  >
    <svg class="opponent-timer__ring" viewBox="0 0 24 24" aria-hidden="true">
      <circle
        class="opponent-timer__ring-track"
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke-width="2.5"
      />
      <circle
        class="opponent-timer__ring-fill"
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke-width="2.5"
        :stroke-dasharray="CIRCUMFERENCE"
        :stroke-dashoffset="ringOffset"
        stroke-linecap="round"
        transform="rotate(-90 12 12)"
      />
    </svg>
    <span class="opponent-timer__seconds">{{ remainingSeconds }}</span>
  </div>
</template>

<script lang="ts" setup>
import { computed, toRef } from "vue";
import { useTurnCountdown } from "@/composables/useTurnCountdown";

const CIRCUMFERENCE = 2 * Math.PI * 9; // ≈ 56.5

const props = defineProps<{
  turnDeadline: number | null;
  isActive: boolean;
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

.opponent-timer {
  display: flex;
  align-items: center;
  gap: 3px;
  position: relative;
}

.opponent-timer__ring {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
}

.opponent-timer__ring-track {
  stroke: rgba(138, 126, 110, 0.2);
}

.opponent-timer__ring-fill {
  stroke: var(--gold-accent);
  transition:
    stroke-dashoffset 0.9s linear,
    stroke 0.3s ease;
}

.opponent-timer--warning .opponent-timer__ring-fill {
  stroke: #e09a30;
}

.opponent-timer--critical .opponent-timer__ring-fill {
  stroke: #e05555;
}

.opponent-timer__seconds {
  font-family: var(--font-ui);
  font-size: 0.65rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  line-height: 1;
  min-width: 14px;
}

.opponent-timer--critical .opponent-timer__seconds {
  color: #e05555;
}

@media (prefers-reduced-motion: reduce) {
  .opponent-timer__ring-fill {
    transition: none;
  }
}
</style>
