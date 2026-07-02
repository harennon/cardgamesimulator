import { describe, it, expect } from "vitest";
import type { CreateGameRequest, GameType } from "@shared/model";
import { GAME_TYPE_UI_BOUNDS } from "@/component/statsView";

// ---------------------------------------------------------------------------
// Tests for the AI-seats stepper logic added to CreateGameView in LLD 120.
//
// Follows the project pattern: pure function tests extracted from the
// component's <script setup> — no DOM mounting, no Vue Test Utils.
// ---------------------------------------------------------------------------

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

// Mirrors the clamp applied on maxPlayers change:
// numAiSeats = clamp(numAiSeats, 0, newMaxPlayers - 1)
function clampAiSeatsOnMaxPlayersChange(
  numAiSeats: number,
  newMaxPlayers: number,
): number {
  return clamp(numAiSeats, 0, newMaxPlayers - 1);
}

// Mirrors the clamp applied on game-type change:
// numAiSeats = clamp(numAiSeats, 0, maxPlayers - 1)
function clampAiSeatsOnGameTypeChange(
  numAiSeats: number,
  maxPlayers: number,
): number {
  return clamp(numAiSeats, 0, maxPlayers - 1);
}

// Mirrors ctaLabel: "Create Practice Game" when numAiSeats >= 1, else "Create Game"
function ctaLabel(numAiSeats: number): string {
  return numAiSeats >= 1 ? "Create Practice Game" : "Create Game";
}

// Mirrors the createGame() request body: only include numAiSeats when > 0
function buildRequest(
  gameType: GameType,
  maxPlayers: number,
  turnTimerSeconds: 30 | 60 | 90,
  deckRoundsTarget: number,
  numAiSeats: number,
): CreateGameRequest {
  return {
    gameType,
    maxPlayers,
    turnTimerSeconds,
    ...(gameType === "tonk" ? { deckRoundsTarget } : {}),
    ...(numAiSeats > 0 ? { numAiSeats } : {}),
  };
}

// showAiSeats: rendered only for a registered host after a game type is selected
function showAiSeats(
  isRegisteredHost: boolean,
  gameTypeSelected: boolean,
): boolean {
  return isRegisteredHost && gameTypeSelected;
}

describe("CreateGameView — AI-seats stepper bounds", () => {
  it("stepper lower bound is 0; decrement below 0 is clamped to 0", () => {
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(0 - 1, 0, 3)).toBe(0);
  });

  it("stepper upper bound is maxPlayers - 1", () => {
    expect(clamp(4, 0, 3)).toBe(3); // maxPlayers=4 → max AI seats = 3
    expect(clamp(8, 0, 7)).toBe(7); // maxPlayers=8 → max AI seats = 7
  });

  it("increment above maxPlayers-1 is clamped", () => {
    const numAiSeats = 3;
    const maxPlayers = 4;
    expect(clamp(numAiSeats + 1, 0, maxPlayers - 1)).toBe(3);
  });
});

describe("CreateGameView — numAiSeats re-clamp on maxPlayers change", () => {
  it("lowering maxPlayers below numAiSeats+1 clamps numAiSeats down", () => {
    // 3 AI seats, maxPlayers lowered to 3 → numAiSeats must become 2
    expect(clampAiSeatsOnMaxPlayersChange(3, 3)).toBe(2);
  });

  it("lowering maxPlayers to 2 clamps numAiSeats to at most 1", () => {
    expect(clampAiSeatsOnMaxPlayersChange(3, 2)).toBe(1);
  });

  it("maxPlayers change that keeps numAiSeats in range leaves it unchanged", () => {
    expect(clampAiSeatsOnMaxPlayersChange(2, 4)).toBe(2);
  });

  it("numAiSeats is never negative after clamp", () => {
    expect(clampAiSeatsOnMaxPlayersChange(0, 2)).toBe(0);
  });
});

describe("CreateGameView — numAiSeats re-clamp on game-type change", () => {
  it("switching game type re-clamps numAiSeats into 0..(newMaxPlayers-1)", () => {
    const maxPlayers = 2; // Big2 minimum after switch
    expect(clampAiSeatsOnGameTypeChange(3, maxPlayers)).toBe(1);
  });

  it("numAiSeats within new range stays unchanged", () => {
    const maxPlayers = 4;
    expect(clampAiSeatsOnGameTypeChange(2, maxPlayers)).toBe(2);
  });
});

describe("CreateGameView — CTA label", () => {
  it("'Create Game' when numAiSeats === 0", () => {
    expect(ctaLabel(0)).toBe("Create Game");
  });

  it("'Create Practice Game' when numAiSeats === 1", () => {
    expect(ctaLabel(1)).toBe("Create Practice Game");
  });

  it("'Create Practice Game' when numAiSeats > 1", () => {
    expect(ctaLabel(3)).toBe("Create Practice Game");
  });
});

describe("CreateGameView — AI seats field visibility", () => {
  it("hidden for a guest (not registered)", () => {
    expect(showAiSeats(false, true)).toBe(false);
  });

  it("hidden when no game type is selected", () => {
    expect(showAiSeats(true, false)).toBe(false);
  });

  it("shown for a registered host after game type is selected", () => {
    expect(showAiSeats(true, true)).toBe(true);
  });
});

describe("CreateGameView — request body includes numAiSeats only when > 0", () => {
  it("numAiSeats=0 → omitted from request body (human-only flow unchanged)", () => {
    const req = buildRequest("big2", 4, 60, 8, 0);
    expect("numAiSeats" in req).toBe(false);
  });

  it("numAiSeats=1 → included in request body", () => {
    const req = buildRequest("big2", 4, 60, 8, 1);
    expect(req.numAiSeats).toBe(1);
  });

  it("numAiSeats=2 with Tonk → both deckRoundsTarget and numAiSeats present", () => {
    const req = buildRequest("tonk", 5, 60, 8, 2);
    expect(req.numAiSeats).toBe(2);
    expect(req.deckRoundsTarget).toBe(8);
  });

  it("Big2 request at numAiSeats=0 is byte-for-byte the pre-AI request", () => {
    const req = buildRequest("big2", 4, 60, 8, 0);
    expect(req).toEqual({
      gameType: "big2",
      maxPlayers: 4,
      turnTimerSeconds: 60,
    });
  });
});

describe("CreateGameView — maxPlayers upper bound per game type", () => {
  it("Big 2 maxPlayers upper bound is 4", () => {
    expect(GAME_TYPE_UI_BOUNDS["big2"].maxPlayers).toBe(4);
  });

  it("Tonk maxPlayers upper bound is 8", () => {
    expect(GAME_TYPE_UI_BOUNDS["tonk"].maxPlayers).toBe(8);
  });
});
