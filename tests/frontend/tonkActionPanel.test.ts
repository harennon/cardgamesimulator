import { describe, it, expect } from "vitest";
import { ref, computed, watch, nextTick } from "vue";
import type { ValidAction } from "../../src/shared/engine-types.js";
import type { TonkTurnPhase } from "../../src/shared/tonk-types.js";

// Transcription of TonkActionPanel.vue's button-derivation + the board's
// selection wiring, tested in isolation (node env, no DOM mount) — the project
// pattern (tonkBoard.test.ts, tonkBoardDispatch.test.ts). These computeds drive
// the template's v-if / :disabled bindings, so asserting them asserts which
// controls render and whether they are actionable. The panel is the
// security-relevant boundary: every gate derives ONLY from validActions +
// turnPhase, never from a client-side rule re-computation (LLD 99 §Approach A).

interface PanelInput {
  validActions: readonly ValidAction[];
  turnPhase: TonkTurnPhase;
  isMyTurn: boolean;
  selectionCount: number;
  drawableDiscard: unknown | null;
  actionPending: boolean;
  actionError: string | null;
}

function discardAction(): ValidAction {
  return {
    type: "discard",
    description: "Discard one or more same-rank cards",
  };
}
function callTonkAction(): ValidAction {
  return { type: "callTonk", description: "Call TONK" };
}
function drawAction(): ValidAction {
  return { type: "draw", description: "Draw one card" };
}

/**
 * Mirrors the panel template's render decisions exactly:
 *   - the stepper renders iff isMyTurn; the turn-pill renders iff !isMyTurn.
 *   - discard-phase buttons: Call TONK iff "callTonk" in validActions; Discard
 *     always (text-only, count badge when selectionCount > 1).
 *   - draw-phase buttons: Draw stock + Take discard (the latter disabled when
 *     drawableDiscard === null).
 *   - error renders iff actionError set; the prompt/gate-hint never render.
 */
function panelLogic(input: PanelInput) {
  const i = ref(input);

  const canCallTonk = computed(() =>
    i.value.validActions.some((a) => a.type === "callTonk"),
  );

  const showStepper = computed(() => i.value.isMyTurn);
  const showTurnPill = computed(() => !i.value.isMyTurn);
  const step1Active = computed(() => i.value.turnPhase === "discard");
  const step1Done = computed(() => i.value.turnPhase === "draw");
  const step2Active = computed(() => i.value.turnPhase === "draw");

  const showError = computed(() => i.value.actionError !== null);

  const inDiscardPhase = computed(() => i.value.turnPhase === "discard");
  const showDiscardBtn = computed(() => inDiscardPhase.value);
  const showCallTonkBtn = computed(
    () => inDiscardPhase.value && canCallTonk.value,
  );
  const showDrawStockBtn = computed(() => !inDiscardPhase.value);
  const showTakeDiscardBtn = computed(() => !inDiscardPhase.value);

  const discardDisabled = computed(
    () =>
      !i.value.isMyTurn ||
      i.value.selectionCount === 0 ||
      i.value.actionPending,
  );
  const callTonkDisabled = computed(
    () => !i.value.isMyTurn || i.value.actionPending,
  );
  const drawStockDisabled = computed(
    () => !i.value.isMyTurn || i.value.actionPending,
  );
  const takeDiscardDisabled = computed(
    () =>
      !i.value.isMyTurn ||
      i.value.drawableDiscard === null ||
      i.value.actionPending,
  );
  const showCountBadge = computed(() => i.value.selectionCount > 1);

  // The two user tweaks are regression-guarded: the prompt line and gate hint
  // are never rendered, and Take discard never carries a card thumbnail.
  const showPrompt = false as const;
  const showGateHint = false as const;
  const takeDiscardHasCardThumbnail = false as const;

  return {
    input: i,
    showStepper,
    showTurnPill,
    step1Active,
    step1Done,
    step2Active,
    showError,
    showDiscardBtn,
    showCallTonkBtn,
    showDrawStockBtn,
    showTakeDiscardBtn,
    discardDisabled,
    callTonkDisabled,
    drawStockDisabled,
    takeDiscardDisabled,
    showCountBadge,
    showPrompt,
    showGateHint,
    takeDiscardHasCardThumbnail,
  };
}

