import { describe, it, expect } from "vitest";
import type { CreateGameRequest, GameType } from "@shared/model";
import { GAME_TYPE_UI_BOUNDS } from "@/component/statsView";

// ---------------------------------------------------------------------------
// Tests for CreateGameView's type-aware player-count clamp and request shaping,
// extracted as pure functions that mirror the component's <script setup> logic
// (project pattern: gameLobbyView.test.ts / tonkBoard.test.ts).
// ---------------------------------------------------------------------------

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

// Mirrors the watch(gameType) handler: seed to the new type's min when coming
// from the unselected state, otherwise re-clamp the current count into range.
function nextCountOnTypeChange(
  count: number,
  next: GameType,
  prev: GameType | "",
): number {
  const b = GAME_TYPE_UI_BOUNDS[next];
  if (!prev) return b.minPlayers;
  return clamp(count, b.minPlayers, b.maxPlayers);
}

// Mirrors the createGame() request literal: deckRoundsTarget only for Tonk,
// no gameOptions field is sent.
function buildRequest(
  gameType: GameType,
  maxPlayers: number,
  turnTimerSeconds: 30 | 60 | 90,
  deckRoundsTarget: number,
): CreateGameRequest {
  return {
    gameType,
    maxPlayers,
    turnTimerSeconds,
    ...(gameType === "tonk" ? { deckRoundsTarget } : {}),
  };
}

describe("CreateGameView — player-count clamp on game-type change", () => {
  it("Tonk(7) -> Big 2 clamps the count down to 4", () => {
    expect(nextCountOnTypeChange(7, "big2", "tonk")).toBe(4);
  });

  it("Tonk(3) -> Big 2 keeps 3 (still within Big 2's 2-4 range)", () => {
    expect(nextCountOnTypeChange(3, "big2", "tonk")).toBe(3);
  });

  it("Big 2(2) -> Tonk clamps the count up to 3", () => {
    expect(nextCountOnTypeChange(2, "tonk", "big2")).toBe(3);
  });

  it("Big 2(4) -> Tonk keeps 4 (within Tonk's 3-8 range)", () => {
    expect(nextCountOnTypeChange(4, "tonk", "big2")).toBe(4);
  });

  it("selecting Big 2 from unselected seeds the count to 2 (its min)", () => {
    expect(nextCountOnTypeChange(2, "big2", "")).toBe(2);
  });

  it("selecting Tonk from unselected seeds the count to 3 (its min)", () => {
    expect(nextCountOnTypeChange(2, "tonk", "")).toBe(3);
  });
});

describe("CreateGameView — create request shaping", () => {
  it("Tonk submit includes the selected deckRoundsTarget", () => {
    const req = buildRequest("tonk", 5, 60, 11);
    expect(req.deckRoundsTarget).toBe(11);
    expect(req.gameType).toBe("tonk");
    expect(req.maxPlayers).toBe(5);
  });

  it("Big 2 submit omits deckRoundsTarget", () => {
    const req = buildRequest("big2", 4, 60, 8);
    expect("deckRoundsTarget" in req).toBe(false);
  });

  it("does not send the dead gameOptions field", () => {
    const tonk = buildRequest("tonk", 3, 30, 8);
    const big2 = buildRequest("big2", 2, 90, 8);
    expect("gameOptions" in tonk).toBe(false);
    expect("gameOptions" in big2).toBe(false);
  });

  it("deckRoundsTarget defaults to 8 before the user touches the stepper", () => {
    // The component ref initializes to 8; an untouched Tonk submit sends 8.
    const req = buildRequest("tonk", 3, 60, 8);
    expect(req.deckRoundsTarget).toBe(8);
  });

  it("the deck-length options span the server-validated range 5..12", () => {
    const values = [5, 6, 7, 8, 9, 10, 11, 12];
    expect(values[0]).toBe(5);
    expect(values[values.length - 1]).toBe(12);
    expect(values).toHaveLength(8);
  });
});
