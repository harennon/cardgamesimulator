import { describe, it, expect } from "vitest";
import { ref, computed, watch, nextTick } from "vue";
import type { GameType } from "../../src/shared/engine-types.js";

// Transcription of GameView.vue's board-dispatch + final-play ribbon gating
// (LLD 88 decision 1). Tested in isolation per the project pattern
// (gameOverTransition.test.ts). These computeds drive the template v-if's:
//   - TonkBoard renders iff gameType === "tonk", GameBoard otherwise.
//   - the Big2 final-play ribbon renders iff
//     displayPhase === "SHOW_FINAL_PLAY" && gameType === "big2".

type DisplayPhase = "CREATED" | "IN_PROGRESS" | "SHOW_FINAL_PLAY" | "COMPLETED";

function makeGameViewLogic(gameType: GameType, initialStatus: string | null) {
  const effectiveStatus = ref(initialStatus);
  const displayPhase = ref<DisplayPhase>(
    initialStatus === "IN_PROGRESS"
      ? "IN_PROGRESS"
      : initialStatus === "COMPLETED"
        ? "COMPLETED"
        : "CREATED",
  );

  // The watcher is the unchanged, game-agnostic GameView watcher.
  watch(effectiveStatus, (newStatus, oldStatus) => {
    if (newStatus === "COMPLETED" && oldStatus === "IN_PROGRESS") {
      displayPhase.value = "SHOW_FINAL_PLAY";
    } else if (newStatus === "COMPLETED") {
      displayPhase.value = "COMPLETED";
    } else if (newStatus === "IN_PROGRESS") {
      displayPhase.value = "IN_PROGRESS";
    } else if (newStatus === "CREATED") {
      displayPhase.value = "CREATED";
    }
  });

  const onBoard = computed(
    () =>
      displayPhase.value === "IN_PROGRESS" ||
      displayPhase.value === "SHOW_FINAL_PLAY",
  );
  const showsTonkBoard = computed(() => onBoard.value && gameType === "tonk");
  const showsGameBoard = computed(() => onBoard.value && gameType !== "tonk");
  const showsFinalPlayRibbon = computed(
    () => displayPhase.value === "SHOW_FINAL_PLAY" && gameType === "big2",
  );
  const showsGameOver = computed(() => displayPhase.value === "COMPLETED");

  return {
    effectiveStatus,
    displayPhase,
    showsTonkBoard,
    showsGameBoard,
    showsFinalPlayRibbon,
    showsGameOver,
  };
}

describe("GameView dispatch — board selection by game type", () => {
  it("gameType 'tonk' (IN_PROGRESS) renders TonkBoard, not GameBoard", () => {
    const t = makeGameViewLogic("tonk", "IN_PROGRESS");
    expect(t.showsTonkBoard.value).toBe(true);
    expect(t.showsGameBoard.value).toBe(false);
  });

  it("gameType 'big2' (IN_PROGRESS) still renders GameBoard, not TonkBoard (no regression)", () => {
    const t = makeGameViewLogic("big2", "IN_PROGRESS");
    expect(t.showsGameBoard.value).toBe(true);
    expect(t.showsTonkBoard.value).toBe(false);
  });
});

describe("GameView dispatch — transient SHOW_FINAL_PLAY (E8 ribbon gate)", () => {
  it("a completing Tonk game enters SHOW_FINAL_PLAY: TonkBoard renders, ribbon ABSENT", async () => {
    const t = makeGameViewLogic("tonk", "IN_PROGRESS");

    t.effectiveStatus.value = "COMPLETED";
    await nextTick();

    // The generic watcher still routes Tonk through SHOW_FINAL_PLAY...
    expect(t.displayPhase.value).toBe("SHOW_FINAL_PLAY");
    // ...but the gate keeps the Big2 "wins!" ribbon off the Tonk board.
    expect(t.showsFinalPlayRibbon.value).toBe(false);
    expect(t.showsTonkBoard.value).toBe(true);
  });

  it("a completing Big2 game shows the ribbon in SHOW_FINAL_PLAY (gate is gameType-specific)", async () => {
    const t = makeGameViewLogic("big2", "IN_PROGRESS");

    t.effectiveStatus.value = "COMPLETED";
    await nextTick();

    expect(t.displayPhase.value).toBe("SHOW_FINAL_PLAY");
    expect(t.showsFinalPlayRibbon.value).toBe(true);
    expect(t.showsGameBoard.value).toBe(true);
  });

  it("a Tonk game reaching COMPLETED renders GameOverView and still no ribbon (E8 end state)", () => {
    const t = makeGameViewLogic("tonk", "COMPLETED");
    expect(t.displayPhase.value).toBe("COMPLETED");
    expect(t.showsGameOver.value).toBe(true);
    expect(t.showsFinalPlayRibbon.value).toBe(false);
    expect(t.showsTonkBoard.value).toBe(false);
  });
});
