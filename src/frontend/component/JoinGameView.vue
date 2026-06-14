<script setup lang="ts">
import { axiosInstance } from "@/service/http";
import { JoinGameRequest, JoinGameResponse } from "@shared/model";
import { ref } from "vue";
import { useRouter } from "vue-router";

const router = useRouter();
const errorMessage = ref("");
const gameId = ref("");
const loading = ref(false);

async function joinGame() {
  loading.value = true;
  errorMessage.value = "";
  const joinGameRequest: JoinGameRequest = {
    gameId: gameId.value,
  };
  try {
    const response = await axiosInstance.post<JoinGameResponse>(
      "/api/joinGame",
      joinGameRequest,
    );
    router.push(`/game/${response.data.gameId}`);
  } catch (error: unknown) {
    const e = error as { response?: { status?: number } };
    if (!e.response) {
      errorMessage.value = "Network error. Please try again.";
    } else if (e.response.status === 404) {
      errorMessage.value = "Game not found.";
    } else if (e.response.status === 409) {
      errorMessage.value = "Game is full.";
    } else {
      errorMessage.value = "Something went wrong. Please try again.";
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flow-page">
    <form class="form-card" @submit.prevent="joinGame">
      <h2 class="form-card__title">Join a Game</h2>

      <div class="form-card__field">
        <label class="form-card__label" for="game-id">Game Code</label>
        <input
          class="form-card__input"
          v-model="gameId"
          id="game-id"
          required
          data-testid="game-code-input"
          placeholder="Paste game code or ID"
        />
      </div>

      <p
        v-if="errorMessage"
        class="form-card__error"
        data-testid="join-game-error"
      >
        {{ errorMessage }}
      </p>

      <button
        type="submit"
        class="btn-primary"
        :disabled="!gameId.trim() || loading"
        data-testid="join-game-button"
      >
        {{ loading ? "Joining..." : "Join Game" }}
      </button>

      <p class="form-card__footer">
        Or paste an invite link directly in your browser address bar.
      </p>
    </form>
  </div>
</template>
