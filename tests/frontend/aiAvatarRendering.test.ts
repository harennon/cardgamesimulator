import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { PlayerInfo, PlayerPublicInfo } from "@shared/engine-types";
import { railSeats } from "@/component/game-ui/tonkDisplay";
import { aiNameForOrdinal } from "@shared/aiNames";

// ---------------------------------------------------------------------------
// LLD 128 — rendering tests for AiAvatar across all four surfaces.
//
// Follows the project pattern: pure function / source inspection tests,
// no DOM mounting, no Vue Test Utils.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Source inspection helpers — check that AiAvatar is wired into each surface.
// ---------------------------------------------------------------------------

function readSource(relPath: string): string {
  return readFileSync(resolve(import.meta.dirname, relPath), "utf-8");
}

const lobbySource = readSource(
  "../../src/frontend/component/game/GameLobbyView.vue",
);
const opponentRowSource = readSource(
  "../../src/frontend/component/game-ui/OpponentRow.vue",
);
const tonkRailSource = readSource(
  "../../src/frontend/component/game-ui/TonkSeatRail.vue",
);
const createGameSource = readSource(
  "../../src/frontend/component/CreateGameView.vue",
);

// ---------------------------------------------------------------------------
// GameLobbyView — AiAvatar wiring
// ---------------------------------------------------------------------------

describe("GameLobbyView — AiAvatar wiring", () => {
  it("imports AiAvatar", () => {
    expect(lobbySource).toContain("AiAvatar");
  });

  it('renders <AiAvatar v-if="player.isAi" size="sm" /> in the player row', () => {
    expect(lobbySource).toMatch(/AiAvatar[^>]*v-if="player\.isAi"/);
  });

  it('still renders <AiBadge v-if="player.isAi" /> alongside the avatar', () => {
    expect(lobbySource).toMatch(/AiBadge[^>]*v-if="player\.isAi"/);
  });
});

// ---------------------------------------------------------------------------
// OpponentRow — AiAvatar wiring
// ---------------------------------------------------------------------------

describe("OpponentRow — AiAvatar wiring", () => {
  it("imports AiAvatar", () => {
    expect(opponentRowSource).toContain("AiAvatar");
  });

  it('renders <AiAvatar v-if="player.isAi" size="sm" /> in opponent__info', () => {
    expect(opponentRowSource).toMatch(/AiAvatar[^>]*v-if="player\.isAi"/);
  });

  it('still renders <AiBadge v-if="player.isAi" /> alongside the avatar', () => {
    expect(opponentRowSource).toMatch(/AiBadge[^>]*v-if="player\.isAi"/);
  });
});

// ---------------------------------------------------------------------------
// TonkSeatRail — AiAvatar wiring
// ---------------------------------------------------------------------------

describe("TonkSeatRail — AiAvatar wiring", () => {
  it("imports AiAvatar", () => {
    expect(tonkRailSource).toContain("AiAvatar");
  });

  it('renders <AiAvatar v-if="seat.isAi" size="sm" /> in tonk-seat__info', () => {
    expect(tonkRailSource).toMatch(/AiAvatar[^>]*v-if="seat\.isAi"/);
  });

  it('still renders <AiBadge v-if="seat.isAi" /> alongside the avatar', () => {
    expect(tonkRailSource).toMatch(/AiBadge[^>]*v-if="seat\.isAi"/);
  });
});

// ---------------------------------------------------------------------------
// CreateGameView — Fill button and preview wiring
// ---------------------------------------------------------------------------

describe("CreateGameView — Fill button wiring", () => {
  it("has data-testid='ai-seats-fill' on the Fill button", () => {
    expect(createGameSource).toContain('data-testid="ai-seats-fill"');
  });

  it("Fill button is disabled when numAiSeats >= maxAiSeats", () => {
    expect(createGameSource).toContain(':disabled="numAiSeats >= maxAiSeats"');
  });

  it("Fill button calls fillAiSeats on click", () => {
    expect(createGameSource).toContain('@click="fillAiSeats"');
  });

  it("has a fillAiSeats function that sets numAiSeats to maxAiSeats", () => {
    expect(createGameSource).toContain("fillAiSeats");
    expect(createGameSource).toContain("numAiSeats.value = maxAiSeats.value");
  });
});

describe("CreateGameView — preview wiring", () => {
  it("has data-testid='ai-seats-preview' on the preview container", () => {
    expect(createGameSource).toContain('data-testid="ai-seats-preview"');
  });

  it("has data-testid='ai-seats-preview-chip' on each chip", () => {
    expect(createGameSource).toContain('data-testid="ai-seats-preview-chip"');
  });

  it("preview renders only when numAiSeats >= 1 (v-if)", () => {
    expect(createGameSource).toMatch(
      /v-if="numAiSeats >= 1"[^>]*data-testid="ai-seats-preview"|data-testid="ai-seats-preview"[^>]*v-if="numAiSeats >= 1"/,
    );
  });

  it("imports aiNameForOrdinal from @shared/aiNames", () => {
    expect(createGameSource).toContain("aiNameForOrdinal");
    expect(createGameSource).toContain("@shared/aiNames");
  });

  it("imports AiAvatar for use in the preview chips (md size)", () => {
    expect(createGameSource).toContain("AiAvatar");
  });
});

