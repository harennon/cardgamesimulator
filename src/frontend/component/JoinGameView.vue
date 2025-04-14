<template>
    <h2>Join a game</h2>
    <form @submit.prevent="joinGame">
        <div>
            <label for="game-id">Game ID:</label>
            <input v-model="joinGameForm.gameId" id="game-id" required>
        </div>
        <p id="errorMessage">{{ errorMessage }}</p>
        <input type="submit">
    </form>
</template>

<style lang="css" scoped>
#errorMessage {
    color: red;
}
form {
    display: block;
    @media only screen and (min-width: 750px) {
        width: 50%;
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

<script setup lang="ts">
import { axiosInstance } from '@/main';
import { JoinGameRequest, JoinGameResponse } from '@shared/model';
import { defineProps, ref } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
const errorMessage = ref('');

const joinGameForm = defineProps({
    gameId: { type: String, required: true },
});

async function joinGame() {    
    const joinGameRequest: JoinGameRequest = {
        gameId: joinGameForm.gameId,
    };
    await axiosInstance.post<JoinGameResponse>('/api/joinGame', joinGameRequest).then((response) => {
        router.push(`/game/${response.data.gameId}`);
    }).catch((error) => {
        switch (error.response.status) {
            case 400: {
                errorMessage.value = "Game is full.";
                break;
            };
            case 404: {
                errorMessage.value = "Game not found.";
                break;
            };
        }
    });
}
</script>