<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { GameStatsEntry } from "@shared/model";
import { getSession } from "@/service/authService";
import { fetchStats } from "@/service/statsService";
import {
  gameTypeLabel,
  statRowsFor,
  sortedEntries,
} from "@/component/statsView";

type PageState =
  | { status: "loading" }
  | { status: "guest" }
  | { status: "error" }
  | { status: "ready"; games: GameStatsEntry[] };

const state = ref<PageState>({ status: "loading" });

async function load(): Promise<void> {
  const session = await getSession();
  if (!session) {
    state.value = { status: "guest" };
    return;
  }

  state.value = { status: "loading" };
  try {
    const response = await fetchStats();
    state.value = { status: "ready", games: response.games };
  } catch {
    state.value = { status: "error" };
  }
}

onMounted(load);
</script>

<template>
  <div class="flow-page">
    <div class="stats-card">
      <h1 class="stats-card__title" data-testid="stats-title">Your Stats</h1>
      <p class="stats-card__caption">Lifetime totals across all your games.</p>

      <div
        v-if="state.status === 'loading'"
        class="stats-card__message"
        data-testid="stats-loading"
      >
        <span class="stats-card__spinner" aria-hidden="true"></span>
        Loading your stats…
      </div>

      <div
        v-else-if="state.status === 'error'"
        class="stats-card__message"
        data-testid="stats-error"
      >
        <p class="stats-card__error">Couldn't load your stats.</p>
        <button
          type="button"
          class="btn-secondary"
          data-testid="stats-retry"
          @click="load"
        >
          Try Again
        </button>
      </div>

      <div
        v-else-if="state.status === 'guest'"
        class="stats-card__message"
        data-testid="stats-guest"
      >
        <p>Stats are saved only for registered accounts.</p>
        <div class="stats-card__cta">
          <router-link
            to="/signup"
            class="btn-primary"
            data-testid="stats-signup-link"
          >
            Sign Up
          </router-link>
          <router-link
            to="/login"
            class="btn-secondary"
            data-testid="stats-login-link"
          >
            Log In
          </router-link>
        </div>
      </div>

      <div
        v-else-if="state.games.length === 0"
        class="stats-card__message"
        data-testid="stats-empty"
      >
        <p>You haven't finished any games yet.</p>
        <router-link
          to="/create-game"
          class="btn-primary"
          data-testid="stats-create-link"
        >
          Create a Game
        </router-link>
      </div>

      <div v-else class="stats-list" data-testid="stats-list">
        <div
          v-for="entry in sortedEntries(state.games)"
          :key="entry.gameType"
          class="stats-entry"
          data-testid="stats-entry"
        >
          <h2 class="stats-entry__name">{{ gameTypeLabel(entry.gameType) }}</h2>
          <dl class="stats-entry__rows">
            <div
              v-for="row in statRowsFor(entry)"
              :key="row.label"
              class="stats-entry__row"
            >
              <dt class="stats-entry__label">{{ row.label }}</dt>
              <dd class="stats-entry__value">{{ row.value }}</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stats-card {
  background: var(--card-panel-bg);
  border: 2px solid var(--card-panel-border);
  border-radius: var(--card-panel-radius);
  padding: var(--card-panel-padding);
  width: 100%;
  max-width: var(--page-max-width);
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.stats-card__title {
  font-family: var(--font-ui);
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--gold-accent);
  text-align: center;
  margin: 0;
}

.stats-card__caption {
  font-family: var(--font-ui);
  font-size: 0.85rem;
  color: var(--text-muted);
  text-align: center;
  margin: 0;
}

.stats-card__message {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  font-family: var(--font-ui);
  font-size: 0.95rem;
  color: var(--text-primary);
  text-align: center;
  padding: 16px 0;
}

.stats-card__error {
  color: var(--error-text);
  margin: 0;
}

.stats-card__cta {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 240px;
}

.stats-card__spinner {
  width: 24px;
  height: 24px;
  border: 3px solid var(--table-rim-light);
  border-top-color: var(--gold-accent);
  border-radius: 50%;
  animation: stats-spin 0.8s linear infinite;
}

@keyframes stats-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .stats-card__spinner {
    animation: none;
  }
}

.stats-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.stats-entry {
  background: var(--input-bg);
  border: 1.5px solid var(--card-panel-border);
  border-radius: var(--input-radius);
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.stats-entry__name {
  font-family: var(--font-ui);
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--gold-accent);
  margin: 0;
}

.stats-entry__rows {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 16px;
  margin: 0;
}

.stats-entry__row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}

.stats-entry__label {
  font-family: var(--font-ui);
  font-size: 0.8rem;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.stats-entry__value {
  font-family: var(--font-ui);
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

@media (max-width: 767px) {
  .stats-entry__rows {
    grid-template-columns: 1fr;
  }
}
</style>
