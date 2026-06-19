<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { axiosInstance } from "@/service/http";
import { createGuestSession } from "@/service/guestService";
import type { JoinGameRequest, JoinGameResponse } from "@shared/model";

const props = defineProps<{ gameId: string }>();

const router = useRouter();
const displayName = ref("");
const errorMessage = ref("");
const loading = ref(false);

async function joinGame() {
  if (!displayName.value.trim()) {
    errorMessage.value = "Please enter a display name.";
    return;
  }

  loading.value = true;
  errorMessage.value = "";

  try {
    const guestState = await createGuestSession(
      displayName.value.trim(),
      props.gameId,
    );

    const joinRequest: JoinGameRequest = { gameId: props.gameId };
    await axiosInstance.post<JoinGameResponse>("/api/joinGame", joinRequest, {
      headers: { Authorization: `Bearer ${guestState.token}` },
    });

    await router.push(`/game/${props.gameId}`);
  } catch (error: unknown) {
    const e = error as { response?: { status?: number; data?: string } };
    if (!e.response) {
      errorMessage.value = "Network error. Please try again.";
    } else if (e.response.status === 404) {
      errorMessage.value = "Game not found.";
    } else if (e.response.status === 409) {
      errorMessage.value = "Game is full.";
    } else if (e.response.status === 400) {
      errorMessage.value = "Invalid display name. Please try a different name.";
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
      <h2 class="form-card__title">Join as Guest</h2>

      <div class="form-card__field">
        <label class="form-card__label" for="display-name">Display Name</label>
        <input
          class="form-card__input"
          id="display-name"
          v-model="displayName"
          type="text"
          maxlength="20"
          required
          placeholder="Enter your name"
          :disabled="loading"
          data-testid="guest-name-input"
        />
      </div>

      <p v-if="errorMessage" class="form-card__error">{{ errorMessage }}</p>

      <button
        type="submit"
        :disabled="loading"
        class="btn-primary"
        data-testid="guest-join-button"
      >
        {{ loading ? "Joining..." : "Join Game" }}
      </button>

      <div class="form-card__divider">or</div>

      <router-link
        :to="`/signup?redirect=/game/${gameId}`"
        class="btn-secondary"
      >
        Sign up for stats &amp; history
      </router-link>

      <p class="form-card__footer">
        Already have an account?
        <router-link :to="`/login?redirect=/game/${gameId}`"
          >Sign in</router-link
        >
      </p>
    </form>
  </div>
</template>
