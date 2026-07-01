<script setup lang="ts">
import { ref, computed, useTemplateRef } from "vue";
import WalkthroughModal from "./WalkthroughModal.vue";
import { getWalkthrough, GAME_LABEL } from "./walkthroughs";
import { useCurrentGameType } from "@/composables/useCurrentGameType";
import FeedbackWidget from "@/component/FeedbackWidget.vue";

// The single bottom-right cluster: a (?) help FAB + a bug icon. Owns the
// walkthrough open/close state; hosts the (unchanged) feedback modal via an
// imperative open() call (LLD 111 §3.5 Option A). The shell receives only the
// static walkthrough + the gameType enum — no live game state (decision 7).
const { currentGameType } = useCurrentGameType();

const walkthroughOpen = ref(false);
const steps = computed(() => getWalkthrough(currentGameType.value));
const gameLabel = computed(() => GAME_LABEL[currentGameType.value]);

const feedback =
  useTemplateRef<InstanceType<typeof FeedbackWidget>>("feedback");

// Hide the cluster's trigger buttons while the feedback modal is open, matching
// the pre-consolidation behaviour where the floating trigger disappeared behind
// its own modal (preserves e2e/feedback.spec.ts expectations).
const feedbackOpen = computed(() => feedback.value?.isOpen ?? false);

function openWalkthrough(): void {
  walkthroughOpen.value = true;
}

function closeWalkthrough(): void {
  walkthroughOpen.value = false;
}

function openFeedback(): void {
  feedback.value?.open();
}
</script>

<template>
  <div v-if="!feedbackOpen" class="help-cluster">
    <button
      class="help-fab"
      type="button"
      aria-label="How to play"
      title="How to play"
      data-testid="howto-fab"
      @click="openWalkthrough"
    >
      ?
    </button>
    <button
      class="help-fab help-fab--bug"
      type="button"
      aria-label="Report a bug"
      title="Report a bug / feedback"
      data-testid="feedback-trigger"
      @click="openFeedback"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M8 2l1.5 2.5M16 2l-1.5 2.5" />
        <rect x="7" y="6" width="10" height="12" rx="5" />
        <path
          d="M12 6v12M4 10h3M4 15h3M17 10h3M17 15h3M5 6l2 2M19 6l-2 2M5 19l2-2M19 19l-2-2"
        />
      </svg>
    </button>
  </div>

  <WalkthroughModal
    v-if="walkthroughOpen"
    :steps="steps"
    :game-label="gameLabel"
    @close="closeWalkthrough"
  />

  <FeedbackWidget ref="feedback" />
</template>

<style scoped>
@import "@/styles/game-variables.css";

/* Bottom-right cluster. Sits above the board content (wood-rim z-index 100,
   mobile log-toggle z-index 200) but below the walkthrough/feedback scrims. */
.help-cluster {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 1000;
  display: flex;
  flex-direction: column-reverse;
  gap: 10px;
  align-items: center;
}

.help-fab {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  border: 1px solid var(--gold-accent);
  background: rgba(20, 12, 8, 0.92);
  color: var(--gold-accent);
  font-family: var(--font-card);
  font-weight: 700;
  font-size: 1.25rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
  transition:
    transform 0.12s ease,
    background 0.15s ease,
    color 0.15s ease;
}

.help-fab svg {
  width: 20px;
  height: 20px;
}

.help-fab:hover {
  background: var(--gold-accent);
  color: #1a0f06;
  transform: translateY(-2px);
}

.help-fab--bug {
  border-color: var(--text-muted);
  color: var(--text-muted);
  width: 40px;
  height: 40px;
}

.help-fab--bug:hover {
  border-color: var(--gold-accent);
  color: var(--gold-accent);
  background: rgba(20, 12, 8, 0.92);
  transform: translateY(-2px);
}

@media (prefers-reduced-motion: reduce) {
  .help-fab {
    transition: none;
  }
}
</style>