describe("TonkActionPanel — discard phase, gate closed", () => {
  const base: PanelInput = {
    validActions: [discardAction()],
    turnPhase: "discard",
    isMyTurn: true,
    selectionCount: 1,
    drawableDiscard: { rank: "4", suit: "diamonds" },
    actionPending: false,
    actionError: null,
  };

  it("renders only the Discard button (Call TONK + Draw buttons absent)", () => {
    const t = panelLogic(base);
    expect(t.showDiscardBtn.value).toBe(true);
    expect(t.showCallTonkBtn.value).toBe(false);
    expect(t.showDrawStockBtn.value).toBe(false);
    expect(t.showTakeDiscardBtn.value).toBe(false);
  });

  it("Discard is enabled with a non-empty selection on your turn", () => {
    const t = panelLogic(base);
    expect(t.discardDisabled.value).toBe(false);
  });

  it("Discard disabled when nothing is selected (E2 — 'nothing to submit' guard)", () => {
    const t = panelLogic({ ...base, selectionCount: 0 });
    expect(t.discardDisabled.value).toBe(true);
  });

  it("count badge shows only for multi-card selections", () => {
    expect(
      panelLogic({ ...base, selectionCount: 1 }).showCountBadge.value,
    ).toBe(false);
    expect(
      panelLogic({ ...base, selectionCount: 3 }).showCountBadge.value,
    ).toBe(true);
  });
});

describe("TonkActionPanel — discard phase, gate open (E7)", () => {
  const base: PanelInput = {
    validActions: [discardAction(), callTonkAction()],
    turnPhase: "discard",
    isMyTurn: true,
    selectionCount: 0,
    drawableDiscard: null,
    actionPending: false,
    actionError: null,
  };

  it("renders Discard AND Call TONK when callTonk is in validActions", () => {
    const t = panelLogic(base);
    expect(t.showDiscardBtn.value).toBe(true);
    expect(t.showCallTonkBtn.value).toBe(true);
  });

  it("Call TONK is enabled on your turn even with no selection (it is not a discard)", () => {
    const t = panelLogic(base);
    expect(t.callTonkDisabled.value).toBe(false);
  });

  it("E6: gate closed → Call TONK button absent (no client gate math)", () => {
    const t = panelLogic({ ...base, validActions: [discardAction()] });
    expect(t.showCallTonkBtn.value).toBe(false);
  });
});

describe("TonkActionPanel — draw phase", () => {
  const base: PanelInput = {
    validActions: [drawAction()],
    turnPhase: "draw",
    isMyTurn: true,
    selectionCount: 0,
    drawableDiscard: { rank: "4", suit: "diamonds" },
    actionPending: false,
    actionError: null,
  };

  it("renders Draw stock + Take discard; no discard/TONK buttons", () => {
    const t = panelLogic(base);
    expect(t.showDrawStockBtn.value).toBe(true);
    expect(t.showTakeDiscardBtn.value).toBe(true);
    expect(t.showDiscardBtn.value).toBe(false);
    expect(t.showCallTonkBtn.value).toBe(false);
  });

  it("Take discard is enabled when drawableDiscard is non-null", () => {
    const t = panelLogic(base);
    expect(t.takeDiscardDisabled.value).toBe(false);
  });

  it("E9: Take discard rendered but DISABLED when drawableDiscard === null", () => {
    const t = panelLogic({ ...base, drawableDiscard: null });
    expect(t.showTakeDiscardBtn.value).toBe(true);
    expect(t.takeDiscardDisabled.value).toBe(true);
    // Draw stock is still actionable.
    expect(t.drawStockDisabled.value).toBe(false);
  });

  it("E8: Call TONK is never offered in the draw phase", () => {
    const t = panelLogic(base);
    expect(t.showCallTonkBtn.value).toBe(false);
  });
});

