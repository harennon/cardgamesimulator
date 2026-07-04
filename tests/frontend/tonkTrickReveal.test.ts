import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, computed, watch, nextTick } from "vue";
import type { PlayerPublicInfo } from "../../src/shared/engine-types.js";
import type { TonkTrickResult } from "../../src/shared/tonk-types.js";
import {
  trickRevealRows,
  shouldEnterTrickReveal,
} from "../../src/frontend/component/game-ui/tonkDisplay.js";

// ---------------------------------------------------------------------------
// LLD 146 — trick-reveal detection logic and GameView phase-wiring tests.
// These tests mirror the extraction pattern from gameOverTransition.test.ts:
// we replicate the load-bearing logic from GameView.vue as pure functions/refs
// and test them in isolation (no DOM mount, node env).
// ---------------------------------------------------------------------------

type DisplayPhase =
  | "CREATED"
  | "IN_PROGRESS"
  | "SHOW_FINAL_PLAY"
  | "SHOW_TRICK_RESULT"
  | "COMPLETED";

function makeTrickResult(
  trickNumber = 1,
  overrides: Partial<TonkTrickResult> = {},
): TonkTrickResult {
  return {
    trickNumber,
    reason: "tonk",
    tonkCallerIndex: 0,
    revealedHands: [
      [{ rank: "3", suit: "clubs" }],
      [{ rank: "K", suit: "spades" }],
    ],
    handValues: [3, 10],
    tallyDeltas: [0, 10],
    ...overrides,
  };
}

function makePlayers(): PlayerPublicInfo[] {
  return [
    { playerId: "p0", displayName: "Alice", cardCount: 1, isConnected: true },
    { playerId: "p1", displayName: "Bob", cardCount: 1, isConnected: true },
  ];
}

// ---------------------------------------------------------------------------
// A. shouldEnterTrickReveal edge-case coverage (via the exported pure function)
// ---------------------------------------------------------------------------

