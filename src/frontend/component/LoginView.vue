<script setup lang="ts">
import { defineProps, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { AuthNService } from '@/service/authNService';
import { EventSourceSingleton } from '@/util/sse';

const authModel = defineProps({
    username: { type: String, required: true },
    password: { type: String, required: true },
});

const attemptedLogin = ref(false);
const errorMessage = ref('');
const route = useRoute();
const router = useRouter();

async function sendLogin() {
    AuthNService.login(authModel.username, authModel.password).then((_jwt: string) => {;
        // open EventSource connection if not already
        EventSourceSingleton.getInstance();

        // redirect to previous page
        const redirectedFrom = route.query.redirect;
        if (redirectedFrom !== undefined && typeof redirectedFrom === "string") {
            console.log("Redirecting to previous page");
            router.push(redirectedFrom);
        } else {
            // redirect to homepage otherwise
            router.push('/');
        }
    }).catch((error) => {
        console.error(error);
        if (error.response) {
            errorMessage.value = `Failed to sign up because of error ${error.response.data}`;
        } else {
            errorMessage.value = `Failed to login`;
        }
    }).finally(() => { attemptedLogin.value = true });
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
        <form @submit.prevent="sendLogin">
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
        <p>New user? <router-link to="/signup">Register Now</router-link></p>
    </div>
</template>