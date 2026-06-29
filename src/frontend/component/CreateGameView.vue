<script setup lang="ts">
import { axiosInstance } from "@/service/http";
import { CreateGameRequest, CreateGameResponse, GameType } from "@shared/model";
import { GAME_TYPE_UI_BOUNDS } from "@/component/statsView";
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";

const DECK_ROUNDS_VALUES = [5, 6, 7, 8, 9, 10, 11, 12] as const;

const gameType = ref("");
const maxPlayers = ref(2);
const turnTimerSeconds = ref<30 | 60 | 90>(60);
// Tonk only; integer 5..12, default 8. Carried across type toggles (E3).
const deckRoundsTarget = ref<number>(8);
const loading = ref(false);
const errorMessage = ref("");

const router = useRouter();

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

// Bounds for the selected type; null while no type is chosen (form disabled).
const bounds = computed(() =>
  gameType.value ? GAME_TYPE_UI_BOUNDS[gameType.value as GameType] : null,
);

const minPlayers = computed(() => bounds.value?.minPlayers ?? 2);
const maxPlayersBound = computed(() => bounds.value?.maxPlayers ?? 4);
const showDeckLength = computed(
  () => bounds.value?.hasDeckRoundsTarget ?? false,
);

// On game-type change: seed the count to the new type's min when coming from
// the unselected state, otherwise re-clamp the current count into the new range.
watch(gameType, (next, prev) => {
  if (!next) return;
  const b = GAME_TYPE_UI_BOUNDS[next as GameType];
  if (!prev) {
    maxPlayers.value = b.minPlayers;
  } else {
    maxPlayers.value = clamp(maxPlayers.value, b.minPlayers, b.maxPlayers);
  }
});

async function createGame() {
  loading.value = true;
  errorMessage.value = "";
  try {
    const createGameRequest: CreateGameRequest = {
      gameType: gameType.value as GameType,
      maxPlayers: maxPlayers.value,
      turnTimerSeconds: turnTimerSeconds.value,
      ...(gameType.value === "tonk"
        ? { deckRoundsTarget: deckRoundsTarget.value }
        : {}),
    };
    const createGameResponse = await axiosInstance.post<CreateGameResponse>(
      "/api/createGame",
      createGameRequest,
    );
    router.push(`/game/${createGameResponse.data.gameId}`);
  } catch (error: unknown) {
    const e = error as { message?: string };
    errorMessage.value = e.message ?? "Network error. Please try again.";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flow-page">
    <form class="form-card" @submit.prevent="createGame">
      <h2 class="form-card__title">Create a Game</h2>

      <div class="form-card__field">
        <label class="form-card__label" for="game-type">Game Type</label>
        <select
          class="form-card__input"
          v-model="gameType"
          id="game-type"
          required
          data-testid="game-type-select"
        >
          <option disabled value="">Select a game</option>
          <option value="big2">Big 2</option>
          <option value="tonk">Tonk</option>
        </select>
      </div>

      <div class="form-card__field">
        <div class="range-head">
          <label class="form-card__label" for="max-players">Players</label>
          <span class="range-value" data-testid="max-players-value">{{
            maxPlayers
          }}</span>
        </div>
        <input
          class="form-card__range"
          v-model.number="maxPlayers"
          type="range"
          id="max-players"
          :min="minPlayers"
          :max="maxPlayersBound"
          step="1"
          data-testid="max-players-input"
        />
        <div class="range-scale">
          <span>{{ minPlayers }}</span
          ><span>{{ maxPlayersBound }}</span>
        </div>
      </div>

      <div
        v-if="showDeckLength"
        class="form-card__field tonk-only"
        data-testid="deck-length-field"
      >
        <label class="form-card__label">Deck Length (rounds)</label>
        <div
          class="seg"
          role="group"
          aria-label="Deck length in rounds"
          data-testid="deck-length-seg"
        >
          <button
            v-for="r in DECK_ROUNDS_VALUES"
            :key="r"
            type="button"
            class="seg__btn"
            :aria-pressed="deckRoundsTarget === r"
            :data-testid="`deck-length-option-${r}`"
            @click="deckRoundsTarget = r"
          >
            {{ r }}
          </button>
        </div>
        <div class="seg-meta">
          <span>shorter deck</span>
          <span>default <b>8</b></span>
          <span>longer deck</span>
        </div>
        <p class="help-text">
          How many rounds the deck should last before it's recut. Discrete
          choice, 5&ndash;12, default 8.
        </p>
      </div>

      <div class="form-card__field">
        <label class="form-card__label" for="turn-timer">Turn Timer</label>
        <select
          class="form-card__input"
          v-model="turnTimerSeconds"
          id="turn-timer"
          data-testid="turn-timer-select"
        >
          <option :value="30">30 seconds</option>
          <option :value="60">60 seconds</option>
          <option :value="90">90 seconds</option>
        </select>
      </div>

      <p
        v-if="errorMessage"
        class="form-card__error"
        data-testid="create-game-error"
      >
        {{ errorMessage }}
      </p>

      <button
        type="submit"
        class="btn-primary"
        :disabled="!gameType || loading"
        data-testid="submit-create-game"
      >
        {{ loading ? "Creating..." : "Create Game" }}
      </button>
    </form>
  </div>
</template>

<style scoped>
@import "@/styles/game-variables.css";

.range-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.range-value {
  font-family: var(--font-ui);
  font-weight: 700;
  color: var(--gold-accent);
  font-size: 0.95rem;
  font-variant-numeric: tabular-nums;
}

.range-scale {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  font-size: 0.68rem;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.tonk-only {
  border-left: 2px solid var(--tonk-cyan);
  padding-left: 12px;
  margin-left: -2px;
  animation: revealDown 0.22s ease;
}

@keyframes revealDown {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .tonk-only {
    animation: none;
  }
}

.seg {
  display: flex;
  gap: 4px;
  background: var(--input-bg);
  border: 1.5px solid var(--input-border);
  border-radius: var(--input-radius);
  padding: 4px;
  flex-wrap: wrap;
}

.seg__btn {
  flex: 1 1 0;
  min-width: 30px;
  font-family: var(--font-ui);
  font-size: 0.85rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  padding: 7px 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}

.seg__btn:hover {
  color: var(--text-primary);
}

.seg__btn[aria-pressed="true"] {
  background: var(--gold-accent);
  color: #1a0f06;
}

.seg-meta {
  display: flex;
  justify-content: space-between;
  font-size: 0.72rem;
  color: var(--text-muted);
  margin-top: 2px;
}

.seg-meta b {
  color: var(--tonk-cyan);
  font-weight: 700;
}

.help-text {
  font-size: 0.72rem;
  color: var(--text-muted);
  line-height: 1.45;
  margin: 2px 0 0;
}
</style>
