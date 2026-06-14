<script setup lang="ts">
import { ref } from "vue";
import { signUp } from "@/service/authService";
import { useRouter, useRoute } from "vue-router";
import {
  getGuestToken,
  claimGuestSession,
  clearGuestSession,
  restoreGuestSession,
} from "@/service/guestService";

const email = ref("");
const password = ref("");
const displayName = ref("");
const loading = ref(false);
const errorMessage = ref("");
const router = useRouter();
const route = useRoute();

async function sendSignup() {
  loading.value = true;
  errorMessage.value = "";
  try {
    await signUp(email.value, password.value, displayName.value);

    // If the user was a guest, claim their game session for their new account.
    // restoreGuestSession() handles the case where the user opened /signup in a fresh tab
    // (guestState is null in memory, but the cookie still exists).
    restoreGuestSession();
    const guestToken = getGuestToken();
    if (guestToken) {
      await claimGuestSession(guestToken);
      clearGuestSession();
    }

    const redirect = (route.query.redirect as string) || "/";
    router.push(redirect);
  } catch (error: unknown) {
    const e = error as { message?: string; response?: { data?: string } };
    errorMessage.value =
      e.message ?? e.response?.data ?? "Failed to create account.";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flow-page">
    <form class="form-card" @submit.prevent="sendSignup">
      <h2 class="form-card__title">Create Account</h2>

      <div class="form-card__field">
        <label class="form-card__label" for="display-name">Display Name</label>
        <input
          class="form-card__input"
          id="display-name"
          type="text"
          required
          v-model="displayName"
          data-testid="signup-display-name"
          maxlength="20"
          placeholder="Your in-game name"
        />
      </div>

      <div class="form-card__field">
        <label class="form-card__label" for="email">Email</label>
        <input
          class="form-card__input"
          id="email"
          type="email"
          required
          v-model="email"
          data-testid="signup-email"
          placeholder="you@example.com"
        />
      </div>

      <div class="form-card__field">
        <label class="form-card__label" for="password">Password</label>
        <input
          class="form-card__input"
          id="password"
          type="password"
          required
          v-model="password"
          data-testid="signup-password"
          minlength="6"
          placeholder="Min 6 characters"
        />
      </div>

      <p
        v-if="errorMessage"
        class="form-card__error"
        data-testid="signup-error"
      >
        {{ errorMessage }}
      </p>

      <button
        type="submit"
        class="btn-primary"
        :disabled="loading"
        data-testid="signup-button"
      >
        {{ loading ? "Creating account..." : "Sign Up" }}
      </button>

      <p class="form-card__footer">
        Already have an account?
        <router-link to="/login">Log in</router-link>
      </p>
    </form>
  </div>
</template>
