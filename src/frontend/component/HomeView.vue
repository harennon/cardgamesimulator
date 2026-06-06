<template>
    <h2>This is the Homepage</h2>
    <br>
    <p v-if="signedIn">Welcome {{ user }}</p>
    <nav v-if="signedIn">
        <router-link to="/create-game">Create Game</router-link>
        <router-link to="/load-game">Load Game</router-link>
        <router-link to="/join-game">Join Game</router-link>
    </nav>
    <p v-else>Please <router-link to="/login">log in</router-link></p>

</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { getSession } from '@/service/authService';

const signedIn = ref(false);
const user = ref("");

onMounted(async () => {
    const session = await getSession();
    if (session) {
        signedIn.value = true;
        user.value = session.user.user_metadata?.display_name ?? session.user.email ?? "";
    }
});
</script>

<style lang="css" scoped>
nav {
  margin: 0;
  display: flex;
  width: 50%;
  justify-content: space-evenly;
  align-items: stretch;

  & > a {
    margin: 0 5%;
    padding: 8px;
    text-decoration: none;
    color: #BBBAC6;
    background-color: #274472;
    cursor: pointer;

    &:hover, &:focus {
      background-color: #6E7E85;
    }
  }
}
</style>
