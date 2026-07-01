<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import WalkthroughScene from "./WalkthroughScene.vue";
import type { Walkthrough, CaptionSegment } from "./walkthroughTypes";
import {
  canGoBack,
  isLastStep,
  nextIndex,
  prevIndex,
  primaryAction,
} from "./stepNav";

// The shell's ONLY inputs are the static step list and a display label — no live
// game state (LLD 111 decision 7).
const props = defineProps<{
  steps: Walkthrough;
  gameLabel: string;
}>();

const emit = defineEmits<{ close: [] }>();

const currentIndex = ref(0);

const count = computed(() => props.steps.length);
const step = computed(() => props.steps[currentIndex.value]);
const backDisabled = computed(() => !canGoBack(currentIndex.value));
const onLastStep = computed(() => isLastStep(currentIndex.value, count.value));

function isStrong(seg: CaptionSegment): seg is { strong: string } {
  return "strong" in seg;
}

function goBack(): void {
  currentIndex.value = prevIndex(currentIndex.value, count.value);
}

function onPrimary(): void {
  if (primaryAction(currentIndex.value, count.value) === "close") {
    emit("close");
  } else {
    currentIndex.value = nextIndex(currentIndex.value, count.value);
  }
}

function close(): void {
  emit("close");
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.stopPropagation();
    close();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div class="wt-scrim" @click.self="close">
    <div
      class="wt-modal"
      role="dialog"
      aria-modal="true"
      aria-label="How to play"
      data-testid="howto-modal"
    >
      <div class="wt-head">
        <span class="wt-head__title">
          How to Play
          <small>{{ gameLabel }}</small>
        </span>
        <button
          class="wt-close"
          type="button"
          aria-label="Close"
          data-testid="howto-close"
          @click="close"
        >
          &times;
        </button>
      </div>

      <div class="wt-body">
        <div class="wt-illus">
          <span class="wt-illus__tag">{{ step.tag }}</span>
          <WalkthroughScene :scene="step.scene" />
        </div>
        <p class="wt-caption" data-testid="howto-caption">
          <template v-for="(seg, i) in step.caption" :key="i">
            <strong v-if="isStrong(seg)">{{ seg.strong }}</strong>
            <span v-else>{{ seg.text }}</span>
          </template>
        </p>
      </div>

      <div class="wt-foot">
        <div class="wt-dots" data-testid="howto-dots">
          <i
            v-for="(_, i) in steps"
            :key="i"
            :class="{ on: i === currentIndex }"
          ></i>
        </div>
        <div class="wt-step-count" data-testid="howto-step-indicator">
          Step <b>{{ currentIndex + 1 }}</b> of {{ count }}
        </div>
        <div class="wt-nav">
          <button
            class="wt-navbtn"
            type="button"
            :disabled="backDisabled"
            data-testid="howto-back"
            @click="goBack"
          >
            Back
          </button>
          <button
            class="wt-navbtn wt-navbtn--primary"
            type="button"
            data-testid="howto-next"
            @click="onPrimary"
          >
            {{ onLastStep ? "Got it ✓" : "Next →" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@import "@/styles/game-variables.css";

.wt-scrim {
  position: fixed;
  inset: 0;
  z-index: 1100;
  background: rgba(0, 0, 0, 0.66);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
}

.wt-modal {
  width: 100%;
  max-width: 340px;
  background: var(--card-panel-bg);
  border: 1.5px solid var(--table-rim-light);
  border-radius: 14px;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  max-height: calc(100dvh - 36px);
}

.wt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--table-rim-light);
  flex-shrink: 0;
}

.wt-head__title {
  font-family: var(--font-card);
  font-weight: 700;
  color: var(--gold-accent);
  font-size: 1rem;
}

.wt-head__title small {
  display: block;
  font-family: var(--font-ui);
  font-weight: 500;
  color: var(--text-muted);
  font-size: 0.66rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  margin-top: 2px;
}

.wt-close {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: 1px solid var(--table-rim-light);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 1.1rem;
  line-height: 1;
}

.wt-close:hover {
  color: var(--gold-accent);
  border-color: var(--gold-accent);
}

.wt-body {
  padding: 8px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
}

.wt-illus {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 18px;
}

.wt-illus__tag {
  font-size: 0.66rem;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--gold-accent);
  font-weight: 700;
}

.wt-caption {
  font-family: var(--font-ui);
  color: var(--text-primary);
  font-size: 0.9rem;
  line-height: 1.5;
  margin: 0;
}

.wt-caption strong {
  color: var(--gold-accent);
}

.wt-foot {
  padding: 12px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  border-top: 1px solid var(--table-rim-light);
  flex-shrink: 0;
}

.wt-dots {
  display: flex;
  gap: 7px;
  align-items: center;
  justify-content: center;
}

.wt-dots i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--table-rim-light);
  display: block;
  transition: all 0.2s ease;
}

.wt-dots i.on {
  background: var(--gold-accent);
  width: 20px;
  border-radius: 4px;
}

.wt-step-count {
  text-align: center;
  font-size: 0.72rem;
  color: var(--text-muted);
  letter-spacing: 0.06em;
}

.wt-step-count b {
  color: var(--gold-accent);
}

.wt-nav {
  display: flex;
  gap: 10px;
  align-items: center;
}

.wt-navbtn {
  font-family: var(--font-ui);
  font-size: 0.88rem;
  font-weight: 600;
  padding: 10px 18px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid var(--text-muted);
  background: transparent;
  color: var(--text-primary);
  min-height: 44px;
}

.wt-navbtn--primary {
  background: var(--gold-accent);
  color: #1a0f06;
  border-color: var(--gold-accent);
  flex: 1;
}

.wt-navbtn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

@media (prefers-reduced-motion: reduce) {
  .wt-scrim {
    backdrop-filter: none;
  }
  .wt-dots i {
    transition: none;
  }
}
</style>
