import { describe, it, expect } from "vitest";
import type {
  PlayerPublicInfo,
  PlayerInfo,
} from "../../src/shared/engine-types.js";
import {
  injectBoardAi,
  buildLobbyPlayers,
} from "../../src/backend/websocket/socketAiUtils.js";

// ---------------------------------------------------------------------------
// Unit tests for the isAi injection logic in socketAiUtils.ts.
//
// The socket layer derives isAi from gameConfig.aiPlayerIds (server-persisted),
// never from the client or from the "ai:" id prefix. These tests assert:
//   - board view (PlayerPublicInfo): AI seat gets isAi=true, human gets falsy
//   - lobby view (PlayerInfo): same derivation
//   - no aiPlayerIds → every seat isAi falsy (human-only regression)
//
// Tests import the real production functions from socketAiUtils rather than
// maintaining hand-copied mirrors (mirrors the round-1 lobbyUtils fix pattern).
// ---------------------------------------------------------------------------

describe("isAi injection — board view (PlayerPublicInfo)", () => {
  const humanId = "user-human-1";
  const aiId = "550e8400-e29b-41d4-a716-446655440000"; // plain UUID; no "ai:" prefix

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
    const result = injectBoardAi(players, aiIds);
    expect(result.find((p) => p.playerId === aiId)?.isAi).toBe(true);
  });

  it("human seat has isAi falsy when its id is not in aiPlayerIds", () => {
    const aiIds = new Set([aiId]);
    const result = injectBoardAi(players, aiIds);
    expect(result.find((p) => p.playerId === humanId)?.isAi).toBeFalsy();
  });

  it("isAi is derived from aiPlayerIds config, not from any id-prefix scheme", () => {
    // A player whose id looks like a plain UUID but is NOT in aiPlayerIds
    // should NOT get isAi=true.
    const impersonator: PlayerPublicInfo = {
      playerId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      displayName: "Trickster",
      cardCount: 3,
      isConnected: true,
    };
    const aiIds = new Set<string>(); // empty — no AI seats in config
    const result = injectBoardAi([impersonator], aiIds);
    expect(result[0]?.isAi).toBeFalsy();
  });

  it("no aiPlayerIds (human-only game) → every seat isAi falsy (regression: payload unchanged)", () => {
    const aiIds = new Set<string>();
    const result = injectBoardAi(players, aiIds);
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
  const aiId = "6ba7b811-9dad-11d1-80b4-00c04fd430c8"; // plain UUID
  const playerIds = [humanId, aiId];
  const displayNames: Record<string, string> = {
    [humanId]: "Alice",
    [aiId]: "CPU 1",
  };

  it("AI seat in lobby has isAi === true", () => {
    const aiIds = new Set([aiId]);
    const result: PlayerInfo[] = buildLobbyPlayers(
      playerIds,
      displayNames,
      aiIds,
    );
    expect(result.find((p) => p.playerId === aiId)?.isAi).toBe(true);
  });

  it("human seat in lobby has isAi falsy", () => {
    const aiIds = new Set([aiId]);
    const result: PlayerInfo[] = buildLobbyPlayers(
      playerIds,
      displayNames,
      aiIds,
    );
    expect(result.find((p) => p.playerId === humanId)?.isAi).toBeFalsy();
  });

  it("no aiPlayerIds → every lobby seat isAi absent (human-only regression)", () => {
    const aiIds = new Set<string>();
    const result: PlayerInfo[] = buildLobbyPlayers(
      playerIds,
      displayNames,
      aiIds,
    );
    result.forEach((p) => {
      expect("isAi" in p).toBe(false);
    });
  });
});
