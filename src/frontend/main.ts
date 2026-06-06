import { createApp } from 'vue';
import axios, { type AxiosInstance } from 'axios';
import App from '@/component/App.vue';
import { router } from '@/routes';
import { getAccessToken } from '@/service/authService';

function bootstrap() {
    createApp(App)
        .use(router)
        .mount('#app')
}

export const axiosInstance: AxiosInstance = axios.create({ baseURL: '/api' });

axiosInstance.interceptors.request.use(async (config) => {
    const token = await getAccessToken();
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

bootstrap();
