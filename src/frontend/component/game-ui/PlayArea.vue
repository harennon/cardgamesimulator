<template>
  <div class="play-area">
    <TurnTimer
      :turn-deadline="turnDeadline"
      :is-my-turn="isMyTurn"
      :current-player-name="currentPlayerName"
      :total-seconds="totalSeconds"
    />

    <div v-if="lastPlay || recentPlays.length" class="play-area__history-zone">
      <div
        v-for="(entry, idx) in recentPlays"
        :key="`prev-${idx}`"
        class="play-area__previous-play"
        :class="
          recentPlays.length === 2 && idx === 0
            ? 'play-area__previous-play--older'
            : 'play-area__previous-play--recent'
        "
      >
        <div class="play-area__card-row">
          <GameCard
            v-for="card in entry.cards"
            :key="`${card.rank}-${card.suit}`"
            :card="card"
            size="small"
          />
        </div>
      </div>

      <div v-if="lastPlay" class="play-area__current-play">
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
    </div>

    <div v-else class="play-area__free">New Trick — Play any combination</div>
  </div>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import type { PlayerPublicInfo } from "@shared/engine-types";
import type { Big2HistoryEntry, Big2PublicState } from "@shared/big2-types";
import GameCard from "./GameCard.vue";
import TurnTimer from "./TurnTimer.vue";

const HAND_TYPE_LABELS: Record<string, string> = {
  single: "Single",
  pair: "Pair",
  straight: "Straight",
  fullHouse: "Full House",
  fourOfAKind: "Four of a Kind",
  straightFlush: "Straight Flush",
};

const props = defineProps<{
  lastPlay: Big2PublicState["lastPlay"] | null;
  isMyTurn: boolean;
  currentPlayerName: string;
  players: readonly PlayerPublicInfo[];
  turnDeadline: number | null;
  totalSeconds: number;
  playHistory: readonly Big2HistoryEntry[];
}>();

const recentPlays = computed(() => {
  const plays = props.playHistory.filter((e) => e.action === "play");
  if (plays.length <= 1) return [];
  return plays.slice(-3, -1);
});

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

.play-area__history-zone {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  position: relative;
}

.play-area__previous-play {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  transition:
    opacity 0.4s ease,
    transform 0.4s ease;
}

.play-area__previous-play--older {
  transform: rotate(-3deg) scale(0.65);
  opacity: 0.35;
  margin-right: -4px;
}

.play-area__previous-play--recent {
  transform: rotate(-1.5deg) scale(0.78);
  opacity: 0.6;
  margin-right: 8px;
}

.play-area__current-play {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

@media (max-width: 767px) {
  .play-area__previous-play {
    display: none;
  }
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
</style>
