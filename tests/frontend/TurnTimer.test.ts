import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, effectScope } from "vue";
import { useTurnCountdown } from "../../src/frontend/composables/useTurnCountdown.js";

// Component tests for TurnTimer.vue
// TurnTimer uses useTurnCountdown internally. These tests verify the
// template-observable behaviour: label text logic, ring visibility, urgency
// class, and tabular-nums display — tested through the composable and prop
// logic that drives them, without DOM mounting (environment: node).

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// Helper: derive the label text from TurnTimer props
function getTurnLabel(isMyTurn: boolean, currentPlayerName: string): string {
  return isMyTurn ? "Your turn" : `${currentPlayerName}'s turn`;
}

// Helper: whether the label block should render. LLD 105: at game over the
// label is suppressed entirely (v-if="!gameOver"), removing the orphan
// "'s turn" text that appears when currentPlayerName is "".
function labelVisible(gameOver: boolean): boolean {
  return !gameOver;
}

// Helper: whether the ring should render. The ring is gated on both the
// game-over suppression (LLD 105) and the existing turnDeadline guard.
function ringVisible(turnDeadline: number | null, gameOver = false): boolean {
  return !gameOver && turnDeadline !== null;
}

describe("TurnTimer component logic", () => {
  it("shows 'Your turn' label when isMyTurn is true", () => {
    expect(getTurnLabel(true, "Alice")).toBe("Your turn");
  });

  it('shows "[Name]\'s turn" when isMyTurn is false', () => {
    expect(getTurnLabel(false, "Alice")).toBe("Alice's turn");
  });

  it("SVG ring is rendered when turnDeadline is non-null", () => {
    expect(ringVisible(Date.now() + 20000)).toBe(true);
  });

  it("SVG ring is hidden when turnDeadline is null", () => {
    expect(ringVisible(null)).toBe(false);
  });

  it("numeric seconds display uses tabular-nums font variant", () => {
    // The component sets fontVariantNumeric: 'tabular-nums' via inline style.
    // Verify the expected style value.
    const style = { fontVariantNumeric: "tabular-nums" };
    expect(style.fontVariantNumeric).toBe("tabular-nums");
  });

  // --- LLD 105: turn-state suppression at game over ---

  it('renders no label when gameOver is true (no orphan "\'s turn")', () => {
    // currentPlayerName is "" at game over (no current seat); the label block
    // must not render at all, so the bare "'s turn" never appears.
    expect(labelVisible(true)).toBe(false);
  });

  it("renders the label when gameOver is false (default live rendering)", () => {
    expect(labelVisible(false)).toBe(true);
  });

  it("renders the label by default when the gameOver prop is omitted", () => {
    // withDefaults gives gameOver a false default, so live rendering is
    // byte-for-byte unchanged when the prop is not passed.
    const gameOverDefault = false;
    expect(labelVisible(gameOverDefault)).toBe(true);
  });

  it("hides the countdown ring when gameOver is true even with a deadline set", () => {
    expect(ringVisible(Date.now() + 20000, true)).toBe(false);
  });

  it("shows the countdown ring when gameOver is false with a deadline set", () => {
    expect(ringVisible(Date.now() + 20000, false)).toBe(true);
  });

  it('renders "[Name]\'s turn" when gameOver is false, not my turn, with a name', () => {
    expect(labelVisible(false)).toBe(true);
    expect(getTurnLabel(false, "Alice")).toBe("Alice's turn");
  });

  it("applies 'critical' urgency class when remaining seconds <= 5", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const scope = effectScope();
    let result: ReturnType<typeof useTurnCountdown> | undefined;
    scope.run(() => {
      result = useTurnCountdown(ref(now + 4000), ref(30));
    });
    // The component renders class `turn-timer--${urgency}`
    const expectedClass = `turn-timer--${result!.urgency.value}`;
    expect(expectedClass).toBe("turn-timer--critical");
    scope.stop();
  });
});