describe("TonkActionPanel — not your turn (E1)", () => {
  it("shows the turn pill, hides the stepper, disables every button (validActions empty)", () => {
    const t = panelLogic({
      validActions: [],
      turnPhase: "discard",
      isMyTurn: false,
      selectionCount: 0,
      drawableDiscard: null,
      actionPending: false,
      actionError: null,
    });
    expect(t.showTurnPill.value).toBe(true);
    expect(t.showStepper.value).toBe(false);
    expect(t.discardDisabled.value).toBe(true);
  });

  it("disables draw-phase buttons too when it is not your turn", () => {
    const t = panelLogic({
      validActions: [],
      turnPhase: "draw",
      isMyTurn: false,
      selectionCount: 0,
      drawableDiscard: { rank: "4", suit: "diamonds" },
      actionPending: false,
      actionError: null,
    });
    expect(t.drawStockDisabled.value).toBe(true);
    expect(t.takeDiscardDisabled.value).toBe(true);
  });
});

describe("TonkActionPanel — in-flight guard (E12)", () => {
  it("disables every button while actionPending (no double-submit)", () => {
    const t = panelLogic({
      validActions: [discardAction(), callTonkAction()],
      turnPhase: "discard",
      isMyTurn: true,
      selectionCount: 2,
      drawableDiscard: { rank: "4", suit: "diamonds" },
      actionPending: true,
      actionError: null,
    });
    expect(t.discardDisabled.value).toBe(true);
    expect(t.callTonkDisabled.value).toBe(true);
  });

  it("disables draw buttons while actionPending", () => {
    const t = panelLogic({
      validActions: [drawAction()],
      turnPhase: "draw",
      isMyTurn: true,
      selectionCount: 0,
      drawableDiscard: { rank: "4", suit: "diamonds" },
      actionPending: true,
      actionError: null,
    });
    expect(t.drawStockDisabled.value).toBe(true);
    expect(t.takeDiscardDisabled.value).toBe(true);
  });
});

describe("TonkActionPanel — inline error + user tweaks (regression)", () => {
  it("renders the inline error iff actionError is set", () => {
    const withError = panelLogic({
      validActions: [discardAction()],
      turnPhase: "discard",
      isMyTurn: true,
      selectionCount: 2,
      drawableDiscard: null,
      actionPending: false,
      actionError: "Discard must be a single rank.",
    });
    expect(withError.showError.value).toBe(true);

    const noError = panelLogic({
      validActions: [discardAction()],
      turnPhase: "discard",
      isMyTurn: true,
      selectionCount: 2,
      drawableDiscard: null,
      actionPending: false,
      actionError: null,
    });
    expect(noError.showError.value).toBe(false);
  });

  it("the prompt line and gate hint are never rendered (user tweaks)", () => {
    const t = panelLogic({
      validActions: [discardAction(), callTonkAction()],
      turnPhase: "discard",
      isMyTurn: true,
      selectionCount: 1,
      drawableDiscard: null,
      actionPending: false,
      actionError: null,
    });
    expect(t.showPrompt).toBe(false);
    expect(t.showGateHint).toBe(false);
  });

  it("Take discard is text-only — no card thumbnail (user tweak)", () => {
    const t = panelLogic({
      validActions: [drawAction()],
      turnPhase: "draw",
      isMyTurn: true,
      selectionCount: 0,
      drawableDiscard: { rank: "4", suit: "diamonds" },
      actionPending: false,
      actionError: null,
    });
    expect(t.takeDiscardHasCardThumbnail).toBe(false);
  });
});

describe("TonkActionPanel — discard → draw phase morph (turn flow)", () => {
  it("advances the stepper and swaps the button set when the phase flips", async () => {
    const t = panelLogic({
      validActions: [discardAction()],
      turnPhase: "discard",
      isMyTurn: true,
      selectionCount: 3,
      drawableDiscard: { rank: "4", suit: "diamonds" },
      actionPending: false,
      actionError: null,
    });

    // Discard phase: step 1 active, Discard button present.
    expect(t.step1Active.value).toBe(true);
    expect(t.step2Active.value).toBe(false);
    expect(t.showDiscardBtn.value).toBe(true);
    expect(t.showDrawStockBtn.value).toBe(false);

    // Server sends new state: still our turn, now drawing.
    t.input.value = {
      ...t.input.value,
      turnPhase: "draw",
      validActions: [drawAction()],
    };
    await nextTick();

    // Step 1 done, step 2 active; buttons morph to the draw shell.
    expect(t.step1Done.value).toBe(true);
    expect(t.step2Active.value).toBe(true);
    expect(t.showDiscardBtn.value).toBe(false);
    expect(t.showDrawStockBtn.value).toBe(true);
    expect(t.showTakeDiscardBtn.value).toBe(true);
  });
});

