<script setup lang="ts">
import { axiosInstance } from "@/service/http";
import {
  JoinGameRequest,
  JoinGameResponse,
  ResolveJoinCodeResponse,
} from "@shared/model";
import { ref } from "vue";
import { useRouter } from "vue-router";

const router = useRouter();
const errorMessage = ref("");
const gameCode = ref("");
const loading = ref(false);

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_CODE_REGEX = /^[A-Z0-9]{4}$/i;

async function joinGame() {
  loading.value = true;
  errorMessage.value = "";

  try {
    const input = gameCode.value.trim().toUpperCase();
    let gameId: string;

    if (UUID_REGEX.test(input)) {
      // Direct UUID — use as gameId without resolution
      gameId = input.toLowerCase();
    } else if (SHORT_CODE_REGEX.test(input)) {
      // 4-char room code — resolve to gameId first
      try {
        const resolveResponse =
          await axiosInstance.get<ResolveJoinCodeResponse>(
            `/api/games/join/${input}`,
          );
        gameId = resolveResponse.data.gameId;
      } catch (error: unknown) {
        const e = error as { response?: { status?: number } };
        if (!e.response) {
          errorMessage.value = "Network error. Please try again.";
        } else if (e.response.status === 404) {
          errorMessage.value = "Game not found.";
        } else {
          errorMessage.value = "Something went wrong. Please try again.";
        }
        return;
      }
    } else {
      errorMessage.value = "Enter a 4-letter room code or game ID.";
      return;
    }

    const joinGameRequest: JoinGameRequest = { gameId };
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
          class="form-card__input form-card__input--uppercase"
          v-model="gameCode"
          id="game-id"
          required
          data-testid="game-code-input"
          placeholder="Enter 4-letter room code"
          maxlength="36"
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
        :disabled="!gameCode.trim() || loading"
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

<style scoped>
.form-card__input--uppercase {
  text-transform: uppercase;
}
</style>
