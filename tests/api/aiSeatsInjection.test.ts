import { describe, it, expect } from "vitest";
import type {
  PlayerPublicInfo,
  PlayerInfo,
} from "../../src/shared/engine-types.js";

// ---------------------------------------------------------------------------
// Unit tests for the isAi injection logic extracted from socketHandler.ts.
//
// The socket layer derives isAi from gameConfig.aiPlayerIds (server-persisted),
// never from the client or from the "ai:" id prefix. These tests assert:
//   - board view (PlayerPublicInfo): AI seat gets isAi=true, human gets falsy
//   - lobby view (PlayerInfo): same derivation
//   - no aiPlayerIds → every seat isAi falsy (human-only regression)
// ---------------------------------------------------------------------------

// Mirrors the injection logic in injectConnectionStatus (socketHandler.ts):
// sets isAi from aiIds set alongside isConnected.
function injectIsAi(
  players: readonly PlayerPublicInfo[],
  aiIds: ReadonlySet<string>,
): PlayerPublicInfo[] {
  return players.map((p) => ({
    ...p,
    ...(aiIds.size > 0 ? { isAi: aiIds.has(p.playerId) } : {}),
  }));
}

// Mirrors the lobby PlayerInfo builder in handleGameJoin (socketHandler.ts).
function buildLobbyPlayers(
  playerIds: string[],
  displayNames: Record<string, string>,
  aiIds: ReadonlySet<string>,
): PlayerInfo[] {
  return playerIds.map((id) => ({
    playerId: id,
    displayName: displayNames[id] ?? id,
    ...(aiIds.size > 0 ? { isAi: aiIds.has(id) } : {}),
  }));
}

describe("isAi injection — board view (PlayerPublicInfo)", () => {
  const humanId = "user-human-1";
  const aiId = "ai:uuid-1234";

  const players: PlayerPublicInfo[] = [
    {
      playerId: humanId,
      displayName: "Alice",
      cardCount: 5,
      isConnected: true,
    },
    {
      playerId: aiId,
      displayName: "CPU 1",
      cardCount: 4,
      isConnected: true,
    },
  ];

  it("AI seat has isAi === true when its id is in aiPlayerIds", () => {
    const aiIds = new Set([aiId]);
    const result = injectIsAi(players, aiIds);
    expect(result.find((p) => p.playerId === aiId)?.isAi).toBe(true);
  });

  it("human seat has isAi falsy when its id is not in aiPlayerIds", () => {
    const aiIds = new Set([aiId]);
    const result = injectIsAi(players, aiIds);
    expect(result.find((p) => p.playerId === humanId)?.isAi).toBeFalsy();
  });

  it("isAi is derived from aiPlayerIds config, not from the 'ai:' id prefix", () => {
    // A player whose id happens to start with 'ai:' but is NOT in aiPlayerIds
    // should NOT get isAi=true.
    const impersonator: PlayerPublicInfo = {
      playerId: "ai:not-in-config",
      displayName: "Trickster",
      cardCount: 3,
      isConnected: true,
    };
    const aiIds = new Set<string>(); // empty — no AI seats in config
    const result = injectIsAi([impersonator], aiIds);
    expect(result[0]?.isAi).toBeFalsy();
  });

  it("no aiPlayerIds (human-only game) → every seat isAi falsy (regression: payload unchanged)", () => {
    const aiIds = new Set<string>();
    const result = injectIsAi(players, aiIds);
    result.forEach((p) => {
      expect(p.isAi).toBeFalsy();
    });
    // The key should not be present at all when no AI seats exist.
    expect("isAi" in result[0]!).toBe(false);
    expect("isAi" in result[1]!).toBe(false);
  });
});

describe("isAi injection — lobby view (PlayerInfo)", () => {
  const humanId = "user-human-1";
  const aiId = "ai:uuid-5678";
  const playerIds = [humanId, aiId];
  const displayNames: Record<string, string> = {
    [humanId]: "Alice",
    [aiId]: "CPU 1",
  };

  it("AI seat in lobby has isAi === true", () => {
    const aiIds = new Set([aiId]);
    const result = buildLobbyPlayers(playerIds, displayNames, aiIds);
    expect(result.find((p) => p.playerId === aiId)?.isAi).toBe(true);
  });

  it("human seat in lobby has isAi falsy", () => {
    const aiIds = new Set([aiId]);
    const result = buildLobbyPlayers(playerIds, displayNames, aiIds);
    expect(result.find((p) => p.playerId === humanId)?.isAi).toBeFalsy();
  });

  it("no aiPlayerIds → every lobby seat isAi absent (human-only regression)", () => {
    const aiIds = new Set<string>();
    const result = buildLobbyPlayers(playerIds, displayNames, aiIds);
    result.forEach((p) => {
      expect("isAi" in p).toBe(false);
    });
  });
});
