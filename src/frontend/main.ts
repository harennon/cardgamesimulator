import { createApp } from "vue";
import App from "@/component/App.vue";
import { router } from "@/routes";

createApp(App).use(router).mount("#app");
