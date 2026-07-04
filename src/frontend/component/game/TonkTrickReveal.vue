<template>
  <div class="trick-reveal" data-testid="tonk-trick-reveal">
    <!-- Verdict header -->
    <div class="trick-reveal__verdict">
      <span class="trick-reveal__reason">&#9670; {{ reasonLabel }}</span>
      <h2 class="trick-reveal__headline">{{ verdictHeadline }}</h2>
    </div>

    <!-- Showdown rows, best-first -->
    <div class="trick-reveal__showdown" data-testid="showdown-list">
      <div
        v-for="row in rows"
        :key="row.seatIndex"
        class="showdown__player"
        :class="{
          'is-caller': row.isCaller,
          'is-self': row.isSelf,
        }"
        :data-testid="`showdown-row-${row.seatIndex}`"
      >
        <div class="showdown__identity">
          <span class="showdown__name">{{
            row.isSelf ? "You" : row.displayName
          }}</span>
          <span
            v-if="row.isCaller"
            class="showdown__badge showdown__badge--tonk"
            >Tonk</span
          >
          <span v-if="row.isBest" class="showdown__badge showdown__badge--low"
            >Low</span
          >
          <span class="showdown__hv">hv {{ row.handValue }}</span>
        </div>

        <div class="showdown__cards">
          <GameCard
            v-for="(card, cardIndex) in row.hand"
            :key="cardIndex"
            :card="card"
            size="small"
          />
        </div>

        <div class="showdown__delta" :class="deltaClass(row)">
          <span class="showdown__delta-points">+{{ row.delta }}</span>
          <span class="showdown__delta-total">t{{ row.total }}</span>
        </div>
      </div>
    </div>

    <!-- CTA: Continue button + countdown hairline -->
    <div class="trick-reveal__cta">
      <button
        class="trick-reveal__continue"
        data-testid="trick-reveal-continue"
        @click="emit('continue')"
      >
        Continue
        <span
          class="trick-reveal__progress"
          :style="{ animationDuration: `${durationMs}ms` }"
          aria-hidden="true"
        ></span>
      </button>
      <p class="trick-reveal__hint">
        Next round in {{ timerSecondsDisplay }}s &middot; everyone continues on
        their own
      </p>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, ref, onMounted, onUnmounted } from "vue";
import type { PlayerPublicInfo } from "@shared/engine-types";
import type { TonkTrickResult } from "@shared/tonk-types";
import GameCard from "@/component/game-ui/GameCard.vue";
import {
  trickRevealRows,
  trickReasonLabel,
  trickVerdictHeadline,
} from "@/component/game-ui/tonkDisplay";
import type { TrickRevealRow } from "@/component/game-ui/tonkDisplay";

const props = defineProps<{
  trickResult: TonkTrickResult;
  players: readonly PlayerPublicInfo[];
  tallies: readonly number[];
  myPlayerIndex: number;
  durationMs: number;
}>();

const emit = defineEmits<{ continue: [] }>();

const rows = computed(() =>
  trickRevealRows(
    props.trickResult,
    props.players,
    props.tallies,
    props.myPlayerIndex,
  ),
);

const reasonLabel = computed(() => trickReasonLabel(props.trickResult.reason));

const verdictHeadline = computed(() =>
  trickVerdictHeadline(rows.value, props.trickResult),
);

function deltaClass(row: TrickRevealRow): string {
  return row.isBest ? "delta--best" : "delta--penalty";
}

// Countdown display: ticks down from durationMs in seconds (presentational only;
// the authoritative timer lives in GameView).
const timerSecondsDisplay = ref(Math.ceil(props.durationMs / 1000));
let tickInterval: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  tickInterval = setInterval(() => {
    timerSecondsDisplay.value = Math.max(0, timerSecondsDisplay.value - 1);
  }, 1000);
});

onUnmounted(() => {
  if (tickInterval !== null) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
});
</script>

<style scoped>
@import "@/styles/game-variables.css";

/* Win green and loss red tokens used by delta coloring */
:root {
  --win-green: #3cb87a;
  --loss-red: #e05555;
}

.trick-reveal {
  position: fixed;
  inset: 0;
  z-index: 101; /* above TonkBoard wood-rim (z-index 100) */
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  padding: 32px 24px calc(100px + env(safe-area-inset-bottom, 0px));
  background: radial-gradient(
    ellipse 70% 55% at 50% 42%,
    rgba(10, 6, 3, 0.55) 0%,
    rgba(8, 5, 2, 0.82) 100%
  );
  overflow-y: auto;
}

/* Verdict header */
.trick-reveal__verdict {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  animation: revealRise 0.5s ease 0.05s both;
}

.trick-reveal__reason {
  font-family: var(--font-ui);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--gold-accent);
  text-transform: uppercase;
  letter-spacing: 0.14em;
}

