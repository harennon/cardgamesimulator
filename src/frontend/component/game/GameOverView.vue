<template>
  <div class="game-over" data-testid="game-over">
    <div class="game-over__panel">
      <h1 class="game-over__winner">{{ winner }} wins!</h1>

      <div
        v-if="hasFinalPlay"
        class="game-over__final-play"
        data-testid="game-over-final-play"
      >
        <div class="game-over__final-play-label">Final Play</div>
        <div class="game-over__final-play-cards">
          <GameCard
            v-for="card in finalPlay!.cards"
            :key="`${card.rank}-${card.suit}`"
            :card="card"
            size="small"
          />
        </div>
        <div class="game-over__final-play-meta">
          {{ finalPlayLabel }} · played by {{ finalPlayByName }}
        </div>
      </div>

      <table class="game-over__scores game-over__fade-in">
        <thead>
          <tr>
            <th>Player</th>
            <th>Place</th>
            <th>Cards Left</th>
            <th>Points</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in scoreRows" :key="row.playerId">
            <td class="game-over__player-cell">
              <span
                v-if="row.badge"
                class="game-over__badge"
                :class="row.badgeClass"
                :data-badge="row.badge"
              ></span>
              {{ row.displayName }}
            </td>
            <td>{{ i + 1 }}</td>
            <td>{{ row.cardCount }}</td>
            <td>{{ row.score }}</td>
          </tr>
        </tbody>
      </table>

      <div
        v-if="totalTurns > 0"
        class="game-over__metadata game-over__fade-in game-over__fade-in--delay-1"
      >
        Total Turns: {{ totalTurns }}
      </div>

      <div
        v-if="stats.length > 0"
        class="game-over__stats"
        data-testid="game-over-stats"
      >
        <div
          v-for="(stat, i) in stats"
          :key="stat.label"
          class="game-over__stat-card game-over__slide-up"
          :style="{ animationDelay: `${i * 80}ms` }"
        >
          <span class="game-over__stat-label">{{ stat.label }}</span>
          <span class="game-over__stat-value">{{ stat.value }}</span>
        </div>
      </div>

      <div class="game-over__actions">
        <button
          class="game-over__btn game-over__btn--rematch"
          disabled
          title="Coming soon"
        >
          Rematch
        </button>
        <button class="game-over__btn game-over__btn--home" @click="goHome">
          Back to Home
        </button>
      </div>

      <div v-if="isGuest" class="game-over__guest-nudge">
        <a :href="`/signup?redirect=/game/${gameId}`"
          >Sign up to save your stats</a
        >
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import { useRouter } from "vue-router";
import type { PlayerScore, PlayerPublicInfo } from "@shared/engine-types";
import type { Big2HistoryEntry, Big2Play } from "@shared/big2-types";
import GameCard from "@/component/game-ui/GameCard.vue";
import {
  deriveBig2Stats,
  getBadgeForPosition,
  getBadgeClass,
} from "./gameOverStats";

const HAND_TYPE_LABELS: Record<string, string> = {
  single: "Single",
  pair: "Pair",
  straight: "Straight",
  fullHouse: "Full House",
  fourOfAKind: "Four of a Kind",
  straightFlush: "Straight Flush",
};

const props = defineProps<{
  scores: readonly PlayerScore[];
  winner: string;
  players: readonly PlayerPublicInfo[];
  isGuest: boolean;
  gameId: string;
  playHistory?: readonly Big2HistoryEntry[];
  currentPlayerId?: string;
  totalTurns?: number;
  finalPlay?: Big2Play | null;
}>();

const router = useRouter();

const scoreRows = computed(() => {
  const totalPlayers = props.scores.length;
  return [...props.scores]
    .sort((a, b) => b.score - a.score)
    .map((s, i) => {
      const player = props.players.find((p) => p.playerId === s.playerId);
      const badge = getBadgeForPosition(i, totalPlayers);
      return {
        playerId: s.playerId,
        displayName: player?.displayName ?? s.playerId,
        cardCount: player?.cardCount ?? 0,
        score: s.score,
        badge,
        badgeClass: badge ? getBadgeClass(badge) : null,
      };
    });
});

const stats = computed(() => {
  if (!props.playHistory || !props.currentPlayerId) return [];
  return deriveBig2Stats(props.playHistory, props.currentPlayerId);
});

const totalTurns = computed(() => props.totalTurns ?? 0);

const hasFinalPlay = computed(
  () => !!props.finalPlay && props.finalPlay.cards.length > 0,
);

const finalPlayLabel = computed(() => {
  if (!props.finalPlay) return "";
  return (
    HAND_TYPE_LABELS[props.finalPlay.handType.kind] ??
    props.finalPlay.handType.kind
  );
});

