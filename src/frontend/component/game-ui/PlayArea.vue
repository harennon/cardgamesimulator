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
        <div class="play-area__card-row">
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
  .play-area__trick-pile {
    left: -64px;
  }
}
</style>
