import { createApp } from "vue";
import App from "@/component/App.vue";
import { router } from "@/routes";
import { initObservability } from "@/observability/sentry";
import "./styles/game-variables.css";
import "./styles/flows.css";

const app = createApp(App);
initObservability(app, router);
app.use(router).mount("#app");
