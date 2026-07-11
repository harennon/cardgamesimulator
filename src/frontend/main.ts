import { createApp } from "vue";
import App from "@/component/App.vue";
import { router } from "@/routes";
import { initObservability } from "@/observability/sentry";
import { useCorrelation } from "@/composables/useCorrelation";
import "./styles/game-variables.css";
import "./styles/flows.css";

const app = createApp(App);
const { correlationId } = useCorrelation();
initObservability(app, router, correlationId.value);
app.use(router).mount("#app");