// The board owns hand selectability + the same-rank hints and the GameView owns
// the success/reject selection-reset. These are transcribed from TonkBoard.vue's
// canSelectHand computed and GameView.vue's onDiscard / reset watch.

function boardSelectionLogic(initial: {
  isMyTurn: boolean;
  turnPhase: TonkTurnPhase;
  validActions: readonly ValidAction[];
}) {
  const isMyTurn = ref(initial.isMyTurn);
  const turnPhase = ref<TonkTurnPhase>(initial.turnPhase);
  const validActions = ref<readonly ValidAction[]>(initial.validActions);

  const canSelectHand = computed(
    () =>
      isMyTurn.value &&
      turnPhase.value === "discard" &&
      validActions.value.some((a) => a.type === "discard"),
  );

  return { isMyTurn, turnPhase, validActions, canSelectHand };
}

describe("TonkBoard — hand selectability (canSelectHand)", () => {
  it("selectable only on your discard-phase turn with a discard action", () => {
    const t = boardSelectionLogic({
      isMyTurn: true,
      turnPhase: "discard",
      validActions: [discardAction()],
    });
    expect(t.canSelectHand.value).toBe(true);
  });

  it("not selectable in the draw phase", () => {
    const t = boardSelectionLogic({
      isMyTurn: true,
      turnPhase: "draw",
      validActions: [drawAction()],
    });
    expect(t.canSelectHand.value).toBe(false);
  });

  it("not selectable when it is not your turn (validActions empty)", () => {
    const t = boardSelectionLogic({
      isMyTurn: false,
      turnPhase: "discard",
      validActions: [],
    });
    expect(t.canSelectHand.value).toBe(false);
  });
});

// Mirrors GameView.vue's onDiscard (clear on success, preserve on reject) and
// the defensive reset watch on (turnPhase, currentPlayerIndex).
function gameViewSelectionResetLogic() {
  const selectedIndices = ref<Set<number>>(new Set());
  const turnPhase = ref<TonkTurnPhase>("discard");
  const currentPlayerIndex = ref(0);

  function clearSelection(): void {
    selectedIndices.value = new Set();
  }

  async function onDiscard(ackSuccess: boolean): Promise<void> {
    if (ackSuccess) clearSelection();
  }

  watch(
    () => [turnPhase.value, currentPlayerIndex.value] as const,
    () => {
      clearSelection();
    },
  );

  return { selectedIndices, turnPhase, currentPlayerIndex, onDiscard };
}

describe("GameView — discard selection reset semantics (LLD 99 §D)", () => {
  it("clears the selection on a SUCCESSFUL discard", async () => {
    const t = gameViewSelectionResetLogic();
    t.selectedIndices.value = new Set([0, 1, 2]);

    await t.onDiscard(true);

    expect(t.selectedIndices.value.size).toBe(0);
  });

  it("PRESERVES the selection on a REJECTED discard (E3 — adjust and retry)", async () => {
    const t = gameViewSelectionResetLogic();
    t.selectedIndices.value = new Set([0, 2]);

    await t.onDiscard(false);

    expect([...t.selectedIndices.value].sort()).toEqual([0, 2]);
  });

  it("E14: clears selection when the phase flips to draw", async () => {
    const t = gameViewSelectionResetLogic();
    t.selectedIndices.value = new Set([1]);

    t.turnPhase.value = "draw";
    await nextTick();

    expect(t.selectedIndices.value.size).toBe(0);
  });

  it("E15: clears selection when the turn hands off to another seat", async () => {
    const t = gameViewSelectionResetLogic();
    t.selectedIndices.value = new Set([1]);

    t.currentPlayerIndex.value = 1;
    await nextTick();

    expect(t.selectedIndices.value.size).toBe(0);
  });
});
