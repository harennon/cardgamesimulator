<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { axiosInstance } from "@/main";
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
  <div class="guest-entry">
    <h2>Join as Guest</h2>
    <form @submit.prevent="joinGame">
      <div>
        <label for="display-name">Choose a display name:</label>
        <input
          id="display-name"
          v-model="displayName"
          type="text"
          maxlength="20"
          required
          placeholder="Enter your name"
          :disabled="loading"
        />
      </div>
      <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
      <button type="submit" :disabled="loading" class="btn-primary">
        {{ loading ? "Joining..." : "Join Game" }}
      </button>
    </form>
    <div class="divider">or</div>
    <router-link :to="`/signup?redirect=/game/${gameId}`" class="btn-secondary">
      Sign up for stats &amp; history
    </router-link>
    <p class="sign-in-link">
      Already have an account?
      <router-link :to="`/login?redirect=/game/${gameId}`">Sign in</router-link>
    </p>
  </div>
</template>

<style scoped>
.guest-entry {
  max-width: 400px;
  margin: 2rem auto;
  text-align: center;
}

form > div {
  margin: 10px 0;
  display: flex;
  flex-direction: column;
  text-align: left;
}

label {
  margin: 5px 0;
}

.error {
  color: red;
}

.btn-primary {
  width: 100%;
  padding: 10px;
  margin-top: 10px;
}

.btn-secondary {
  display: block;
  width: 100%;
  padding: 10px;
  text-align: center;
}

.divider {
  margin: 16px 0;
  color: #666;
}

.sign-in-link {
  margin-top: 16px;
  font-size: 0.9em;
}
</style>
