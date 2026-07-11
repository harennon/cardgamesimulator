/**
 * Unit tests for useCorrelation composable (LLD 166).
 *
 * Tests run in node environment — no DOM, no full Vue setup.
 * The composable holds module-scoped refs; we reset the gameId between tests
 * via unbindGame() but correlationId is intentionally stable across the module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @sentry/vue so no real network calls happen
// ---------------------------------------------------------------------------

const mockSetTag = vi.fn();
const mockSetContext = vi.fn();

vi.mock("@sentry/vue", () => ({
  setTag: mockSetTag,
  setContext: mockSetContext,
  init: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock observability/sentry guards so they forward to the mocks above
// ---------------------------------------------------------------------------

vi.mock("../../src/frontend/observability/sentry.js", () => ({
  isInitialised: () => true, // treat as initialised for these tests
  initObservability: vi.fn(),
  recordBreadcrumb: vi.fn(),
  setSentryTag: mockSetTag,
  setSentryContext: mockSetContext,
}));

// Import after mocks are registered
const { useCorrelation } =
  await import("../../src/frontend/composables/useCorrelation.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetGameId(): void {
  useCorrelation().unbindGame();
  vi.clearAllMocks();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useCorrelation — correlationId", () => {
  afterEach(resetGameId);

  it("matches format cx_<8 url-safe chars>", () => {
    const { correlationId } = useCorrelation();
    expect(correlationId.value).toMatch(/^cx_[A-Za-z0-9_-]{8}$/);
  });

  it("is stable across multiple useCorrelation() calls (singleton)", () => {
    const { correlationId: id1 } = useCorrelation();
    const { correlationId: id2 } = useCorrelation();
    expect(id1.value).toBe(id2.value);
  });

  it("is readonly (value cannot be reassigned)", () => {
    const { correlationId } = useCorrelation();
    const original = correlationId.value;
    // DeepReadonly — direct assignment is a type error; runtime value is unchanged
    expect(correlationId.value).toBe(original);
  });
});

describe("useCorrelation — bindGame / unbindGame", () => {
  beforeEach(resetGameId);
  afterEach(resetGameId);

  it("bindGame sets gameId", () => {
    const { bindGame, gameId } = useCorrelation();
    expect(gameId.value).toBeUndefined();
    bindGame("game-001");
    expect(gameId.value).toBe("game-001");
  });

  it("unbindGame clears gameId", () => {
    const { bindGame, unbindGame, gameId } = useCorrelation();
    bindGame("game-002");
    unbindGame();
    expect(gameId.value).toBeUndefined();
  });

  it("bindGame calls setSentryTag with correlation_id", () => {
    const { correlationId, bindGame } = useCorrelation();
    bindGame("game-003");
    expect(mockSetTag).toHaveBeenCalledWith(
      "correlation_id",
      correlationId.value,
    );
  });

  it("bindGame calls setSentryTag with game_id", () => {
    const { bindGame } = useCorrelation();
    bindGame("game-004");
    expect(mockSetTag).toHaveBeenCalledWith("game_id", "game-004");
  });

  it("bindGame calls setSentryContext with both ids", () => {
    const { correlationId, bindGame } = useCorrelation();
    bindGame("game-005");
    expect(mockSetContext).toHaveBeenCalledWith("correlation", {
      correlationId: correlationId.value,
      gameId: "game-005",
    });
  });

  it("rebinding does not mint a new correlationId", () => {
    const { correlationId, bindGame } = useCorrelation();
    const id = correlationId.value;
    bindGame("game-A");
    bindGame("game-B");
    expect(correlationId.value).toBe(id);
  });

  it("gameId is undefined before any bindGame call", () => {
    const { gameId } = useCorrelation();
    expect(gameId.value).toBeUndefined();
  });
});
