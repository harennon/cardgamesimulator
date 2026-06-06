<script setup lang="ts">
import { ref } from 'vue';
import { signUp } from '@/service/authService';
import { useRouter } from 'vue-router';

const email = ref('');
const password = ref('');
const displayName = ref('');

const attemptedLogin = ref(false);
const errorMessage = ref('');
const router = useRouter();

async function sendSignup() {
    signUp(email.value, password.value, displayName.value).then(() => {
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
                <label for="display-name">Display Name:</label>
                <input id="display-name" type="text" required v-model="displayName"/>
            </div>
            <div>
                <label for="email">Email:</label>
                <input id="email" type="email" required v-model="email"/>
            </div>
            <div>
                <label for="password">Password:</label>
                <input type="password" required v-model="password"/>
            </div>
            <button type="submit">Sign Up</button>
        </form>
        <p id="errorMessage" v-if="attemptedLogin">{{ errorMessage }}</p>
        <p>Existing user? <router-link to="/login">Log in</router-link></p>
    </div>
</template>
