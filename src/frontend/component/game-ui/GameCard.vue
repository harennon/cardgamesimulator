<template>
  <div v-if="faceDown" class="card card-back" :class="sizeClass"></div>
  <div
    v-else-if="joker"
    class="card card--joker"
    :class="[
      sizeClass,
      { 'card--selected': selected, 'card--interactive': interactive },
    ]"
    data-testid="joker-card"
  >
    <span class="card__joker-icon" aria-label="Joker">&#9733;</span>
  </div>
  <div
    v-else
    class="card"
    :class="[
      sizeClass,
      suitColorClass,
      { 'card--selected': selected, 'card--interactive': interactive },
    ]"
  >
    <div class="card__corner">
      <span class="card__corner-rank">{{ displayRank }}</span>
      <span class="card__corner-suit">{{ suitSymbol }}</span>
    </div>
    <span class="card__rank">{{ displayRank }}</span>
    <span class="card__suit">{{ suitSymbol }}</span>
  </div>
</template>

<script lang="ts" setup>
import type { Card } from "@shared/engine-types";
import type { TonkCard } from "@shared/tonk-types";
import { isJoker } from "@shared/tonk-types";
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    card: Card | TonkCard;
    selected?: boolean;
    faceDown?: boolean;
    size?: "small" | "medium" | "large";
    interactive?: boolean;
  }>(),
  { selected: false, faceDown: false, size: "medium", interactive: false },
);

const SUIT_SYMBOLS: Record<string, string> = {
  clubs: "♣",
  diamonds: "♦",
  hearts: "♥",
  spades: "♠",
};

// A Tonk joker has no rank/suit; render an icon face instead.
const joker = computed(() => isJoker(props.card));

const suitSymbol = computed(() =>
  joker.value ? "" : (SUIT_SYMBOLS[(props.card as Card).suit] ?? ""),
);

const suitColorClass = computed(() => {
  if (joker.value) return "black";
  const suit = (props.card as Card).suit;
  return suit === "hearts" || suit === "diamonds" ? "red" : "black";
});

const sizeClass = computed(() => `card--${props.size}`);

const displayRank = computed(() =>
  joker.value ? "" : (props.card as Card).rank,
);
</script>

<style scoped>
@import "@/styles/game-variables.css";

.card {
  position: relative;
  border-radius: 6px;
  border: 1.5px solid #c8b89a;
  background: var(--card-face);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-family: var(--font-card);
  font-weight: 700;
  user-select: none;
  box-shadow: 2px 4px 8px var(--card-shadow);
  transition:
    transform var(--card-select-duration) var(--card-select-easing),
    box-shadow var(--card-select-duration) var(--card-select-easing),
    border-color var(--card-select-duration) var(--card-select-easing);
  flex-shrink: 0;
}

.card--large,
.card--medium {
  width: var(--card-hand-width);
  height: var(--card-hand-height);
  font-size: 1rem;
}

/* Joker face — centered icon, no rank/suit (LLD 88 decision 5) */
.card--joker {
  background: linear-gradient(135deg, #faf3e8 0%, #efe2cb 100%);
}

.card__joker-icon {
  color: var(--gold-accent);
  font-size: 1.8em;
  line-height: 1;
  text-shadow: 0 0 6px var(--gold-glow);
}

.card--small .card__joker-icon {
  font-size: 1.2em;
}

.card--large {
  font-size: 1.1rem;
}

.card--small {
  width: 30px;
  height: 42px;
  font-size: 0.72rem;
}

/* Option B: a 30px-wide thumbnail shows only the centered rank+suit.
   The corner index is redundant at this size and produced the squished look. */
.card--small .card__corner {
  display: none;
}

.card__corner {
  position: absolute;
  top: 4px;
  left: 5px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
}

.card__corner-rank {
  font-family: var(--font-card);
  font-weight: 700;
  font-size: 11px;
  line-height: 1;
}

.card__corner-suit {
  font-size: 10px;
  line-height: 1;
  margin-top: -2px;
}

.card__rank {
  line-height: 1;
}

.card__suit {
  line-height: 1;
  font-size: 1.2em;
}

.card.red .card__rank,
.card.red .card__suit,
.card.red .card__corner-rank,
.card.red .card__corner-suit {
  color: var(--red-suit);
}

.card.black .card__rank,
.card.black .card__suit,
.card.black .card__corner-rank,
.card.black .card__corner-suit {
  color: var(--black-suit);
}

.card--interactive {
  cursor: pointer;
  will-change: transform;
}

.card--selected {
  transform: translateY(var(--card-selected-lift));
  box-shadow:
    0 8px 24px var(--gold-glow),
    3px 6px 16px var(--card-shadow);
  border-color: var(--gold-accent);
}

/* Card back — opponents */
.card-back {
  background: linear-gradient(135deg, #8b1a1a 0%, #5c1010 100%);
  border: 1.5px solid #c9a84c;
  position: relative;
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
