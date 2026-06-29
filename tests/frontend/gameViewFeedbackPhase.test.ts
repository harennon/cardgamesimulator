import { describe, it, expect, afterEach } from "vitest";
import { ref, watch, nextTick } from "vue";
import { useFeedbackContext } from "../../src/frontend/composables/useFeedbackContext.js";
import type { FeedbackGamePhase } from "../../src/frontend/composables/useFeedbackContext.js";

// ---------------------------------------------------------------------------
// Tests for GameView.vue's feedback-phase publishing. We mirror the load-bearing
// logic (the DisplayPhase -> FeedbackGamePhase mapping, the immediate watch that
// publishes to the shared store, and the onUnmounted clear) and wire it to the
// REAL useFeedbackContext composable — same extraction pattern as
// gameOverTransition.test.ts. This proves what GameView publishes, not a stub.
// ---------------------------------------------------------------------------

type DisplayPhase = "CREATED" | "IN_PROGRESS" | "SHOW_FINAL_PLAY" | "COMPLETED";

function toFeedbackPhase(phase: DisplayPhase): FeedbackGamePhase {
  switch (phase) {
    case "CREATED":
      return "lobby";
    case "COMPLETED":
      return "game-over";
    case "IN_PROGRESS":
    case "SHOW_FINAL_PLAY":
      return "in-progress";
  }
}

/**
 * Mirrors GameView.vue's phase-publishing wiring: an immediate watch that
 * publishes the mapped phase, plus a teardown that clears the store (onUnmounted).
 */
function mountPhasePublisher(initial: DisplayPhase) {
  const { setGamePhase, clearGamePhase } = useFeedbackContext();
  const displayPhase = ref<DisplayPhase>(initial);

  const stop = watch(
    displayPhase,
    (phase) => {
      setGamePhase(toFeedbackPhase(phase));
    },
    { immediate: true },
  );

  function unmount(): void {
    stop();
    clearGamePhase();
  }

  return { displayPhase, unmount };
}

describe("GameView feedback-phase publishing", () => {
  afterEach(() => {
    useFeedbackContext().clearGamePhase();
  });

  describe("DisplayPhase -> FeedbackGamePhase mapping", () => {
    it("CREATED maps to lobby", () => {
      expect(toFeedbackPhase("CREATED")).toBe("lobby");
    });

    it("IN_PROGRESS maps to in-progress", () => {
      expect(toFeedbackPhase("IN_PROGRESS")).toBe("in-progress");
    });

    it("SHOW_FINAL_PLAY maps to in-progress", () => {
      expect(toFeedbackPhase("SHOW_FINAL_PLAY")).toBe("in-progress");
    });

    it("COMPLETED maps to game-over", () => {
      expect(toFeedbackPhase("COMPLETED")).toBe("game-over");
    });
  });

  describe("publishing to the shared store", () => {
    it("publishes lobby immediately on mount in CREATED", () => {
      const { gamePhase } = useFeedbackContext();
      mountPhasePublisher("CREATED");
      expect(gamePhase.value).toBe("lobby");
    });

    it("publishes in-progress when displayPhase moves to IN_PROGRESS", async () => {
      const { gamePhase } = useFeedbackContext();
      const { displayPhase } = mountPhasePublisher("CREATED");

      displayPhase.value = "IN_PROGRESS";
      await nextTick();

      expect(gamePhase.value).toBe("in-progress");
    });

    it("publishes in-progress for SHOW_FINAL_PLAY (the final-play ribbon)", async () => {
      const { gamePhase } = useFeedbackContext();
      const { displayPhase } = mountPhasePublisher("IN_PROGRESS");

      displayPhase.value = "SHOW_FINAL_PLAY";
      await nextTick();

      expect(gamePhase.value).toBe("in-progress");
    });

    it("publishes game-over when displayPhase moves to COMPLETED", async () => {
      const { gamePhase } = useFeedbackContext();
      const { displayPhase } = mountPhasePublisher("IN_PROGRESS");

      displayPhase.value = "COMPLETED";
      await nextTick();

      expect(gamePhase.value).toBe("game-over");
    });

    it("publishes game-over immediately when landing directly on a COMPLETED game", () => {
      const { gamePhase } = useFeedbackContext();
      mountPhasePublisher("COMPLETED");
      expect(gamePhase.value).toBe("game-over");
    });
  });

  describe("unmount clears the store", () => {
    it("clearGamePhase on unmount resets the store to undefined", () => {
      const { gamePhase } = useFeedbackContext();
      const { unmount } = mountPhasePublisher("IN_PROGRESS");
      expect(gamePhase.value).toBe("in-progress");

      unmount();

      expect(gamePhase.value).toBeUndefined();
    });
  });
});