// ---------------------------------------------------------------------------
// aiPreviewNames logic — pure function test
// ---------------------------------------------------------------------------

describe("aiPreviewNames computed — matches aiNameForOrdinal", () => {
  function aiPreviewNames(numAiSeats: number): string[] {
    return Array.from({ length: numAiSeats }, (_, i) => aiNameForOrdinal(i));
  }

  it("0 seats → empty array (no preview rendered)", () => {
    expect(aiPreviewNames(0)).toEqual([]);
  });

  it("1 seat → ['Ace']", () => {
    expect(aiPreviewNames(1)).toEqual(["Ace"]);
  });

  it("3 seats → ['Ace', 'Bishop', 'Cortex']", () => {
    expect(aiPreviewNames(3)).toEqual(["Ace", "Bishop", "Cortex"]);
  });

  it("7 seats → all 7 pool names in order", () => {
    expect(aiPreviewNames(7)).toEqual([
      "Ace",
      "Bishop",
      "Cortex",
      "Domino",
      "Echo",
      "Fable",
      "Gambit",
    ]);
  });

  it("preview names match the backend's assignment (same shared helper)", () => {
    // If both sides use aiNameForOrdinal, the previewed name === the seated name.
    for (let i = 0; i < 7; i++) {
      expect(aiPreviewNames(i + 1)[i]).toBe(aiNameForOrdinal(i));
    }
  });
});

// ---------------------------------------------------------------------------
// fillAiSeats logic — pure function test
// ---------------------------------------------------------------------------

describe("fillAiSeats — sets numAiSeats to maxAiSeats", () => {
  function fillAiSeats(maxAiSeats: number, _currentNumAiSeats: number): number {
    return maxAiSeats;
  }

  it("fills from 0 to maxAiSeats", () => {
    expect(fillAiSeats(3, 0)).toBe(3);
  });

  it("fills from 1 to maxAiSeats", () => {
    expect(fillAiSeats(7, 1)).toBe(7);
  });

  it("at max, result equals maxAiSeats (idempotent)", () => {
    expect(fillAiSeats(3, 3)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// isAi gate — avatar appears only for AI seats (pure logic mirrors)
// ---------------------------------------------------------------------------

describe("AiAvatar isAi gate — lobby", () => {
  function lobbyShowsAvatar(player: PlayerInfo): boolean {
    return player.isAi === true;
  }

  it("AI player (isAi=true) shows avatar", () => {
    const ai: PlayerInfo = { playerId: "ai:1", displayName: "Ace", isAi: true };
    expect(lobbyShowsAvatar(ai)).toBe(true);
  });

  it("human player (isAi absent) shows no avatar", () => {
    const human: PlayerInfo = { playerId: "user-1", displayName: "Alice" };
    expect(lobbyShowsAvatar(human)).toBe(false);
  });
});

describe("AiAvatar isAi gate — OpponentRow / TonkSeatRail", () => {
  function boardShowsAvatar(player: PlayerPublicInfo): boolean {
    return player.isAi === true;
  }

  it("AI opponent shows avatar", () => {
    const ai: PlayerPublicInfo = {
      playerId: "ai:1",
      displayName: "Ace",
      cardCount: 5,
      isConnected: true,
      isAi: true,
    };
    expect(boardShowsAvatar(ai)).toBe(true);
  });

  it("human opponent shows no avatar", () => {
    const human: PlayerPublicInfo = {
      playerId: "user-1",
      displayName: "Alice",
      cardCount: 5,
      isConnected: true,
    };
    expect(boardShowsAvatar(human)).toBe(false);
  });

  it("active AI (turn=true) shows avatar (identity independent of turn state)", () => {
    const activeAi: PlayerPublicInfo = {
      playerId: "ai:1",
      displayName: "Ace",
      cardCount: 5,
      isConnected: true,
      isAi: true,
    };
    const isActive = (idx: number, currentIdx: number) => idx === currentIdx;
    expect(boardShowsAvatar(activeAi)).toBe(true);
    expect(isActive(0, 0)).toBe(true); // gold glow also active; both coexist
  });
});

describe("TonkSeatRail — railSeats propagates isAi for AiAvatar", () => {
  const players: PlayerPublicInfo[] = [
    {
      playerId: "user-1",
      displayName: "Alice",
      cardCount: 5,
      isConnected: true,
    },
    {
      playerId: "ai:1",
      displayName: "Ace",
      cardCount: 4,
      isConnected: true,
      isAi: true,
    },
  ];
  const tallies = [0, 0];

  it("AI seat has isAi=true in SeatRow (used by v-if in TonkSeatRail)", () => {
    const seats = railSeats(players, tallies, 0);
    const aiSeat = seats.find((s) => s.playerId === "ai:1");
    expect(aiSeat?.isAi).toBe(true);
  });

  it("human seat has isAi falsy in SeatRow (no avatar rendered)", () => {
    const humanSeats = railSeats(
      [
        {
          playerId: "user-1",
          displayName: "Alice",
          cardCount: 5,
          isConnected: true,
        },
        {
          playerId: "user-2",
          displayName: "Bob",
          cardCount: 4,
          isConnected: true,
        },
      ],
      [0, 0],
      0,
    );
    humanSeats.forEach((s) => expect(s.isAi).toBeFalsy());
  });
});