describe("shouldEnterTrickReveal — pure predicate (LLD 146)", () => {
  it("returns true for a new trickNumber while IN_PROGRESS", () => {
    expect(shouldEnterTrickReveal(2, 1, "IN_PROGRESS")).toBe(true);
  });

  it("returns false when trickNumber equals lastRevealedTrickNumber (E6 idempotent)", () => {
    expect(shouldEnterTrickReveal(2, 2, "IN_PROGRESS")).toBe(false);
  });

  it("returns false when status is COMPLETED (E5 — match end supersedes)", () => {
    expect(shouldEnterTrickReveal(2, 1, "COMPLETED")).toBe(false);
  });

  it("returns false when latestTrickNumber is null (mid-round, no trick ended)", () => {
    expect(shouldEnterTrickReveal(null, null, "IN_PROGRESS")).toBe(false);
  });

  it("returns false when lastRevealedTrickNumber matches the current result (E4 seeded join)", () => {
    expect(shouldEnterTrickReveal(1, 1, "IN_PROGRESS")).toBe(false);
  });

  it("returns true for a newer trickNumber (E7 — re-arm while revealing)", () => {
    expect(shouldEnterTrickReveal(3, 2, "IN_PROGRESS")).toBe(true);
  });

  it("returns true when lastRevealedTrickNumber is null and a trick has ended", () => {
    expect(shouldEnterTrickReveal(1, null, "IN_PROGRESS")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. GameView phase-wiring: extracted replica of the detection + reveal logic
// ---------------------------------------------------------------------------

const REVEAL_DURATION_MS = 6000;

/**
 * Replicates the trick-reveal detection logic from GameView.vue.
 * Returns reactive state and control functions for testing transitions.
 */
function createRevealLogic(initialStatus: string) {
  const effectiveStatus = ref(initialStatus);
  const displayPhase = ref<DisplayPhase>("IN_PROGRESS");
  const lastRevealedTrickNumber = ref<number | null>(null);
  let trickRevealInitialized = false;
  let revealTimer: ReturnType<typeof setTimeout> | null = null;

  // The latest trick-result is injected via latestTrickResult ref (simulates the
  // computed that scans tonkState.log in the real component).
  const latestTrickResult = ref<TonkTrickResult | null>(null);

  function enterTrickReveal(): void {
    if (revealTimer !== null) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
    displayPhase.value = "SHOW_TRICK_RESULT";
    revealTimer = setTimeout(() => {
      dismissTrickReveal();
    }, REVEAL_DURATION_MS);
  }

  function dismissTrickReveal(): void {
    if (revealTimer !== null) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
    if (displayPhase.value === "SHOW_TRICK_RESULT") {
      displayPhase.value = "IN_PROGRESS";
    }
  }

  // status watcher — mirrors GameView effectiveStatus watcher
  watch(effectiveStatus, (newStatus) => {
    if (newStatus === "COMPLETED") {
      if (revealTimer !== null) {
        clearTimeout(revealTimer);
        revealTimer = null;
      }
      displayPhase.value = "COMPLETED";
    } else if (newStatus === "IN_PROGRESS") {
      displayPhase.value = "IN_PROGRESS";
    }
  });

  // trick-result detection watcher — mirrors GameView latestTrickResult watcher
  watch(latestTrickResult, (newResult) => {
    if (!trickRevealInitialized) {
      trickRevealInitialized = true;
      lastRevealedTrickNumber.value = newResult?.trickNumber ?? null;
      return;
    }
    if (
      shouldEnterTrickReveal(
        newResult?.trickNumber ?? null,
        lastRevealedTrickNumber.value,
        effectiveStatus.value,
      )
    ) {
      lastRevealedTrickNumber.value = newResult!.trickNumber;
      enterTrickReveal();
    }
  });

  function unmount(): void {
    if (revealTimer !== null) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
  }

  return {
    effectiveStatus,
    displayPhase,
    latestTrickResult,
    lastRevealedTrickNumber,
    enterTrickReveal,
    dismissTrickReveal,
    unmount,
  };
}

describe("GameView trick-reveal phase wiring (LLD 146)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a new Tonk trickResult while IN_PROGRESS sets displayPhase to SHOW_TRICK_RESULT", async () => {
    const logic = createRevealLogic("IN_PROGRESS");

    // First state received — seeds lastRevealedTrickNumber (no reveal)
    logic.latestTrickResult.value = makeTrickResult(1);
    await nextTick();
    expect(logic.displayPhase.value).toBe("IN_PROGRESS");

    // Second state with a NEW trickNumber — triggers reveal
    logic.latestTrickResult.value = makeTrickResult(2);
    await nextTick();
    expect(logic.displayPhase.value).toBe("SHOW_TRICK_RESULT");
  });

  it("Continue tap (dismissTrickReveal) returns to IN_PROGRESS and clears the timer", async () => {
    const logic = createRevealLogic("IN_PROGRESS");

    logic.latestTrickResult.value = makeTrickResult(1);
    await nextTick();
    logic.latestTrickResult.value = makeTrickResult(2);
    await nextTick();
    expect(logic.displayPhase.value).toBe("SHOW_TRICK_RESULT");

    logic.dismissTrickReveal();
    expect(logic.displayPhase.value).toBe("IN_PROGRESS");

    // Timer must be cleared — advancing time must not re-trigger anything
    vi.advanceTimersByTime(REVEAL_DURATION_MS + 1000);
    expect(logic.displayPhase.value).toBe("IN_PROGRESS");
  });

  it("auto-dismiss: after REVEAL_DURATION_MS the phase returns to IN_PROGRESS", async () => {
    const logic = createRevealLogic("IN_PROGRESS");

    logic.latestTrickResult.value = makeTrickResult(1);
    await nextTick();
    logic.latestTrickResult.value = makeTrickResult(2);
    await nextTick();
    expect(logic.displayPhase.value).toBe("SHOW_TRICK_RESULT");

    vi.advanceTimersByTime(REVEAL_DURATION_MS);
    expect(logic.displayPhase.value).toBe("IN_PROGRESS");
  });

  it("status COMPLETED with trickResult present routes to COMPLETED, never SHOW_TRICK_RESULT (E5)", async () => {
    const logic = createRevealLogic("IN_PROGRESS");

    // Seed first state
    logic.latestTrickResult.value = makeTrickResult(1);
    await nextTick();

    // Match-ending update: status goes COMPLETED with a new trickResult in the same tick
    logic.effectiveStatus.value = "COMPLETED";
    logic.latestTrickResult.value = makeTrickResult(2);
    await nextTick();

    expect(logic.displayPhase.value).toBe("COMPLETED");
    expect(logic.displayPhase.value).not.toBe("SHOW_TRICK_RESULT");
  });

  it("Big2 SHOW_FINAL_PLAY path is not affected (regression)", async () => {
    // Big2 has no latestTrickResult; SHOW_TRICK_RESULT is never entered.
    // We simulate Big2 by never setting latestTrickResult — only the
    // effectiveStatus COMPLETED transition fires (which in the real component
    // routes big2 to SHOW_FINAL_PLAY via a separate watcher). Here we only
    // assert that the trick-reveal watcher does nothing when no trickResult arrives.
    const logic = createRevealLogic("IN_PROGRESS");
    // Never set latestTrickResult
    await nextTick();
    expect(logic.displayPhase.value).toBe("IN_PROGRESS");
    expect(logic.displayPhase.value).not.toBe("SHOW_TRICK_RESULT");
  });

  it("first state after join seeds lastRevealedTrickNumber, no spurious reveal (E4)", async () => {
    const logic = createRevealLogic("IN_PROGRESS");

    // First state: trick 3 already in log (rejoining mid-game)
    logic.latestTrickResult.value = makeTrickResult(3);
    await nextTick();

    // No reveal — it was seeded, not new
    expect(logic.displayPhase.value).toBe("IN_PROGRESS");
    expect(logic.lastRevealedTrickNumber.value).toBe(3);
  });

  it("same trickNumber arriving again does not re-enter reveal (E6 idempotent)", async () => {
    const logic = createRevealLogic("IN_PROGRESS");

    logic.latestTrickResult.value = makeTrickResult(1);
    await nextTick();
    logic.latestTrickResult.value = makeTrickResult(2);
    await nextTick();
    expect(logic.displayPhase.value).toBe("SHOW_TRICK_RESULT");

    // Dismiss, then same trickNumber arrives again
    logic.dismissTrickReveal();
    expect(logic.displayPhase.value).toBe("IN_PROGRESS");

    logic.latestTrickResult.value = makeTrickResult(2);
    await nextTick();
    expect(logic.displayPhase.value).toBe("IN_PROGRESS");
  });

  it("newer trickNumber while already revealing re-arms for the newest (E7)", async () => {
    const logic = createRevealLogic("IN_PROGRESS");

    logic.latestTrickResult.value = makeTrickResult(1);
    await nextTick();
    logic.latestTrickResult.value = makeTrickResult(2);
    await nextTick();
    expect(logic.displayPhase.value).toBe("SHOW_TRICK_RESULT");

    // Another round passes while this client is still revealing
    logic.latestTrickResult.value = makeTrickResult(3);
    await nextTick();
    expect(logic.displayPhase.value).toBe("SHOW_TRICK_RESULT");
    expect(logic.lastRevealedTrickNumber.value).toBe(3);
  });

  it("onUnmounted clears revealTimer — no callback fires after unmount", async () => {
    const logic = createRevealLogic("IN_PROGRESS");

    logic.latestTrickResult.value = makeTrickResult(1);
    await nextTick();
    logic.latestTrickResult.value = makeTrickResult(2);
    await nextTick();
    expect(logic.displayPhase.value).toBe("SHOW_TRICK_RESULT");

    logic.unmount();
    vi.advanceTimersByTime(REVEAL_DURATION_MS + 1000);
    // Phase must not change after unmount
    expect(logic.displayPhase.value).toBe("SHOW_TRICK_RESULT");
  });
});

// ---------------------------------------------------------------------------
// C. TonkTrickReveal component — logic derived from props (no DOM mount)
// ---------------------------------------------------------------------------

describe("TonkTrickReveal derived rows (LLD 146)", () => {
  it("produces one row per player for a 3-seat game", () => {
    const result = makeTrickResult(1);
    const rows = trickRevealRows(result, makePlayers(), [42, 65], 0);
    expect(rows).toHaveLength(2);
  });

  it("caller row has isCaller true (TONK end)", () => {
    const result = makeTrickResult(1, { tonkCallerIndex: 0 });
    const rows = trickRevealRows(result, makePlayers(), [0, 0], -1);
    expect(rows.find((r) => r.seatIndex === 0)!.isCaller).toBe(true);
  });

  it("no caller row on stock-out", () => {
    const result = makeTrickResult(1, {
      reason: "stockout",
      tonkCallerIndex: null,
    });
    const rows = trickRevealRows(result, makePlayers(), [0, 0], -1);
    expect(rows.every((r) => !r.isCaller)).toBe(true);
  });

  it("best (lowest handValue) row has isBest true (delta--best styling)", () => {
    const result = makeTrickResult(1, {
      handValues: [3, 10],
      tallyDeltas: [0, 10],
    });
    const rows = trickRevealRows(result, makePlayers(), [0, 0], -1);
    const best = rows.find((r) => r.isBest);
    expect(best?.seatIndex).toBe(0);
    expect(best?.handValue).toBe(3);
  });

  it("non-best rows do not have isBest (delta--penalty styling)", () => {
    const result = makeTrickResult(1, { handValues: [3, 10] });
    const rows = trickRevealRows(result, makePlayers(), [0, 0], -1);
    expect(rows.find((r) => r.seatIndex === 1)!.isBest).toBe(false);
  });

  it("myPlayerIndex row has isSelf true", () => {
    const result = makeTrickResult(1);
    const rows = trickRevealRows(result, makePlayers(), [0, 0], 1);
    expect(rows.find((r) => r.seatIndex === 1)!.isSelf).toBe(true);
  });

  it("8-seat game: produces 8 rows", () => {
    const p8 = Array.from({ length: 8 }, (_, i) => ({
      playerId: `p${i}`,
      displayName: `P${i}`,
      cardCount: 5,
      isConnected: true,
    }));
    const r8: TonkTrickResult = {
      trickNumber: 1,
      reason: "stockout",
      tonkCallerIndex: null,
      revealedHands: Array.from({ length: 8 }, () => []),
      handValues: new Array(8).fill(10),
      tallyDeltas: new Array(8).fill(10),
    };
    const rows = trickRevealRows(r8, p8, new Array(8).fill(0), -1);
    expect(rows).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// D. toFeedbackPhase: SHOW_TRICK_RESULT maps to "in-progress" (LLD 146)
// ---------------------------------------------------------------------------

function toFeedbackPhase(
  phase: DisplayPhase,
): "lobby" | "in-progress" | "game-over" {
  switch (phase) {
    case "CREATED":
      return "lobby";
    case "COMPLETED":
      return "game-over";
    case "IN_PROGRESS":
    case "SHOW_FINAL_PLAY":
    case "SHOW_TRICK_RESULT":
      return "in-progress";
  }
}

describe("toFeedbackPhase — SHOW_TRICK_RESULT (LLD 146)", () => {
  it("SHOW_TRICK_RESULT maps to 'in-progress'", () => {
    expect(toFeedbackPhase("SHOW_TRICK_RESULT")).toBe("in-progress");
  });

  it("existing phases are unaffected (regression)", () => {
    expect(toFeedbackPhase("CREATED")).toBe("lobby");
    expect(toFeedbackPhase("IN_PROGRESS")).toBe("in-progress");
    expect(toFeedbackPhase("SHOW_FINAL_PLAY")).toBe("in-progress");
    expect(toFeedbackPhase("COMPLETED")).toBe("game-over");
  });
});
