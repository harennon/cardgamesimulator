<template>
  <div class="play-area">
    <div
      class="play-area__turn-banner"
      :class="{ 'play-area__turn-banner--mine': isMyTurn }"
    >
      <span v-if="isMyTurn">Your turn</span>
      <span v-else>{{ currentPlayerName }}'s turn</span>
    </div>

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
</template>

<script lang="ts" setup>
import { computed } from "vue";
import type { PlayerPublicInfo } from "@shared/engine-types";
import type { Big2PublicState } from "@shared/big2-types";
import GameCard from "./GameCard.vue";

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
}>();

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

.play-area__turn-banner {
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

.play-area__turn-banner--mine {
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

@media (prefers-reduced-motion: reduce) {
  .play-area__turn-banner--mine {
    animation: none;
  }
}
</style>
