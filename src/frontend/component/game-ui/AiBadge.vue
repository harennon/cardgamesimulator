<template>
  <span class="ai-badge">
    <span class="ai-badge__dot" aria-hidden="true"></span>
    <span>CPU</span>
  </span>
</template>

<style scoped>
@import "@/styles/game-variables.css";

.ai-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: var(--font-ui);
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ai-accent);
  flex-shrink: 0;
}

.ai-badge__dot {
  width: 6px;
  height: 6px;
  border-radius: 2px;
  background: var(--ai-accent);
  flex-shrink: 0;
}
</style>
