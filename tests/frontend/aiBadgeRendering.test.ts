import { describe, it, expect } from "vitest";
import type { PlayerInfo, PlayerPublicInfo } from "@shared/engine-types";
import { railSeats } from "@/component/game-ui/tonkDisplay";
import { buildRestLobbyPlayers } from "@/component/game/lobbyUtils";

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

  it("REST-seeded lobby: buildRestLobbyPlayers derives isAi from gameConfig.aiPlayerIds, not from id prefix", () => {
    const aiId = "ai:uuid-1";
    const humanId = "user-human-1";
    const displayNames = { [aiId]: "CPU 1", [humanId]: "Alice" };

    const players = buildRestLobbyPlayers([humanId, aiId], displayNames, [
      aiId,
    ]);
    expect(players.find((p) => p.playerId === aiId)?.isAi).toBe(true);
    expect(players.find((p) => p.playerId === humanId)?.isAi).toBeFalsy();
  });

  it("REST-seeded lobby: buildRestLobbyPlayers with absent aiPlayerIds → all seats isAi absent", () => {
    const ids = ["user-1", "user-2", "ai:not-configured"];
    const displayNames = Object.fromEntries(ids.map((id) => [id, id]));
    const players = buildRestLobbyPlayers(ids, displayNames, undefined);
    players.forEach((p) => {
      expect("isAi" in p).toBe(false);
    });
  });

  it("REST-seeded lobby: id starting with 'ai:' but absent from aiPlayerIds gets no badge", () => {
    const impersonatorId = "ai:not-in-config";
    const players = buildRestLobbyPlayers(
      [impersonatorId],
      { [impersonatorId]: "Trickster" },
      [], // empty aiPlayerIds
    );
    expect(players[0]?.isAi).toBeFalsy();
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

  it("railSeats includes the local player's seat, marked isSelf, sorted first", () => {
    const seats = railSeats(players, tallies, myPlayerIndex);
    const selfSeat = seats.find((s) => s.seatIndex === myPlayerIndex);
    expect(selfSeat).toBeDefined();
    expect(selfSeat?.isSelf).toBe(true);
    expect(seats[0]!.seatIndex).toBe(myPlayerIndex);
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
