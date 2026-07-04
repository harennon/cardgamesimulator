<script setup lang="ts">
import {
  ref,
  computed,
  useTemplateRef,
  onMounted,
  onUnmounted,
  watch,
} from "vue";
import { useRoute } from "vue-router";
import WalkthroughModal from "./WalkthroughModal.vue";
import { getWalkthrough, GAME_LABEL } from "./walkthroughs";
import { clusterPlacement, shouldFireGameStartToast } from "./clusterPlacement";
import { useCurrentGameType } from "@/composables/useCurrentGameType";
import { useFeedbackContext } from "@/composables/useFeedbackContext";
import FeedbackWidget from "@/component/FeedbackWidget.vue";

// The single bottom-right cluster: a (?) help FAB + a bug icon. Owns the
// walkthrough open/close state; hosts the (unchanged) feedback modal via an
// imperative open() call (LLD 111 §3.5 Option A). The shell receives only the
// static walkthrough + the gameType enum — no live game state (decision 7).
const { currentGameType } = useCurrentGameType();

const walkthroughOpen = ref(false);
const steps = computed(() => getWalkthrough(currentGameType.value));
const gameLabel = computed(() => GAME_LABEL[currentGameType.value]);

// Surface awareness (LLD 117/126): lift the cluster above the board action row.
// isNarrow drives the compact mobile-board CSS class only — not visibility.
// Placement reads only the route path — never live game state.
const route = useRoute();
const mql = window.matchMedia("(max-width: 767px)");
const isNarrow = ref(mql.matches);
const onNarrowChange = (e: MediaQueryListEvent): void => {
  isNarrow.value = e.matches;
};
onMounted(() => mql.addEventListener("change", onNarrowChange));
onUnmounted(() => {
  mql.removeEventListener("change", onNarrowChange);
  if (toastTimer) clearTimeout(toastTimer);
});

const placement = computed(() => clusterPlacement(route.path));
const onBoard = computed(() => placement.value.onBoard);

// Game-starts-while-open (E4): watch the EXISTING feedback-phase enum only while
// the walkthrough is open; on the lobby->in-progress edge show a non-blocking
// ~3s toast. Reads the coarse enum, never hands/board/socket (decision 7).
const { gamePhase } = useFeedbackContext();
const gameStartToast = ref(false);
let toastTimer: ReturnType<typeof setTimeout> | null = null;
watch(gamePhase, (now, prev) => {
  if (shouldFireGameStartToast(walkthroughOpen.value, prev, now)) {
    gameStartToast.value = true;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      gameStartToast.value = false;
    }, 3000);
  }
});

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
  <div
    v-if="!feedbackOpen"
    class="help-cluster"
    :class="{
      'help-cluster--board': onBoard,
      'help-cluster--board-tonk':
        onBoard && !isNarrow && currentGameType === 'tonk',
      'help-cluster--board-mobile': onBoard && isNarrow,
    }"
  >
    <div
      v-if="gameStartToast"
      class="help-toast"
      role="status"
      data-testid="howto-gamestart-toast"
    >
      Game started — close this when you're ready
    </div>
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

/* Live board (desktop): lift above the 64px action row so the (?) FAB never
   overlaps Play/Pass (Big2) or Discard/Draw/TONK (Tonk). */
.help-cluster--board {
  bottom: calc(64px + 16px + env(safe-area-inset-bottom, 0px));
}

/* Live Tonk board (desktop >767px): the Tonk action panel is auto-height
   (LLD 134) and can reach ~150px on the active player's turn (error + stepper
   + buttons). Override the generic 64px offset with a value that clears even
   the tallest three-line panel state. */
.help-cluster--board-tonk {
  bottom: calc(160px + env(safe-area-inset-bottom, 0px));
}

/* Live board (mobile ≤767px): clear the mobile action row; both FABs shown,
   compact sizing so the restored bug icon fits without crowding (LLD 126). */
.help-cluster--board-mobile {
  bottom: calc(
    var(--mobile-actions-height) + 12px + env(safe-area-inset-bottom, 0px)
  );
  gap: 9px;
}

/* Shrink the (?) FAB and bug FAB on the mobile board so the two-FAB cluster
   keeps a small bottom-right footprint and stays clear of the hand. */
.help-cluster--board-mobile .help-fab {
  width: 42px;
  height: 42px;
}

.help-cluster--board-mobile .help-fab--bug {
  width: 32px;
  height: 32px;
}

/* Non-blocking game-start toast (E4). Column-reverse stacks the FAB(s) from the
   bottom up; order:1 keeps this pill above them. Never intercepts pointer
   events, so the board underneath stays interactive. */
.help-toast {
  order: 1;
  align-self: flex-end;
  max-width: 220px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--gold-accent);
  background: var(--panel-bg);
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-size: 0.78rem;
  line-height: 1.35;
  text-align: right;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
  pointer-events: none;
  animation: help-toast-fade 0.2s ease;
}

@keyframes help-toast-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
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
  .help-toast {
    animation: none;
  }
}
</style>
