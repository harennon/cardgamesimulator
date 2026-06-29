<template>
  <div
    v-if="faceDown"
    class="card card-back"
    :class="`card--${size}`"
    data-testid="tonk-card-back"
  ></div>
  <div
    v-else-if="joker"
    class="card tonk-joker"
    :class="`card--${size}`"
    data-testid="tonk-joker"
    aria-label="Joker"
  >
    <span class="tonk-joker__icon" aria-hidden="true">&#x1F0CF;</span>
  </div>
  <GameCard v-else :card="standardCard" :size="size" />
</template>

<script lang="ts" setup>
import { computed } from "vue";
import type { Card } from "@shared/engine-types";
import { isJoker } from "@shared/tonk-types";
import type { TonkCard } from "@shared/tonk-types";
import GameCard from "./GameCard.vue";

const props = withDefaults(
  defineProps<{
    card?: TonkCard; // required for face-up; omitted for a face-down back
    size?: "small" | "medium" | "large";
    faceDown?: boolean;
  }>(),
  { card: undefined, size: "medium", faceDown: false },
);

const joker = computed<boolean>(
  () => props.card != null && isJoker(props.card),
);

// Only read as a standard Card in the non-joker, non-face-down branch.
const standardCard = computed<Card>(() => props.card as Card);
</script>

<style scoped>
@import "@/styles/game-variables.css";

.card {
  position: relative;
  border-radius: 6px;
  border: 1.5px solid #c8b89a;
  background: var(--card-face);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: 2px 4px 8px var(--card-shadow);
}

.card--large,
.card--medium {
  width: var(--card-hand-width);
  height: var(--card-hand-height);
}

.card--small {
  width: 28px;
  height: 40px;
}

.tonk-joker {
  background: linear-gradient(160deg, #2a1a3a 0%, #1c1030 100%);
  border-color: var(--gold-accent);
}

.tonk-joker__icon {
  font-size: 2rem;
  line-height: 1;
  color: var(--gold-accent);
  text-shadow: 0 0 10px var(--gold-glow);
}

.card--small .tonk-joker__icon {
  font-size: 1rem;
}

/* Card back — mirrors GameCard.vue */
.card-back {
  background: linear-gradient(135deg, #8b1a1a 0%, #5c1010 100%);
  border: 1.5px solid #c9a84c;
  overflow: hidden;
}

.card-back::after {
  content: "";
  position: absolute;
  inset: 4px;
  border: 1px solid rgba(201, 168, 76, 0.4);
  border-radius: 3px;
  background: repeating-linear-gradient(
    45deg,
    transparent,
    transparent 4px,
    rgba(201, 168, 76, 0.08) 4px,
    rgba(201, 168, 76, 0.08) 5px
  );
}
</style>
