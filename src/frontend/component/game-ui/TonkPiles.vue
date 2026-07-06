<template>
  <div class="tonk-piles" data-testid="tonk-piles">
    <!-- Stock: face-down back + count, never contents -->
    <div class="tonk-piles__slot">
      <GameCard :card="STOCK_PLACEHOLDER" face-down size="large" />
      <span class="tonk-piles__label" data-testid="tonk-stock-count"
        >{{ stockCount }} left</span
      >
    </div>

    <!-- Discard: live pile top -->
    <div class="tonk-piles__slot">
      <div class="tonk-piles__card-wrap">
        <div :key="currentDiscardKey" class="tonk-piles__discard-anim landing">
          <GameCard
            v-if="discardTop"
            :card="discardTop"
            size="large"
            data-testid="tonk-discard-top"
          />
          <div
            v-else
            class="tonk-piles__empty"
            data-testid="tonk-discard-empty"
          >
            empty
          </div>
        </div>
        <span
          v-if="lastDiscardCount > 1"
          class="tonk-piles__badge"
          data-testid="tonk-discard-multiplier"
          >&times;{{ lastDiscardCount }}</span
        >
      </div>
      <span
        v-if="discardTop && justPlayed"
        class="tonk-piles__label"
        data-testid="tonk-just-played"
        >{{ justPlayed }} just played</span
      >
    </div>

    <!-- Drawable: turn-start snapshot, cyan-ringed, beside the discard -->
    <div class="tonk-piles__slot">
      <div class="tonk-piles__drawable-ring">
        <GameCard
          v-if="drawableDiscard"
          :card="drawableDiscard"
          size="large"
          data-testid="tonk-drawable-card"
        />
        <div
          v-else
          class="tonk-piles__empty tonk-piles__empty--drawable"
          data-testid="tonk-drawable-empty"
        >
          no card to draw
        </div>
      </div>
      <span class="tonk-piles__label tonk-piles__label--drawable">
        drawable<template v-if="drawableFrom">
          · from {{ drawableFrom }}</template
        >
      </span>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import type { Card, PlayerPublicInfo } from "@shared/engine-types";
import type { TonkCard, TonkTurnPhase } from "@shared/tonk-types";
import GameCard from "./GameCard.vue";
import { drawableFromName, justPlayedName } from "./tonkDisplay";
import { discardKey } from "@/composables/useCardAnimations";

// Face-down stock uses GameCard's faceDown path; the card value is unused but
// the prop is required, so pass a stable placeholder (never rendered face up).
const STOCK_PLACEHOLDER: Card = { rank: "2", suit: "spades" };

const props = defineProps<{
  stockCount: number;
  discardTop: TonkCard | null;
  discardCount: number;
  lastDiscardCount: number;
  lastDiscardPlayerIndex: number | null;
  drawableDiscard: TonkCard | null;
  turnPhase: TonkTurnPhase;
  players: readonly PlayerPublicInfo[];
}>();

const justPlayed = computed(() =>
  justPlayedName(props.players, props.lastDiscardPlayerIndex),
);
const drawableFrom = computed(() =>
  drawableFromName(
    props.players,
    props.lastDiscardPlayerIndex,
    props.turnPhase,
  ),
);

// Key that changes only on a genuinely new discard; the discard wrapper
// re-enters on each key change, triggering the .landing drop animation.
const currentDiscardKey = computed(() =>
  discardKey(props.discardTop, props.discardCount),
);
</script>

<style scoped>
@import "@/styles/game-variables.css";

.tonk-piles {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 28px;
  padding: 16px;
}

.tonk-piles__slot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.tonk-piles__card-wrap {
  position: relative;
}

.tonk-piles__drawable-ring {
  border-radius: 8px;
  padding: 3px;
  box-shadow:
    0 0 0 2px var(--tonk-cyan),
    0 0 10px var(--tonk-cyan);
}

.tonk-piles__label {
  font-family: var(--font-ui);
  font-size: 0.65rem;
  color: var(--text-muted);
  text-align: center;
  max-width: 90px;
}

.tonk-piles__label--drawable {
  color: var(--tonk-cyan);
}

.tonk-piles__empty {
  width: var(--card-hand-width);
  height: var(--card-hand-height);
  border-radius: 6px;
  border: 1.5px dashed var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-ui);
  font-size: 0.6rem;
  color: var(--text-muted);
  text-align: center;
  padding: 4px;
}

.tonk-piles__empty--drawable {
  opacity: 0.5;
}

.tonk-piles__badge {
  position: absolute;
  top: -6px;
  right: -8px;
  background: var(--gold-accent);
  color: #1a0f06;
  font-family: var(--font-ui);
  font-size: 0.65rem;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 8px;
}

/* Play-to-center animation (variant 1: drop) for the discard top. Mirrors
   PlayArea.vue. The wrapper re-enters via :key change on each new discard. */
.tonk-piles__discard-anim.landing {
  animation: playDrop var(--play-duration) var(--play-easing) both;
}

@keyframes playDrop {
  from {
    opacity: 0;
    transform: translateY(-28px) scale(1.14);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .tonk-piles__discard-anim.landing {
    animation: none;
  }
}

@media (max-width: 767px) {
  .tonk-piles {
    gap: 14px;
    padding: 10px;
  }
}
</style>
