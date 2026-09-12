<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { getSession } from "@/service/authService";
import { axiosInstance } from "@/service/http";
import type { ResolveJoinCodeResponse } from "@shared/model";

const router = useRouter();
const signedIn = ref(false);
const displayName = ref("");

const roomCode = ref("");
const codeError = ref("");
const resolving = ref(false);

const SHORT_CODE_REGEX = /^[A-Z0-9]{4}$/i;

onMounted(async () => {
  const session = await getSession();
  if (session) {
    signedIn.value = true;
    displayName.value =
      session.user.user_metadata?.display_name ?? session.user.email ?? "";
  }
});

async function joinByCode(): Promise<void> {
  const code = roomCode.value.trim().toUpperCase();
  if (!SHORT_CODE_REGEX.test(code)) {
    codeError.value = "No game found for that code.";
    return;
  }
  resolving.value = true;
  codeError.value = "";
  try {
    const response = await axiosInstance.get<ResolveJoinCodeResponse>(
      `/api/games/join/${code}`,
    );
    router.push(`/game/${response.data.gameId}/join`);
  } catch (error: unknown) {
    const e = error as { response?: { status?: number } };
    if (!e.response) {
      codeError.value = "Network error. Please try again.";
    } else if (e.response.status === 404) {
      codeError.value = "No game found for that code.";
    } else {
      codeError.value = "Something went wrong. Please try again.";
    }
  } finally {
    resolving.value = false;
  }
}
</script>

<template>
  <div class="flow-page flow-page--center">
    <div class="home">
      <h1 class="home__title" data-testid="home-title">Card Game Simulator</h1>

      <p v-if="signedIn" class="home__subtitle" data-testid="welcome-message">
        Welcome back, {{ displayName }}
      </p>

      <div v-if="signedIn" class="home__actions">
        <router-link
          to="/create-game"
          class="btn-primary home__btn"
          data-testid="create-game-link"
        >
          Create Game
        </router-link>
        <router-link
          to="/join-game"
          class="btn-secondary home__btn"
          data-testid="join-game-link"
        >
          Join Game
        </router-link>
        <router-link
          to="/stats"
          class="btn-secondary home__btn"
          data-testid="stats-link"
        >
          Your Stats
        </router-link>
      </div>

      <div v-else class="home__auth-prompt">
        <form class="home__code-form" @submit.prevent="joinByCode">
          <label class="form-card__label" for="room-code"
            >Have a room code?</label
          >
          <div class="home__code-row">
            <input
              class="form-card__input home__code-input"
              id="room-code"
              v-model="roomCode"
              maxlength="4"
              autocomplete="off"
              autocapitalize="characters"
              placeholder="WXYZ"
              data-testid="home-room-code-input"
            />
            <button
              type="submit"
              class="btn-primary home__code-btn"
              :disabled="!roomCode.trim() || resolving"
              data-testid="home-room-code-join"
            >
              {{ resolving ? "…" : "Join" }}
            </button>
          </div>
          <p
            v-if="codeError"
            class="form-card__error"
            data-testid="home-room-code-error"
          >
            {{ codeError }}
          </p>
        </form>
        <div class="form-card__divider">or</div>
        <p class="home__description">
          Play Big2 with friends. Create an account to host games, or join via
          an invite link as a guest.
        </p>
        <router-link to="/login" class="btn-primary home__btn">
          Log In
        </router-link>
        <router-link to="/signup" class="btn-secondary home__btn">
          Sign Up
        </router-link>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home {
  text-align: center;
  max-width: 500px;
  width: 100%;
}

.home__title {
  font-family: var(--font-ui);
  font-size: 2rem;
  font-weight: 700;
  color: var(--gold-accent);
  margin: 0 0 8px;
}

.home__subtitle {
  font-family: var(--font-ui);
  font-size: 1rem;
  color: var(--text-primary);
  margin: 0 0 32px;
}

.home__description {
  font-family: var(--font-ui);
  font-size: 0.95rem;
  color: var(--text-muted);
  margin: 0 0 24px;
  line-height: 1.5;
}

.home__actions {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 300px;
  margin: 0 auto;
}

.home__btn {
  display: block;
  width: 100%;
  box-sizing: border-box;
  text-align: center;
  text-decoration: none;
}

.home__auth-prompt {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  max-width: 300px;
  margin: 0 auto;
}

.home__code-form {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
}

.home__code-row {
  display: flex;
  gap: 8px;
}

.home__code-input {
  flex: 1;
  font-family: monospace;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  min-width: 0;
}

.home__code-btn {
  flex-shrink: 0;
  width: auto;
  padding-left: 20px;
  padding-right: 20px;
}
</style>
