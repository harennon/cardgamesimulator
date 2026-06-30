import { describe, it, expect } from "vitest";

// Component tests for OpponentRow.vue active-seat logic.
//
// LLD 105 (AC 2): at game over no opponent may be shown as "to act". The
// component's isActive(originalIndex) drives the gold border (.opponent--active),
// the pulsing .opponent__turn-indicator, and the OpponentTimer — all three are
// gated on isActive. When the optional gameOver prop is true, isActive must
// short-circuit to false for every seat, including the one at
// currentPlayerIndex.
//
// Following the project pattern (node environment, no DOM mount), the function
// below is an exact transcription of isActive() in OpponentRow.vue.

function isActive(
  originalIndex: number,
  currentPlayerIndex: number,
  gameOver = false,
): boolean {
  if (gameOver) return false;
  return originalIndex === currentPlayerIndex;
}

describe("OpponentRow — active-seat suppression at game over", () => {
  it("isActive returns false for the currentPlayerIndex seat when gameOver is true", () => {
    expect(isActive(2, 2, true)).toBe(false);
  });

  it("isActive returns false for every seat when gameOver is true", () => {
    const currentPlayerIndex = 1;
    for (let i = 0; i < 4; i++) {
      expect(isActive(i, currentPlayerIndex, true)).toBe(false);
    }
  });

  it("isActive returns true for the currentPlayerIndex seat when gameOver is false", () => {
    expect(isActive(2, 2, false)).toBe(true);
  });

  it("isActive returns false for non-current seats when gameOver is false", () => {
    expect(isActive(0, 2, false)).toBe(false);
    expect(isActive(3, 2, false)).toBe(false);
  });

  it("defaults to live behaviour when the gameOver prop is omitted", () => {
    // withDefaults gives gameOver a false default, so the currentPlayerIndex
    // seat is still active when the prop is not passed.
    expect(isActive(1, 1)).toBe(true);
    expect(isActive(0, 1)).toBe(false);
  });
});
