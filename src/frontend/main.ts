import { createApp } from "vue";
import App from "@/component/App.vue";
import { router } from "@/routes";
import "./styles/game-variables.css";
import "./styles/flows.css";

createApp(App).use(router).mount("#app");
