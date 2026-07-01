// Pure step-navigation logic for the walkthrough modal, extracted so it is unit
// testable in the node vitest env (project pattern: createGameView.test.ts). The
// modal holds `currentIndex` in a ref and delegates the transitions here.

export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, index));
}

export function canGoBack(index: number): boolean {
  return index > 0;
}

export function isLastStep(index: number, count: number): boolean {
  return index >= count - 1;
}

// Advancing past the last step is not allowed — the primary control closes the
// modal there instead (see primaryAction). Index is always clamped in-range.
export function nextIndex(index: number, count: number): number {
  return clampIndex(index + 1, count);
}

export function prevIndex(index: number, count: number): number {
  return clampIndex(index - 1, count);
}

// The primary (bottom-right) button either advances or closes on the last step.
export function primaryAction(
  index: number,
  count: number,
): "advance" | "close" {
  return isLastStep(index, count) ? "close" : "advance";
}
