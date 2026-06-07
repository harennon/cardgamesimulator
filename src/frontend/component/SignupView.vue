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

const attemptedLogin = ref(false);
const errorMessage = ref("");
const router = useRouter();
const route = useRoute();

async function sendSignup() {
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
    const e = error as { response?: { data?: string } };
    if (e.response) {
      errorMessage.value = `Failed to sign up because of error ${e.response.data}`;
    } else {
      errorMessage.value = `Failed to sign up`;
    }
  } finally {
    attemptedLogin.value = true;
  }
}
</script>

<style lang="css" scoped>
#errorMessage {
  color: red;
}
.login-screen {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
}
form {
  display: block;
  @media only screen and (min-width: 750px) {
    width: 300px;
  }

  & > div {
    margin: 10px 0;
    display: flex;
    justify-content: space-between;
  }

  label {
    margin: 5px;
  }
}
</style>

<template>
  <div class="login-screen">
    <form @submit.prevent="sendSignup">
      <div>
        <label for="display-name">Display Name:</label>
        <input id="display-name" type="text" required v-model="displayName" />
      </div>
      <div>
        <label for="email">Email:</label>
        <input id="email" type="email" required v-model="email" />
      </div>
      <div>
        <label for="password">Password:</label>
        <input type="password" required v-model="password" />
      </div>
      <button type="submit">Sign Up</button>
    </form>
    <p id="errorMessage" v-if="attemptedLogin">{{ errorMessage }}</p>
    <p>Existing user? <router-link to="/login">Log in</router-link></p>
  </div>
</template>
