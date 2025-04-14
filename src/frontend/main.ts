import { createApp } from 'vue';
import axios, { type AxiosInstance } from 'axios';
import App from '@/component/App.vue';
import { router } from '@/routes';
import { getJWTCookie } from './util/cookie';
import { EventSourceSingleton } from './util/sse';

function bootstrap() {
    createApp(App)
        .use(router)
        .mount('#app')
}

export const axiosInstance: AxiosInstance = axios.create()
axiosInstance.defaults.headers.common["Authorization"] = `Bearer ${getJWTCookie()}`;

if (getJWTCookie() !== "") {
    // open EventSource connection if authenticated already
    EventSourceSingleton.getInstance();
}

bootstrap();
