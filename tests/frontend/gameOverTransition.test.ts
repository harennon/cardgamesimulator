import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, watch, nextTick } from "vue";

// ---------------------------------------------------------------------------
// Tests for the display phase transition logic in GameView.vue.
// We extract the logic as pure functions/refs to test without mounting the
// full component (follows project pattern of testing logic directly).
//
// LLD 73: SHOW_FINAL_PLAY no longer auto-advances on a timer. The only exit is
// the user clicking "Continue to Results" (skipToResults). There is no timer to
// schedule, clear, or leak.
// ---------------------------------------------------------------------------

type DisplayPhase = "CREATED" | "IN_PROGRESS" | "SHOW_FINAL_PLAY" | "COMPLETED";

/**
 * Replicates the display phase logic from GameView.vue in isolation.
 * Returns refs and functions for testing state transitions.
 */
function createDisplayPhaseLogic(initialEffectiveStatus: string | null) {
  const effectiveStatus = ref(initialEffectiveStatus);
  const displayPhase = ref<DisplayPhase>(
    mapStatusToInitialPhase(initialEffectiveStatus),
  );

  function mapStatusToInitialPhase(status: string | null): DisplayPhase {
    if (status === "IN_PROGRESS") return "IN_PROGRESS";
    if (status === "COMPLETED") return "COMPLETED";
    return "CREATED";
  }

  watch(effectiveStatus, (newStatus, oldStatus) => {
    if (newStatus === "COMPLETED" && oldStatus === "IN_PROGRESS") {
      displayPhase.value = "SHOW_FINAL_PLAY";
    } else if (newStatus === "COMPLETED") {
      displayPhase.value = "COMPLETED";
    } else if (newStatus === "IN_PROGRESS") {
      displayPhase.value = "IN_PROGRESS";
    } else if (newStatus === "CREATED") {
      displayPhase.value = "CREATED";
    }
  });

  function skipToResults(): void {
    displayPhase.value = "COMPLETED";
  }

  return {
    effectiveStatus,
    displayPhase,
    skipToResults,
  };
}

describe("GameView display phase transition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("status IN_PROGRESS -> COMPLETED sets displayPhase to SHOW_FINAL_PLAY", async () => {
    const { effectiveStatus, displayPhase } =
      createDisplayPhaseLogic("IN_PROGRESS");

    effectiveStatus.value = "COMPLETED";
    await nextTick();

    expect(displayPhase.value).toBe("SHOW_FINAL_PLAY");
  });

  it("SHOW_FINAL_PLAY does NOT auto-advance over time (no timer)", async () => {
    const { effectiveStatus, displayPhase } =
      createDisplayPhaseLogic("IN_PROGRESS");

    effectiveStatus.value = "COMPLETED";
    await nextTick();
    expect(displayPhase.value).toBe("SHOW_FINAL_PLAY");

    // Advancing well past the old 4000ms timeout must not change the phase —
    // there is no longer any scheduled auto-advance.
    vi.advanceTimersByTime(60_000);
    expect(displayPhase.value).toBe("SHOW_FINAL_PLAY");
  });

  it("calling skipToResults from SHOW_FINAL_PLAY sets displayPhase to COMPLETED", async () => {
    const { effectiveStatus, displayPhase, skipToResults } =
      createDisplayPhaseLogic("IN_PROGRESS");

    effectiveStatus.value = "COMPLETED";
    await nextTick();
    expect(displayPhase.value).toBe("SHOW_FINAL_PLAY");

    skipToResults();
    expect(displayPhase.value).toBe("COMPLETED");
  });

  it("status starts as COMPLETED (reconnect) sets displayPhase to COMPLETED directly", async () => {
    // Simulate joining an already-completed game
    const { effectiveStatus, displayPhase } = createDisplayPhaseLogic(null);

    // Status goes directly to COMPLETED without passing through IN_PROGRESS
    effectiveStatus.value = "COMPLETED";
    await nextTick();

    expect(displayPhase.value).toBe("COMPLETED");
  });

  it("status CREATED -> IN_PROGRESS sets displayPhase to IN_PROGRESS", async () => {
    const { effectiveStatus, displayPhase } =
      createDisplayPhaseLogic("CREATED");

    effectiveStatus.value = "IN_PROGRESS";
    await nextTick();

    expect(displayPhase.value).toBe("IN_PROGRESS");
  });

  it("status goes from null to COMPLETED -> COMPLETED directly (no reveal phase)", async () => {
    const { effectiveStatus, displayPhase } = createDisplayPhaseLogic(null);

    effectiveStatus.value = "COMPLETED";
    await nextTick();

    expect(displayPhase.value).toBe("COMPLETED");
  });

  it("status goes from CREATED to COMPLETED -> COMPLETED directly (no reveal phase)", async () => {
    const { effectiveStatus, displayPhase } =
      createDisplayPhaseLogic("CREATED");

    effectiveStatus.value = "COMPLETED";
    await nextTick();

    expect(displayPhase.value).toBe("COMPLETED");
  });
});
