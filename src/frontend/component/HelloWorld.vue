<script setup lang="ts">
import { ref } from 'vue'

import { EchoRequest, EchoResponse } from '@shared/model'
import { axiosInstance } from '@/main';

const echo = ref('');
const echoResponse = ref('');

async function sendEcho() {
  const response = await axiosInstance.post<EchoResponse>('/api/echo', { string: echo.value } as EchoRequest);
  echoResponse.value = response.data.string;
}

async function sendAuthenticatedEcho() {
  const response = await axiosInstance.post<EchoResponse>('/api/authNedEcho', { string: echo.value } as EchoRequest);
  echoResponse.value = response.data.string;
}

</script>

<template>
  <div class="greetings">
    <h3>
      You’ve successfully created a project with
      <a href="https://vite.dev/" target="_blank" rel="noopener">Vite</a> +
      <a href="https://vuejs.org/" target="_blank" rel="noopener">Vue 3</a>.
    </h3>
  </div>

  <div><input v-model="echo" placeholder="Sample string" size="20"></div>
  <div><button @click="sendEcho">Echo</button></div>
  <div><button @click="sendAuthenticatedEcho">AuthN Echo</button></div>

  <div><h1> {{ echoResponse }}</h1></div>
  
</template>

<style scoped>
h1 {
  font-weight: 500;
  font-size: 2.6rem;
  position: relative;
  top: -10px;
}

h3 {
  font-size: 1.2rem;
}

.greetings h1,
.greetings h3 {
  text-align: center;
}

@media (min-width: 1024px) {
  .greetings h1,
  .greetings h3 {
    text-align: left;
  }
}
</style>
