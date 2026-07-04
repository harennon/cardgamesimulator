<template>
  <div class="play-area">
    <TurnTimer
      :turn-deadline="turnDeadline"
      :is-my-turn="isMyTurn"
      :current-player-name="currentPlayerName"
      :total-seconds="totalSeconds"
      :game-over="gameOver"
    />

    <div class="play-area__center">
      <TrickPile
        class="play-area__trick-pile"
        :play-history="playHistory"
        :trick-start-index="trickStartIndex"
      />

      <div v-if="lastPlay" class="play-area__cards">
        <div class="play-area__hand-label">
          {{ handTypeLabel }}
        </div>
        <div :key="currentPlayKey" class="play-area__card-row landing">
          <GameCard
            v-for="card in lastPlay.cards"
            :key="`${card.rank}-${card.suit}`"
            :card="card"
            size="medium"
          />
        </div>
        <div class="play-area__played-by">
          played by {{ lastPlayDisplayName }}
        </div>
      </div>

      <div v-else class="play-area__free">New Trick — Play any combination</div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import type { PlayerPublicInfo } from "@shared/engine-types";
import type { Big2PublicState, Big2HistoryEntry } from "@shared/big2-types";
import GameCard from "./GameCard.vue";
import TurnTimer from "./TurnTimer.vue";
import TrickPile from "./TrickPile.vue";
import { playKey } from "@/composables/useCardAnimations";

const HAND_TYPE_LABELS: Record<string, string> = {
  single: "Single",
  pair: "Pair",
  straight: "Straight",
  fullHouse: "Full House",
  fourOfAKind: "Four of a Kind",
  straightFlush: "Straight Flush",
};

const props = withDefaults(
  defineProps<{
    lastPlay: Big2PublicState["lastPlay"] | null;
    isMyTurn: boolean;
    currentPlayerName: string;
    players: readonly PlayerPublicInfo[];
    turnDeadline: number | null;
    totalSeconds: number;
    playHistory: readonly Big2HistoryEntry[];
    trickStartIndex: number;
    gameOver?: boolean;
  }>(),
  { gameOver: false },
);

const handTypeLabel = computed(() => {
  if (!props.lastPlay) return "";
  return (
    HAND_TYPE_LABELS[props.lastPlay.handType.kind] ??
    props.lastPlay.handType.kind
  );
});

// Key that changes only on a genuinely new play; the play row re-enters on
// each key change, triggering the .landing drop animation automatically.
const currentPlayKey = computed(() => playKey(props.lastPlay));

const lastPlayDisplayName = computed(() => {
  if (!props.lastPlay) return "";
  const player = props.players.find(
    (p) => p.playerId === props.lastPlay!.playerId,
  );
  return player?.displayName ?? props.lastPlay.playerId;
});
</script>

<style scoped>
@import "@/styles/game-variables.css";

.play-area {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 100%;
  padding: 16px;
}

.play-area__center {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

/* Pile sits beside the centered current play (left side per mockup). */
.play-area__trick-pile {
  position: absolute;
  left: -88px;
  top: 50%;
  transform: translateY(-50%);
}

.play-area__cards {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.play-area__hand-label {
  font-family: var(--font-ui);
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--gold-accent);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.play-area__card-row {
  display: flex;
  gap: 4px;
}

/* Play-to-center animation (variant 1: drop). The .landing class is static on
   the row; the :key change on each new play re-creates the element so the
   keyframe fires automatically per play (no boolean toggle needed). */
.play-area__card-row.landing {
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
  .play-area__card-row.landing {
    animation: none;
  }
}

.play-area__played-by {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  color: var(--text-muted);
}

.play-area__free {
  font-family: var(--font-ui);
  font-size: 0.9rem;
  color: var(--text-muted);
  font-style: italic;
  text-align: center;
}

@media (max-width: 767px) {
  /* (a) Make .play-area the containing block for the pile. */
  .play-area {
    position: relative;
  }
  /* (b) Demote the centered box so it is no longer the nearest positioned
         ancestor — otherwise the pile still anchors to the shrink-wrapped
         centered play, not the felt corner. */
  .play-area__center {
    position: static;
  }
  /* Pin the pile to the felt's bottom-left corner, decoupled from the play. */
  .play-area__trick-pile {
    position: absolute;
    left: 8px;
    bottom: 8px;
    top: auto;
    transform: none; /* cancel desktop translateY(-50%) */
  }

  /* Width-cap the played row and let cards flex-shrink to share the width. */
  .play-area__card-row {
    max-width: var(--play-row-max-width);
    width: 100%;
    justify-content: center;
  }
  .play-area__card-row .card--medium {
    flex: 0 1 var(--card-hand-width); /* shrink allowed, never grow past natural */
    min-width: 0; /* allow shrink below content size */
    height: auto; /* preserve aspect via ratio */
    aspect-ratio: var(--card-hand-width) / var(--card-hand-height);
  }
}
</style>
