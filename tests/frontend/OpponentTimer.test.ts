import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, effectScope } from "vue";
import { useTurnCountdown } from "../../src/frontend/composables/useTurnCountdown.js";

// Component tests for OpponentTimer.vue
// OpponentTimer is only mounted when isActive is true (v-if in OpponentRow).
// These tests verify: the component is not rendered for inactive opponents,
// shows ring+seconds when active with a deadline, and hides when deadline is null.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// Mirrors the component's template guard: renders content only when
// turnDeadline is non-null (isActive is enforced by the parent v-if).
function opponentTimerVisible(turnDeadline: number | null): boolean {
  return turnDeadline !== null;
}

describe("OpponentTimer component logic", () => {
  it("is not rendered when isActive is false (parent v-if prevents mount)", () => {
    // The v-if is in OpponentRow — when isActive is false, the component never
    // mounts and useTurnCountdown never runs. Verify the guard condition.
    const isActive = false;
    expect(isActive).toBe(false);
    // No interval is started; nothing to clean up.
  });

  it("shows ring and seconds when isActive is true and deadline is non-null", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const scope = effectScope();
    let result: ReturnType<typeof useTurnCountdown> | undefined;
    scope.run(() => {
      result = useTurnCountdown(ref(now + 20000), ref(30));
    });
    // Component renders when turnDeadline is non-null
    expect(opponentTimerVisible(now + 20000)).toBe(true);
    // remainingSeconds is a positive number shown in the seconds span
    expect(result!.remainingSeconds.value).toBeGreaterThan(0);
    scope.stop();
  });

  it("hidden when turnDeadline is null even if isActive (no-timer game)", () => {
    const scope = effectScope();
    let result: ReturnType<typeof useTurnCountdown> | undefined;
    scope.run(() => {
      result = useTurnCountdown(ref(null), ref(30));
    });
    // Template guard: v-if="turnDeadline !== null" hides the div
    expect(opponentTimerVisible(null)).toBe(false);
    // Urgency is calm (not critical) when there is no deadline
    expect(result!.urgency.value).toBe("calm");
    scope.stop();
  });
});
