<template>
    <h2>Create a game</h2>
    <form @submit.prevent="createGame">
        <div>
            <label for="game-type">Game Type:</label>
            <select v-model="gameType" id="game-type" required>
                <option disabled selected value>Please select game type</option>
                <option value="tonk">Tonk</option>
            </select>
        </div>

        <div>
            <label for="max-players">Number of players: {{ maxPlayers }}</label>
            <input v-model="maxPlayers" type="range" id="max-players" min="2" max="10" step="1">
        </div>

        <div v-if="gameType === 'tonk'">
            <label for="num-decks">Number of decks: {{ numberOfDecks }}</label>
            <input v-model="numberOfDecks" type="range" id="num-decks" min="1" max="4" step="1">
        </div>

        <input type="submit">
    </form>
</template>

<style lang="css" scoped>
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
import { CreateGameRequest, CreateGameResponse, GameType } from '@shared/model';
import { ref } from 'vue';
import { useRouter } from 'vue-router';

const gameType = ref('');
const maxPlayers = ref(2);
const numberOfDecks = ref(1);

const router = useRouter();

async function createGame() {
    const createGameRequest: CreateGameRequest = {
        gameType: gameType.value as GameType,
        maxPlayers: maxPlayers.value,
        gameOptions: {
            numDecks: numberOfDecks.value.toString(),
        },
    };
    const createGameResponse = await axiosInstance.post<CreateGameResponse>('/api/createGame', createGameRequest);

    router.push(`/game/${createGameResponse.data.gameId}`);
}
</script>