.trick-reveal__headline {
  font-family: var(--font-card);
  font-size: 1.7rem;
  font-weight: 700;
  color: var(--text-primary);
  text-align: center;
  margin: 0;
  text-shadow: 0 0 20px rgba(0, 0, 0, 0.8);
}

/* Showdown list */
.trick-reveal__showdown {
  width: 100%;
  max-width: 640px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  animation: revealRise 0.5s ease 0.12s both;
}

.showdown__player {
  display: grid;
  grid-template-columns: 128px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(20, 12, 8, 0.7);
  border: 1px solid rgba(201, 168, 76, 0.12);
}

/* Caller row: gold-outlined + warm background */
.showdown__player.is-caller {
  border: 1px solid var(--gold-accent);
  box-shadow: inset 0 0 0 1px rgba(201, 168, 76, 0.25);
  background: rgba(40, 28, 10, 0.85);
}

/* Self row: subtle self-identity accent */
.showdown__player.is-self {
  border-color: rgba(155, 127, 232, 0.4);
}

.showdown__identity {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.showdown__name {
  font-family: var(--font-ui);
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.showdown__badge {
  display: inline-block;
  font-family: var(--font-ui);
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  padding: 1px 5px;
  border-radius: 3px;
  align-self: flex-start;
}

.showdown__badge--tonk {
  background: var(--gold-accent);
  color: #1a0f06;
}

.showdown__badge--low {
  background: #3cb87a;
  color: #0a1f12;
}

.showdown__hv {
  font-family: var(--font-ui);
  font-size: 0.72rem;
  color: var(--text-muted);
}

/* Cards area: fanned hand */
.showdown__cards {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  min-width: 0;
  animation: revealFlip 0.4s ease 0.18s both;
}

/* Delta column */
.showdown__delta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  white-space: nowrap;
}

.showdown__delta-points {
  font-family: var(--font-ui);
  font-size: 0.95rem;
  font-weight: 700;
}

.showdown__delta-total {
  font-family: var(--font-ui);
  font-size: 0.72rem;
  color: var(--text-muted);
}

.delta--best .showdown__delta-points {
  color: #3cb87a;
}

.delta--penalty .showdown__delta-points {
  color: #e05555;
}

/* CTA pinned to viewport bottom */
.trick-reveal__cta {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 14px 24px calc(14px + env(safe-area-inset-bottom, 0px));
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  background: linear-gradient(transparent, rgba(8, 5, 2, 0.9) 30%);
  animation: revealRise 0.5s ease 0.2s both;
}

.trick-reveal__continue {
  position: relative;
  overflow: hidden;
  font-family: var(--font-ui);
  font-size: 0.95rem;
  font-weight: 700;
  padding: 14px 40px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  background: var(--gold-accent);
  color: #1a0f06;
  min-height: 46px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
  transition:
    background 0.15s ease,
    transform 0.1s ease;
  width: 100%;
  max-width: 320px;
}

.trick-reveal__continue:hover {
  background: var(--btn-primary-hover);
}

.trick-reveal__continue:active {
  transform: translateY(1px);
}

/* Countdown hairline rides the button bottom */
.trick-reveal__progress {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 3px;
  width: 100%;
  background: rgba(255, 255, 255, 0.6);
  transform-origin: left;
  animation: countdown linear forwards;
}

.trick-reveal__hint {
  font-family: var(--font-ui);
  font-size: 0.72rem;
  color: var(--text-muted);
  text-align: center;
  margin: 0;
}

/* Entrance animations */
@keyframes revealRise {
  from {
    transform: translateY(14px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

@keyframes revealFlip {
  from {
    transform: rotateY(90deg);
    opacity: 0;
  }
  to {
    transform: rotateY(0deg);
    opacity: 1;
  }
}

@keyframes countdown {
  from {
    transform: scaleX(1);
  }
  to {
    transform: scaleX(0);
  }
}

/* Mobile: two-area grid layout */
@media (max-width: 767px) {
  .trick-reveal {
    padding: 20px 12px calc(90px + env(safe-area-inset-bottom, 0px));
    gap: 12px;
  }

  .trick-reveal__headline {
    font-size: 1.3rem;
  }

  .showdown__player {
    grid-template-columns: 1fr auto;
    grid-template-areas:
      "id    delta"
      "cards cards";
    gap: 6px 8px;
  }

  .showdown__identity {
    grid-area: id;
  }

  .showdown__cards {
    grid-area: cards;
  }

  .showdown__delta {
    grid-area: delta;
  }

  .trick-reveal__continue {
    width: 100%;
    max-width: 100%;
    font-size: 1rem;
  }
}

/* Reduced motion: disable entrance/flip/countdown animations */
@media (prefers-reduced-motion: reduce) {
  .trick-reveal__verdict,
  .trick-reveal__showdown,
  .trick-reveal__cta,
  .showdown__cards {
    animation: none;
  }

  .trick-reveal__progress {
    animation: none;
    display: none;
  }
}
</style>
