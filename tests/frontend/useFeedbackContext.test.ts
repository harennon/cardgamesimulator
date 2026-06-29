import { describe, it, expect, afterEach } from "vitest";
import { useFeedbackContext } from "../../src/frontend/composables/useFeedbackContext.js";

// useFeedbackContext is backed by module-scoped reactive state (a deliberate
// singleton, unlike useGameState). Each test resets it so order does not matter.
describe("useFeedbackContext", () => {
  afterEach(() => {
    useFeedbackContext().clearGamePhase();
  });

  it("starts with an undefined gamePhase", () => {
    const { gamePhase } = useFeedbackContext();
    expect(gamePhase.value).toBeUndefined();
  });

  it("setGamePhase updates the shared ref", () => {
    const { gamePhase, setGamePhase } = useFeedbackContext();
    setGamePhase("in-progress");
    expect(gamePhase.value).toBe("in-progress");
  });

  it("a second reader observes a value set by the first (shared singleton, not per-call refs)", () => {
    const writer = useFeedbackContext();
    const reader = useFeedbackContext();

    writer.setGamePhase("game-over");

    expect(reader.gamePhase.value).toBe("game-over");
  });

  it("clearGamePhase resets the shared ref to undefined", () => {
    const { gamePhase, setGamePhase, clearGamePhase } = useFeedbackContext();
    setGamePhase("lobby");
    expect(gamePhase.value).toBe("lobby");

    clearGamePhase();
    expect(gamePhase.value).toBeUndefined();
  });

  it("returned gamePhase is read-only — direct mutation does not change the store", () => {
    const { gamePhase, setGamePhase } = useFeedbackContext();
    setGamePhase("lobby");

    // Vue readonly() warns and silently ignores writes rather than throwing.
    // @ts-expect-error — intentionally testing readonly enforcement
    gamePhase.value = "game-over";

    expect(gamePhase.value).toBe("lobby");
  });
});
