<template>
  <div
    class="tonk-seat-rail"
    :class="{ 'tonk-seat-rail--wrap': wrap }"
    data-testid="tonk-seat-rail"
  >
    <div
      v-for="seat in seats"
      :key="seat.playerId"
      class="tonk-seat"
      :class="{ 'tonk-seat--active': isActive(seat.seatIndex) }"
      data-testid="tonk-seat"
    >
      <div v-if="!compact" class="tonk-seat__fan" data-testid="tonk-seat-fan">
        <div
          v-for="n in Math.min(seat.cardCount, 13)"
          :key="n"
          class="card card--small card-back"
        ></div>
      </div>

      <div class="tonk-seat__info">
        <span class="tonk-seat__name">{{ seat.displayName }}</span>
        <AiBadge v-if="seat.isAi" data-testid="ai-badge" />
        <div class="tonk-seat__meta">
          <span class="tonk-seat__count">{{ seat.cardCount }}</span>
          <span class="tonk-seat__tally" data-testid="tonk-seat-tally">{{
            seat.tally
          }}</span>
          <span
            v-if="isActive(seat.seatIndex)"
            class="tonk-seat__phase-tag"
            :class="phaseClassName"
            data-testid="tonk-seat-phase-tag"
            >{{ phaseTagText }}</span
          >
        </div>
        <span
          v-if="!seat.isConnected && !seat.isAi"
          class="tonk-seat__disconnected"
          >disconnected</span
        >
        <OpponentTimer
          v-if="isActive(seat.seatIndex)"
          :turn-deadline="turnDeadline"
          :is-active="true"
          :total-seconds="totalSeconds"
        />
      </div>

      <div
        v-if="isActive(seat.seatIndex)"
        class="tonk-seat__turn-indicator"
        data-testid="tonk-seat-pulse"
      ></div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import type { PlayerPublicInfo } from "@shared/engine-types";
import type { TonkTurnPhase } from "@shared/tonk-types";
import OpponentTimer from "./OpponentTimer.vue";
import AiBadge from "./AiBadge.vue";
import {
  isCompactRail,
  isWrappingRail,
  phaseClass,
  phaseTag,
  railSeats,
} from "./tonkDisplay";

const props = defineProps<{
  players: readonly PlayerPublicInfo[];
  tallies: readonly number[];
  currentPlayerIndex: number;
  myPlayerIndex: number;
  turnPhase: TonkTurnPhase;
  turnDeadline: number | null;
  totalSeconds: number;
}>();

const seats = computed(() =>
  railSeats(props.players, props.tallies, props.myPlayerIndex),
);
const compact = computed(() => isCompactRail(props.players.length));
const wrap = computed(() => isWrappingRail(props.players.length));
const phaseTagText = computed(() => phaseTag(props.turnPhase));
const phaseClassName = computed(() => phaseClass(props.turnPhase));

function isActive(seatIndex: number): boolean {
  return seatIndex === props.currentPlayerIndex;
}
</script>

<style scoped>
@import "@/styles/game-variables.css";

.tonk-seat-rail {
  display: flex;
  gap: 20px;
  align-items: center;
  justify-content: center;
  padding: 8px 16px;
  background: var(--table-rim);
  border-bottom: 2px solid var(--table-rim-light);
}

.tonk-seat-rail--wrap {
  flex-wrap: wrap;
  gap: 10px 16px;
}

.tonk-seat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 2px solid transparent;
  transition: border-color 0.2s ease;
  position: relative;
}

.tonk-seat--active {
  border-color: var(--gold-accent);
  background: rgba(201, 168, 76, 0.08);
}

.tonk-seat__fan {
  display: flex;
}

.tonk-seat__fan .card-back {
  width: 24px;
  height: 34px;
  margin-left: -10px;
  border-radius: 4px;
  border: 1px solid var(--gold-accent);
  background: linear-gradient(135deg, #8b1a1a 0%, #5c1010 100%);
  position: relative;
  overflow: hidden;
  flex-shrink: 0;
}

.tonk-seat__fan .card-back:first-child {
  margin-left: 0;
}

.tonk-seat__info {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.tonk-seat__name {
  font-family: var(--font-ui);
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-primary);
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tonk-seat__meta {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tonk-seat__count {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  color: var(--text-muted);
}

.tonk-seat__tally {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--text-primary);
  background: rgba(0, 0, 0, 0.3);
  padding: 1px 7px;
  border-radius: 8px;
}

.tonk-seat__phase-tag {
  font-family: var(--font-ui);
  font-size: 0.6rem;
  font-weight: 700;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 6px;
  color: #1a0f06;
}

.tonk-phase--discard {
  background: var(--tonk-phase-discard);
}

.tonk-phase--draw {
  background: var(--tonk-phase-draw);
}

.tonk-seat__disconnected {
  font-family: var(--font-ui);
  font-size: 0.65rem;
  color: #e05555;
}

.tonk-seat__turn-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--gold-accent);
  box-shadow: 0 0 8px var(--gold-accent);
  position: absolute;
  top: 4px;
  right: 4px;
  animation: tonk-pulse 1.5s ease-in-out infinite;
}

@keyframes tonk-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.6;
    transform: scale(1.3);
  }
}

@media (max-width: 767px) {
  .tonk-seat-rail {
    gap: 6px;
    padding: 6px 8px;
    border-bottom-width: 1.5px;
    flex-wrap: wrap;
  }

  .tonk-seat {
    flex-direction: row;
    padding: 4px 10px;
    border-radius: 16px;
    border-width: 1.5px;
  }

  .tonk-seat__fan {
    display: none;
  }

  .tonk-seat__name {
    font-size: 0.72rem;
    max-width: 60px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tonk-seat__turn-indicator {
    animation: none;
  }
}
</style>
