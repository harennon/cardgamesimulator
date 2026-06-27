import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, watch, nextTick } from "vue";

// ---------------------------------------------------------------------------
// Tests for the display phase transition logic in GameView.vue.
// We extract the logic as pure functions/refs to test without mounting the
// full component (follows project pattern of testing logic directly).
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
  const finalPlayTimerId = ref<ReturnType<typeof setTimeout> | null>(null);

  function mapStatusToInitialPhase(status: string | null): DisplayPhase {
    if (status === "IN_PROGRESS") return "IN_PROGRESS";
    if (status === "COMPLETED") return "COMPLETED";
    return "CREATED";
  }

  watch(effectiveStatus, (newStatus, oldStatus) => {
    if (newStatus === "COMPLETED" && oldStatus === "IN_PROGRESS") {
      displayPhase.value = "SHOW_FINAL_PLAY";
      finalPlayTimerId.value = setTimeout(() => {
        displayPhase.value = "COMPLETED";
        finalPlayTimerId.value = null;
      }, 4000);
    } else if (newStatus === "COMPLETED") {
      displayPhase.value = "COMPLETED";
    } else if (newStatus === "IN_PROGRESS") {
      displayPhase.value = "IN_PROGRESS";
    } else if (newStatus === "CREATED") {
      displayPhase.value = "CREATED";
    }
  });

  function skipToResults(): void {
    if (finalPlayTimerId.value) {
      clearTimeout(finalPlayTimerId.value);
      finalPlayTimerId.value = null;
    }
    displayPhase.value = "COMPLETED";
  }

  function cleanup(): void {
    if (finalPlayTimerId.value) {
      clearTimeout(finalPlayTimerId.value);
      finalPlayTimerId.value = null;
    }
  }

  return {
    effectiveStatus,
    displayPhase,
    finalPlayTimerId,
    skipToResults,
    cleanup,
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

  it("after 4000ms, displayPhase advances to COMPLETED", async () => {
    const { effectiveStatus, displayPhase } =
      createDisplayPhaseLogic("IN_PROGRESS");

    effectiveStatus.value = "COMPLETED";
    await nextTick();
    expect(displayPhase.value).toBe("SHOW_FINAL_PLAY");

    vi.advanceTimersByTime(4000);
    expect(displayPhase.value).toBe("COMPLETED");
  });

  it("calling skipToResults before timer fires sets displayPhase to COMPLETED immediately", async () => {
    const { effectiveStatus, displayPhase, skipToResults } =
      createDisplayPhaseLogic("IN_PROGRESS");

    effectiveStatus.value = "COMPLETED";
    await nextTick();
    expect(displayPhase.value).toBe("SHOW_FINAL_PLAY");

    skipToResults();
    expect(displayPhase.value).toBe("COMPLETED");
  });

  it("calling skipToResults clears the pending timer", async () => {
    const { effectiveStatus, displayPhase, finalPlayTimerId, skipToResults } =
      createDisplayPhaseLogic("IN_PROGRESS");

    effectiveStatus.value = "COMPLETED";
    await nextTick();
    expect(finalPlayTimerId.value).not.toBeNull();

    skipToResults();
    expect(finalPlayTimerId.value).toBeNull();

    // Advancing time should NOT change displayPhase since timer was cleared
    vi.advanceTimersByTime(4000);
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

  it("cleanup during SHOW_FINAL_PLAY clears timer", async () => {
    const { effectiveStatus, displayPhase, finalPlayTimerId, cleanup } =
      createDisplayPhaseLogic("IN_PROGRESS");

    effectiveStatus.value = "COMPLETED";
    await nextTick();
    expect(finalPlayTimerId.value).not.toBeNull();

    cleanup();
    expect(finalPlayTimerId.value).toBeNull();

    // Timer was cleared — displayPhase should remain SHOW_FINAL_PLAY
    vi.advanceTimersByTime(4000);
    expect(displayPhase.value).toBe("SHOW_FINAL_PLAY");
  });

  it("does not start timer when status goes from null to COMPLETED", async () => {
    const { effectiveStatus, displayPhase, finalPlayTimerId } =
      createDisplayPhaseLogic(null);

    effectiveStatus.value = "COMPLETED";
    await nextTick();

    expect(displayPhase.value).toBe("COMPLETED");
    expect(finalPlayTimerId.value).toBeNull();
  });

  it("does not start timer when status goes from CREATED to COMPLETED", async () => {
    const { effectiveStatus, displayPhase, finalPlayTimerId } =
      createDisplayPhaseLogic("CREATED");

    effectiveStatus.value = "COMPLETED";
    await nextTick();

    expect(displayPhase.value).toBe("COMPLETED");
    expect(finalPlayTimerId.value).toBeNull();
  });
});
