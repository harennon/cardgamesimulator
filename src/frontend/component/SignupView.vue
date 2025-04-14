<script setup lang="ts">
import { defineProps, ref } from 'vue';
import { AuthNService } from '@/service/authNService';
import { EventSourceSingleton } from '@/util/sse';
import { useRouter } from 'vue-router';

const authModel = defineProps({
    username: { type: String, required: true },
    password: { type: String, required: true },
});

const attemptedLogin = ref(false);
const errorMessage = ref('');
const router = useRouter();

async function sendSignup() {
    AuthNService.signup(authModel.username, authModel.password).then((_jwt : string) => {
        // open EventSource connection if not already
        EventSourceSingleton.getInstance();
        
        // redirect to homepage on success
        router.push('/');
    }).catch((error) => {
        console.error(error);
        if (error.response) {
            errorMessage.value = `Failed to sign up because of error ${error.response.data}`;
        } else {
            errorMessage.value = `Failed to sign up`;
        }
    }).finally(() => {
        attemptedLogin.value = true;
    })
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
                <label for="username">Username:</label>
                <input id="username" type="text" required v-model="authModel.username"/>
            </div>
            <div>
                <label for="password">Password:</label>
                <input type="password" required v-model="authModel.password"/>
            </div>
            <button type="submit">Login</button>
        </form>
        <p id="errorMessage" v-if="attemptedLogin">{{ errorMessage }}</p>
        <p>Existing user? <router-link to="/login">Log in</router-link></p>
    </div>
</template>