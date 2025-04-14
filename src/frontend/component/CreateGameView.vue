<template>
    <h2>Create a game</h2>
    <form @submit.prevent="createGame">
        <div>
            <label for="game-type">Game Type:</label>
            <select v-model="createGameForm.gameType" id="game-type" required>
                <option disabled selected value>Please select game type</option>
                <option value="tonk">Tonk</option>
            </select>
        </div>

        <div>
            <label for="num-players">Number of players: {{ createGameForm.numPlayers }}</label>
            <input v-model="createGameForm.numPlayers" type="range" id="num-players" min="2" max="10" step="1">
        </div>
        
        <div v-if="createGameForm.gameType === 'tonk'">
            <label for="num-decks">Number of decks: {{ createGameForm.numberOfDecks }}</label>
            <input v-model="createGameForm.numberOfDecks" type="range" id="num-decks" min="1" max="4" step="1">
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
import { defineProps } from 'vue';
import { useRouter } from 'vue-router';

const createGameForm = defineProps({
    gameType: { type: String, required: true },
    numPlayers: { type: Number, required: true, default: 2 },
    numberOfDecks: { type: Number, required: false, default: 1 },
});

const router = useRouter();

async function createGame() {    
    const createGameRequest: CreateGameRequest = {
        gameType: createGameForm.gameType as GameType,
        numPlayers: createGameForm.numPlayers,
        gameOptions: {
            numDecks: createGameForm.numberOfDecks.toString(),
        },
    };
    const createGameResponse = await axiosInstance.post<CreateGameResponse>('/api/createGame', createGameRequest);

    router.push(`/game/${createGameResponse.data.gameId}`);
}
</script>