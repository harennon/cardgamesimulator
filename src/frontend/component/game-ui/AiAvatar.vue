<template>
  <div
    class="ai-avatar"
    :class="size === 'sm' ? 'ai-avatar--sm' : 'ai-avatar--md'"
    aria-hidden="true"
    data-testid="ai-avatar"
  >
    <svg viewBox="0 0 24 24" fill="none" class="ai-avatar__glyph">
      <!-- Rounded-rect head -->
      <rect
        x="5"
        y="7"
        width="14"
        height="11"
        rx="3"
        stroke="currentColor"
        stroke-width="1.5"
      />
      <!-- Left eye -->
      <circle cx="9.5" cy="12.5" r="1.4" fill="currentColor" />
      <!-- Right eye -->
      <circle cx="14.5" cy="12.5" r="1.4" fill="currentColor" />
      <!-- Antenna line -->
      <line
        x1="12"
        y1="4"
        x2="12"
        y2="7"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      />
      <!-- Antenna dot -->
      <circle cx="12" cy="3.5" r="1" fill="currentColor" />
    </svg>
  </div>
</template>

<script lang="ts" setup>
withDefaults(defineProps<{ size?: "sm" | "md" }>(), { size: "md" });
</script>

<style scoped>
@import "@/styles/game-variables.css";

.ai-avatar {
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #12305c, #0a1a33);
  border: 1.5px solid var(--ai-accent-line);
  box-shadow: 0 0 0 2px var(--ai-accent-dim);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--ai-accent);
}

.ai-avatar--sm {
  width: 26px;
  height: 26px;
}

.ai-avatar--md {
  width: 34px;
  height: 34px;
}

.ai-avatar__glyph {
  width: 60%;
  height: 60%;
}
</style>
