<script setup lang="ts">
import { axiosInstance } from "@/service/http";
import { CreateGameRequest, CreateGameResponse, GameType } from "@shared/model";
import { ref } from "vue";
import { useRouter } from "vue-router";

const gameType = ref("");
const maxPlayers = ref(2);
const loading = ref(false);
const errorMessage = ref("");

const router = useRouter();

async function createGame() {
  loading.value = true;
  errorMessage.value = "";
  try {
    const createGameRequest: CreateGameRequest = {
      gameType: gameType.value as GameType,
      maxPlayers: maxPlayers.value,
      gameOptions: {},
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
        </select>
      </div>

      <div class="form-card__field">
        <label class="form-card__label" for="max-players">
          Players: {{ maxPlayers }}
        </label>
        <input
          class="form-card__range"
          v-model="maxPlayers"
          type="range"
          id="max-players"
          min="2"
          :max="gameType === 'big2' ? 4 : 10"
          step="1"
          data-testid="max-players-input"
        />
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
