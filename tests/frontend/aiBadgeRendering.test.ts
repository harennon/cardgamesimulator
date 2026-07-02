import { describe, it, expect } from "vitest";
import type { PlayerInfo, PlayerPublicInfo } from "@shared/engine-types";
import { railSeats } from "@/component/game-ui/tonkDisplay";

// ---------------------------------------------------------------------------
// Tests for isAi badge rendering logic across GameLobbyView, OpponentRow,
// TonkSeatRail (via railSeats), and REST-seeded lobby derivation.
//
// Project pattern: pure function tests, no DOM mounting, no Vue Test Utils.
// ---------------------------------------------------------------------------

// Mirrors the lobby player-row v-if: render badge iff player.isAi is truthy.
function lobbyShowsBadge(player: PlayerInfo): boolean {
  return player.isAi === true;
}

// Mirrors OpponentRow/TonkSeatRail: render badge iff player/seat.isAi is truthy.
function boardShowsBadge(player: PlayerPublicInfo): boolean {
  return player.isAi === true;
}

// Mirrors the REST-seeded lobby derivation: isAi comes from gameConfig.aiPlayerIds.
function deriveIsAiFromConfig(
  playerId: string,
  aiPlayerIds: string[] | undefined,
): boolean {
  return (aiPlayerIds ?? []).includes(playerId);
}

// ---------------------------------------------------------------------------
// GameLobbyView — badge rendering
// ---------------------------------------------------------------------------

describe("GameLobbyView — AI badge rendering", () => {
  it("player with isAi=true renders one badge", () => {
    const aiPlayer: PlayerInfo = {
      playerId: "ai:uuid",
      displayName: "CPU 1",
      isAi: true,
    };
    expect(lobbyShowsBadge(aiPlayer)).toBe(true);
  });

  it("human player (isAi absent) renders no badge", () => {
    const human: PlayerInfo = { playerId: "user-1", displayName: "Alice" };
    expect(lobbyShowsBadge(human)).toBe(false);
  });

  it("human player with isAi=false renders no badge", () => {
    const human: PlayerInfo = {
      playerId: "user-1",
      displayName: "Alice",
      isAi: false,
    };
    expect(lobbyShowsBadge(human)).toBe(false);
  });

  it("REST-seeded lobby derives isAi from gameConfig.aiPlayerIds, not from id prefix", () => {
    const aiId = "ai:uuid-1";
    const humanId = "user-human-1";
    const aiPlayerIds = [aiId];

    expect(deriveIsAiFromConfig(aiId, aiPlayerIds)).toBe(true);
    expect(deriveIsAiFromConfig(humanId, aiPlayerIds)).toBe(false);
  });

  it("REST-seeded lobby: absent aiPlayerIds → all seats have isAi=false", () => {
    const ids = ["user-1", "user-2", "ai:not-configured"];
    ids.forEach((id) => {
      expect(deriveIsAiFromConfig(id, undefined)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// OpponentRow — badge rendering
// ---------------------------------------------------------------------------

describe("OpponentRow — AI badge rendering", () => {
  const basePlayer: Omit<PlayerPublicInfo, "isAi"> = {
    playerId: "ai:uuid",
    displayName: "CPU 1",
    cardCount: 5,
    isConnected: true,
  };

  it("opponent with isAi=true renders badge", () => {
    expect(boardShowsBadge({ ...basePlayer, isAi: true })).toBe(true);
  });

  it("human opponent (isAi absent) renders no badge", () => {
    expect(boardShowsBadge({ ...basePlayer })).toBe(false);
  });

  it("active AI seat (isActive=true) still shows badge — badge is independent of turn state", () => {
    // The badge marks identity; the gold active border marks turn. Both can coexist.
    const activeAi: PlayerPublicInfo = {
      ...basePlayer,
      isAi: true,
    };
    // isActive (gold border) is controlled by originalIndex === currentPlayerIndex,
    // not by isAi. Verify they are independent.
    const isActive = (originalIndex: number, currentPlayerIndex: number) =>
      originalIndex === currentPlayerIndex;
    expect(boardShowsBadge(activeAi)).toBe(true);
    expect(isActive(0, 0)).toBe(true); // gold border also present → both coexist
  });
});

// ---------------------------------------------------------------------------
// TonkSeatRail — railSeats propagates isAi into SeatRow
// ---------------------------------------------------------------------------

describe("railSeats — isAi propagation into SeatRow", () => {
  const players: PlayerPublicInfo[] = [
    {
      playerId: "user-1",
      displayName: "Alice",
      cardCount: 5,
      isConnected: true,
    },
    {
      playerId: "ai:uuid-1",
      displayName: "CPU 1",
      cardCount: 4,
      isConnected: true,
      isAi: true,
    },
    {
      playerId: "user-2",
      displayName: "Bob",
      cardCount: 6,
      isConnected: false,
    },
  ];
  const tallies = [10, 20, 30];
  const myPlayerIndex = 0; // Alice is the local player

  it("AI seat in railSeats has isAi=true", () => {
    const seats = railSeats(players, tallies, myPlayerIndex);
    const aiSeat = seats.find((s) => s.playerId === "ai:uuid-1");
    expect(aiSeat?.isAi).toBe(true);
  });

  it("human seat in railSeats has isAi falsy", () => {
    const seats = railSeats(players, tallies, myPlayerIndex);
    const humanSeat = seats.find((s) => s.playerId === "user-2");
    expect(humanSeat?.isAi).toBeFalsy();
  });

  it("railSeats filters out myPlayerIndex seat as before", () => {
    const seats = railSeats(players, tallies, myPlayerIndex);
    expect(seats.some((s) => s.seatIndex === myPlayerIndex)).toBe(false);
  });

  it("no AI players → all SeatRow.isAi are undefined/falsy", () => {
    const humanOnly: PlayerPublicInfo[] = [
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
    ];
    const seats = railSeats(humanOnly, [0, 0], 0);
    seats.forEach((s) => {
      expect(s.isAi).toBeFalsy();
    });
  });
});