const finalPlayByName = computed(() => {
  if (!props.finalPlay) return "";
  const player = props.players.find(
    (p) => p.playerId === props.finalPlay!.playerId,
  );
  return player?.displayName ?? props.finalPlay.playerId;
});

function goHome(): void {
  router.push("/");
}
</script>

<style scoped>
@import "@/styles/game-variables.css";

.game-over {
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--felt);
  overflow-y: auto;
}

.game-over__panel {
  background: var(--panel-bg);
  border: 2px solid var(--table-rim-light);
  border-radius: 12px;
  padding: 40px 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
  min-width: 400px;
  margin: 24px 0;
}

.game-over__winner {
  font-family: var(--font-ui);
  font-size: 2rem;
  font-weight: 700;
  color: var(--gold-accent);
  margin: 0;
  text-shadow: 0 0 24px var(--gold-glow);
}

.game-over__final-play {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
}

.game-over__final-play-label {
  font-family: var(--font-ui);
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--gold-accent);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.game-over__final-play-cards {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px;
}

.game-over__final-play-meta {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  color: var(--text-muted);
  text-align: center;
}

.game-over__scores {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-ui);
  font-size: 0.9rem;
  color: var(--text-primary);
}

.game-over__scores th {
  color: var(--gold-accent);
  font-weight: 600;
  text-transform: uppercase;
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  padding: 8px 12px;
  border-bottom: 1px solid var(--table-rim-light);
  text-align: left;
}

.game-over__scores td {
  padding: 8px 12px;
  border-bottom: 1px solid rgba(74, 44, 30, 0.4);
  color: var(--text-primary);
}

.game-over__player-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.game-over__badge {
  display: inline-block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  flex-shrink: 0;
}

.game-over__badge--gold {
  background: #c9a84c;
  box-shadow: 0 0 6px rgba(201, 168, 76, 0.5);
}

.game-over__badge--silver {
  background: #a8a8a8;
  box-shadow: 0 0 6px rgba(168, 168, 168, 0.4);
}

.game-over__badge--bronze {
  background: #b87333;
  box-shadow: 0 0 6px rgba(184, 115, 51, 0.4);
}

.game-over__badge--grey {
  background: #5a5a5a;
}

.game-over__metadata {
  font-family: var(--font-ui);
  font-size: 0.82rem;
  color: var(--text-muted);
  text-align: center;
}

.game-over__stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  width: 100%;
}

.game-over__stat-card {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.game-over__stat-label {
  font-family: var(--font-ui);
  font-size: 0.72rem;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.game-over__stat-value {
  font-family: var(--font-ui);
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-primary);
}

.game-over__actions {
  display: flex;
  gap: 12px;
}

.game-over__btn {
  font-family: var(--font-ui);
  font-size: 0.95rem;
  font-weight: 600;
  padding: 10px 28px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  transition:
    background 0.15s ease,
    opacity 0.15s ease;
}

.game-over__btn--rematch {
  background: transparent;
  color: var(--text-muted);
  border: 1.5px solid var(--text-muted);
  cursor: not-allowed;
  opacity: 0.5;
}

.game-over__btn--home {
  background: var(--gold-accent);
  color: #1a0f06;
}

.game-over__btn--home:hover {
  background: #d4b45a;
}

.game-over__guest-nudge {
  font-family: var(--font-ui);
  font-size: 0.85rem;
  color: var(--text-muted);
}

.game-over__guest-nudge a {
  color: var(--gold-accent);
  text-decoration: underline;
}

/* Animations */
.game-over__fade-in {
  animation: fadeIn 200ms ease forwards;
  opacity: 0;
}

.game-over__fade-in--delay-1 {
  animation-delay: 100ms;
}

.game-over__slide-up {
  animation: slideUp 300ms ease forwards;
  opacity: 0;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .game-over__fade-in,
  .game-over__slide-up {
    animation: none;
    opacity: 1;
    transform: none;
  }
}

@media (max-width: 767px) {
  .game-over__panel {
    min-width: unset;
    width: calc(100% - 32px);
    padding: 28px 20px;
  }

  .game-over__winner {
    font-size: 1.5rem;
  }

  .game-over__scores th,
  .game-over__scores td {
    padding: 6px 8px;
    font-size: 0.8rem;
  }

  .game-over__stat-card {
    padding: 12px;
  }

  .game-over__stat-value {
    font-size: 1.1rem;
  }

  .game-over__actions {
    flex-direction: column;
    width: 100%;
    gap: 10px;
  }

  .game-over__btn {
    width: 100%;
    min-height: 48px;
    font-size: 16px;
  }
}

@media (max-width: 320px) {
  .game-over__stats {
    grid-template-columns: 1fr;
  }
}
</style>
