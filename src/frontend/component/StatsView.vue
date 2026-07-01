<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { GameStatsEntry, StatsWindow } from "@shared/model";
import { getSession } from "@/service/authService";
import { fetchStats } from "@/service/statsService";
import {
  gameTypeLabel,
  statRowsFor,
  sortedEntries,
  WINDOW_TABS,
  isEmptyWindow,
  showTrackingSince,
  formatTrackingSince,
  stepWindow,
} from "@/component/statsView";

type PageState =
  | { status: "loading" }
  | { status: "guest" }
  | { status: "error" }
  | { status: "ready"; games: GameStatsEntry[]; trackingSince: string | null };

const state = ref<PageState>({ status: "loading" });
const selectedWindow = ref<StatsWindow>("lifetime");

// Monotonic request token: only the response for the latest load() call is
// allowed to write state, so a slow earlier-window response can't clobber a
// newer selection (E8, latest-wins).
let requestToken = 0;

async function load(window: StatsWindow): Promise<void> {
  const token = ++requestToken;
  state.value = { status: "loading" };
  try {
    const response = await fetchStats(window);
    if (token !== requestToken) return;
    state.value = {
      status: "ready",
      games: response.games,
      trackingSince: response.trackingSince,
    };
  } catch {
    if (token !== requestToken) return;
    state.value = { status: "error" };
  }
}

async function init(): Promise<void> {
  const session = await getSession();
  if (!session) {
    state.value = { status: "guest" };
    return;
  }
  await load(selectedWindow.value);
}

function selectWindow(window: StatsWindow): void {
  if (window === selectedWindow.value) return;
  selectedWindow.value = window;
  void load(window);
}

function retry(): void {
  void load(selectedWindow.value);
}

// Keyboard: arrow-left/right move selection (matching swipe direction).
function onTabKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowRight") {
    event.preventDefault();
    selectWindow(stepWindow(selectedWindow.value, 1));
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    selectWindow(stepWindow(selectedWindow.value, -1));
  }
}

// Mobile swipe on the stats region (E9/E10). A predominantly-horizontal drag
// past the threshold steps the window (clamped at the ends); vertical or
// short/ambiguous gestures fall through to normal page scroll.
const SWIPE_THRESHOLD_PX = 40;
let swipeStartX: number | null = null;
let swipeStartY: number | null = null;

function onSwipeStart(event: PointerEvent): void {
  swipeStartX = event.clientX;
  swipeStartY = event.clientY;
}

function onSwipeEnd(event: PointerEvent): void {
  if (swipeStartX === null || swipeStartY === null) return;
  const dx = event.clientX - swipeStartX;
  const dy = event.clientY - swipeStartY;
  swipeStartX = null;
  swipeStartY = null;
  if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
  if (Math.abs(dx) <= Math.abs(dy)) return; // not horizontal-dominant
  selectWindow(stepWindow(selectedWindow.value, dx < 0 ? 1 : -1));
}

onMounted(init);

defineExpose({ load, selectWindow, retry, state, selectedWindow });
</script>

<template>
  <div class="flow-page">
    <div class="stats-card">
      <h1 class="stats-card__title" data-testid="stats-title">Your Stats</h1>
      <p class="stats-card__caption">Lifetime totals across all your games.</p>

      <div
        v-if="state.status !== 'guest'"
        class="stats-tabs"
        role="tablist"
        aria-label="Stats time range"
        data-testid="stats-window-tabs"
        @keydown="onTabKeydown"
      >
        <span
          class="stats-tabs__thumb"
          :style="{
            transform: `translateX(${
              WINDOW_TABS.findIndex((t) => t.window === selectedWindow) * 100
            }%)`,
          }"
          aria-hidden="true"
        ></span>
        <button
          v-for="tab in WINDOW_TABS"
          :key="tab.window"
          type="button"
          role="tab"
          class="stats-tabs__tab"
          :class="{ 'stats-tabs__tab--active': tab.window === selectedWindow }"
          :aria-selected="tab.window === selectedWindow"
          :tabindex="tab.window === selectedWindow ? 0 : -1"
          :data-testid="`stats-window-${tab.window}`"
          @click="selectWindow(tab.window)"
        >
          {{ tab.label }}
        </button>
      </div>

      <div
        class="stats-panel"
        @pointerdown="onSwipeStart"
        @pointerup="onSwipeEnd"
      >
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
            @click="retry"
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

        <template v-else>
          <p
            v-if="showTrackingSince(selectedWindow, state.trackingSince)"
            class="stats-card__tracking"
            aria-live="polite"
            data-testid="stats-tracking-since"
          >
            Tracking since {{ formatTrackingSince(state.trackingSince) }}
          </p>

          <div
            v-if="isEmptyWindow(selectedWindow, state.games.length)"
            class="stats-card__message"
            data-testid="stats-empty-window"
          >
            <p>
              No games finished in this range yet. Try Lifetime to see all your
              games.
            </p>
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

          <div
            v-else
            :key="selectedWindow"
            class="stats-list"
            data-testid="stats-list"
          >
            <div
              v-for="entry in sortedEntries(state.games)"
              :key="entry.gameType"
              class="stats-entry"
              data-testid="stats-entry"
            >
              <h2 class="stats-entry__name">
                {{ gameTypeLabel(entry.gameType) }}
              </h2>
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
        </template>
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

.stats-tabs {
  position: relative;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  background: var(--input-bg);
  border: 1.5px solid var(--card-panel-border);
  border-radius: 999px;
  padding: 4px;
}

.stats-tabs__thumb {
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 4px;
  width: calc((100% - 8px) / 3);
  background: var(--gold-accent);
  border-radius: 999px;
  transition: transform 0.18s ease;
  pointer-events: none;
}

.stats-tabs__tab {
  position: relative;
  z-index: 1;
  background: transparent;
  border: none;
  border-radius: 999px;
  padding: 8px 4px;
  font-family: var(--font-ui);
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-muted);
  cursor: pointer;
  transition: color 0.18s ease;
}

.stats-tabs__tab--active {
  color: var(--btn-primary-text);
}

.stats-tabs__tab:focus-visible {
  outline: 2px solid var(--gold-accent);
  outline-offset: 2px;
}

.stats-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  touch-action: pan-y;
}

.stats-card__tracking {
  font-family: var(--font-ui);
  font-size: 0.78rem;
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

  .stats-tabs__thumb {
    transition: none;
  }

  .stats-list {
    animation: none;
  }
}

.stats-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  animation: stats-list-fade 0.18s ease;
}

@keyframes stats-list-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
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
