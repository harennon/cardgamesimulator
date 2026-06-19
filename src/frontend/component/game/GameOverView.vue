<template>
  <div class="game-over" data-testid="game-over">
    <div class="game-over__panel">
      <h1 class="game-over__winner">{{ winner }} wins!</h1>

      <table class="game-over__scores">
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
            <td>{{ row.displayName }}</td>
            <td>{{ i + 1 }}</td>
            <td>{{ row.cardCount }}</td>
            <td>{{ row.score }}</td>
          </tr>
        </tbody>
      </table>

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

const props = defineProps<{
  scores: readonly PlayerScore[];
  winner: string;
  players: readonly PlayerPublicInfo[];
  isGuest: boolean;
  gameId: string;
}>();

const router = useRouter();

const scoreRows = computed(() => {
  return [...props.scores]
    .sort((a, b) => b.score - a.score)
    .map((s) => {
      const player = props.players.find((p) => p.playerId === s.playerId);
      return {
        playerId: s.playerId,
        displayName: player?.displayName ?? s.playerId,
        cardCount: player?.cardCount ?? 0,
        score: s.score,
      };
    });
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
}

.game-over__winner {
  font-family: var(--font-ui);
  font-size: 2rem;
  font-weight: 700;
  color: var(--gold-accent);
  margin: 0;
  text-shadow: 0 0 24px var(--gold-glow);
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
</style>
