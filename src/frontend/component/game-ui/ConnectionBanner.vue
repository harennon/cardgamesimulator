<template>
  <div
    v-if="connectionState !== 'connected'"
    class="connection-banner"
    :class="`connection-banner--${connectionState}`"
    role="status"
    :aria-live="connectionState === 'reconnecting' ? 'polite' : 'assertive'"
    data-testid="connection-banner"
    :data-state="connectionState"
  >
    <template v-if="connectionState === 'reconnecting'">
      <span class="connection-banner__dot" aria-hidden="true"></span>
      <span class="connection-banner__text">
        Connection lost &mdash; reconnecting&hellip;<template
          v-if="reconnectAttempt > 0"
        >
          ({{ reconnectAttempt }}/{{ maxReconnectAttempts }})</template
        >
      </span>
    </template>

    <template v-else>
      <span class="connection-banner__text">Connection lost</span>
      <button
        class="connection-banner__reload-btn"
        data-testid="connection-banner-reload"
        @click="reload"
      >
        Reload to rejoin
      </button>
    </template>
  </div>
</template>

<script lang="ts" setup>
import type { ConnectionState } from "@/composables/connectionState";

defineProps<{
  connectionState: ConnectionState;
  reconnectAttempt: number;
  maxReconnectAttempts: number;
}>();

function reload(): void {
  window.location.reload();
}
</script>

<style scoped>
@import "@/styles/game-variables.css";

.connection-banner {
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 90; /* above board content (z-index 1) and wood rim (100); below reveal (101) */
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 16px;
  border-radius: 20px;
  font-family: var(--font-ui);
  font-size: 0.82rem;
  font-weight: 600;
  white-space: nowrap;
  pointer-events: none; /* default — buttons below override */
}

/* Reconnecting — amber pulsing pill */
.connection-banner--reconnecting {
  background: rgba(201, 168, 76, 0.18);
  border: 1.5px solid var(--gold-accent);
  color: var(--gold-accent);
  animation: bannerPulse 1.8s ease-in-out infinite;
}

/* Terminal — red static banner with a clickable reload button */
.connection-banner--terminal {
  background: rgba(224, 85, 85, 0.15);
  border: 1.5px solid var(--error-text);
  color: var(--error-text);
  pointer-events: auto;
}

/* Animated pulse dot inside the reconnecting pill */
.connection-banner__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

.connection-banner__text {
  line-height: 1.2;
}

.connection-banner__reload-btn {
  font-family: var(--font-ui);
  font-size: 0.78rem;
  font-weight: 700;
  padding: 4px 11px;
  border-radius: 5px;
  border: 1.5px solid var(--error-text);
  background: transparent;
  color: var(--error-text);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
  pointer-events: auto;
}

.connection-banner__reload-btn:hover {
  background: var(--error-text);
  color: #fff;
}

@keyframes bannerPulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

@media (prefers-reduced-motion: reduce) {
  .connection-banner--reconnecting {
    animation: none;
  }
}
</style>
