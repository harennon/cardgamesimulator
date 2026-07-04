import { describe, it, expect } from "vitest";
import { computed } from "vue";
import type { GameType } from "../../src/shared/engine-types.js";

// LLD 145: GameOverView gates the "Total Turns" row on game type so the row
// only renders for Big2 (where turnNumber maps 1:1 to player turns). For Tonk,
// turnNumber increments twice per player turn plus once per round/deck reset and
// never resets across the multi-round match, making it meaningless as a
// "turns" figure.
//
// Tests transcribe the `showTotalTurns` computed from GameOverView.vue directly,
// following the node-env isolation pattern from gameOverFinalPlay.test.ts.

function makeShowTotalTurns(
  gameType: GameType | undefined,
  totalTurnsRaw: number | undefined,
) {
  const totalTurns = computed(() => totalTurnsRaw ?? 0);
  const showTotalTurns = computed(
    () => gameType === "big2" && totalTurns.value > 0,
  );
  return showTotalTurns;
}

describe("GameOverView — showTotalTurns gating (LLD 145)", () => {
  it("hides the row for Tonk even when turnNumber is large (reproduces reported bug)", () => {
    const show = makeShowTotalTurns("tonk", 192);
    expect(show.value).toBe(false);
  });

  it("hides the row for Tonk when totalTurns is 1", () => {
    const show = makeShowTotalTurns("tonk", 1);
    expect(show.value).toBe(false);
  });

  it("hides the row for Tonk when totalTurns is 0", () => {
    const show = makeShowTotalTurns("tonk", 0);
    expect(show.value).toBe(false);
  });

  it("shows the row for Big2 when totalTurns is positive", () => {
    const show = makeShowTotalTurns("big2", 13);
    expect(show.value).toBe(true);
  });

  it("hides the row for Big2 when totalTurns is 0 (Big2 behaviour preserved)", () => {
    const show = makeShowTotalTurns("big2", 0);
    expect(show.value).toBe(false);
  });

  it("hides the row when gameType is undefined (fail-safe, E4)", () => {
    const show = makeShowTotalTurns(undefined, 10);
    expect(show.value).toBe(false);
  });

  it("hides the row when totalTurns is undefined with Big2 (defaults to 0, E5)", () => {
    const show = makeShowTotalTurns("big2", undefined);
    expect(show.value).toBe(false);
  });
});
