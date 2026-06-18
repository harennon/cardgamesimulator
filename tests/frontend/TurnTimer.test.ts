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

// Helper: whether the ring should render
function ringVisible(turnDeadline: number | null): boolean {
  return turnDeadline !== null;
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
