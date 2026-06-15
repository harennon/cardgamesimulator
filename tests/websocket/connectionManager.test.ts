import { describe, it, expect } from "vitest";
import { ConnectionManager } from "../../src/backend/websocket/connectionManager.js";
import type { TypedSocket } from "../../src/backend/websocket/socketServer.js";

function makeSocket(id: string): TypedSocket {
  return { id } as unknown as TypedSocket;
}

describe("ConnectionManager", () => {
  describe("addPlayerSocket / isPlayerConnected", () => {
    it("registers a socket and reports player as connected", () => {
      const cm = new ConnectionManager();
      cm.addPlayerSocket("game-1", "player-a", makeSocket("sock-1"));
      expect(cm.isPlayerConnected("game-1", "player-a")).toBe(true);
    });

    it("returns false for a player who has not joined", () => {
      const cm = new ConnectionManager();
      expect(cm.isPlayerConnected("game-1", "player-a")).toBe(false);
    });

    it("returns false for a different game", () => {
      const cm = new ConnectionManager();
      cm.addPlayerSocket("game-1", "player-a", makeSocket("sock-1"));
      expect(cm.isPlayerConnected("game-2", "player-a")).toBe(false);
    });
  });

  describe("removeSocket", () => {
    it("removes the socket and player is no longer connected", () => {
      const cm = new ConnectionManager();
      cm.addPlayerSocket("game-1", "player-a", makeSocket("sock-1"));
      cm.removeSocket("sock-1");
      expect(cm.isPlayerConnected("game-1", "player-a")).toBe(false);
    });

    it("returns null for an unknown socket id", () => {
      const cm = new ConnectionManager();
      expect(cm.removeSocket("unknown-sock")).toBeNull();
    });

    it("returns the correct metadata when removing a player socket", () => {
      const cm = new ConnectionManager();
      cm.addPlayerSocket("game-1", "player-a", makeSocket("sock-1"));
      const meta = cm.removeSocket("sock-1");
      expect(meta).toEqual({
        gameId: "game-1",
        playerId: "player-a",
        role: "player",
      });
    });

    it("returns the correct metadata when removing a spectator socket", () => {
      const cm = new ConnectionManager();
      cm.addSpectatorSocket("game-1", makeSocket("spec-sock-1"));
      const meta = cm.removeSocket("spec-sock-1");
      expect(meta).toEqual({
        gameId: "game-1",
        playerId: "",
        role: "spectator",
      });
    });
  });

  describe("multi-tab: multiple sockets per player", () => {
    it("isPlayerConnected is true with two sockets and remains true after removing one", () => {
      const cm = new ConnectionManager();
      cm.addPlayerSocket("game-1", "player-a", makeSocket("sock-1"));
      cm.addPlayerSocket("game-1", "player-a", makeSocket("sock-2"));

      cm.removeSocket("sock-1");

      expect(cm.isPlayerConnected("game-1", "player-a")).toBe(true);
    });

    it("isPlayerConnected is false after removing all sockets", () => {
      const cm = new ConnectionManager();
      cm.addPlayerSocket("game-1", "player-a", makeSocket("sock-1"));
      cm.addPlayerSocket("game-1", "player-a", makeSocket("sock-2"));

      cm.removeSocket("sock-1");
      cm.removeSocket("sock-2");

      expect(cm.isPlayerConnected("game-1", "player-a")).toBe(false);
    });

    it("getPlayerSockets returns one entry per socket", () => {
      const cm = new ConnectionManager();
      const s1 = makeSocket("sock-1");
      const s2 = makeSocket("sock-2");
      cm.addPlayerSocket("game-1", "player-a", s1);
      cm.addPlayerSocket("game-1", "player-a", s2);

      const sockets = cm.getPlayerSockets("game-1");
      expect(sockets).toHaveLength(2);
      expect(sockets.every((e) => e.playerId === "player-a")).toBe(true);
    });
  });

  describe("getPlayerSockets", () => {
    it("returns empty array when no players are registered", () => {
      const cm = new ConnectionManager();
      expect(cm.getPlayerSockets("game-1")).toEqual([]);
    });

    it("returns sockets for all distinct players", () => {
      const cm = new ConnectionManager();
      cm.addPlayerSocket("game-1", "player-a", makeSocket("sock-a"));
      cm.addPlayerSocket("game-1", "player-b", makeSocket("sock-b"));

      const sockets = cm.getPlayerSockets("game-1");
      const playerIds = sockets.map((e) => e.playerId);
      expect(playerIds).toContain("player-a");
      expect(playerIds).toContain("player-b");
    });

    it("returns empty array after the last socket is removed", () => {
      const cm = new ConnectionManager();
      cm.addPlayerSocket("game-1", "player-a", makeSocket("sock-1"));
      cm.removeSocket("sock-1");
      expect(cm.getPlayerSockets("game-1")).toEqual([]);
    });
  });

  describe("addSpectatorSocket / getSpectatorCount", () => {
    it("returns 0 when no spectators are registered", () => {
      const cm = new ConnectionManager();
      expect(cm.getSpectatorCount("game-1")).toBe(0);
    });

    it("increments spectator count when sockets are added", () => {
      const cm = new ConnectionManager();
      cm.addSpectatorSocket("game-1", makeSocket("spec-1"));
      cm.addSpectatorSocket("game-1", makeSocket("spec-2"));
      expect(cm.getSpectatorCount("game-1")).toBe(2);
    });

    it("decrements spectator count after removeSocket", () => {
      const cm = new ConnectionManager();
      cm.addSpectatorSocket("game-1", makeSocket("spec-1"));
      cm.addSpectatorSocket("game-1", makeSocket("spec-2"));
      cm.removeSocket("spec-1");
      expect(cm.getSpectatorCount("game-1")).toBe(1);
    });
  });

  describe("isSpectator / getSpectatorGameId", () => {
    it("isSpectator returns true for a registered spectator socket", () => {
      const cm = new ConnectionManager();
      cm.addSpectatorSocket("game-1", makeSocket("spec-1"));
      expect(cm.isSpectator("spec-1")).toBe(true);
    });

    it("isSpectator returns false for a player socket", () => {
      const cm = new ConnectionManager();
      cm.addPlayerSocket("game-1", "player-a", makeSocket("sock-1"));
      expect(cm.isSpectator("sock-1")).toBe(false);
    });

    it("isSpectator returns false after the spectator socket is removed", () => {
      const cm = new ConnectionManager();
      cm.addSpectatorSocket("game-1", makeSocket("spec-1"));
      cm.removeSocket("spec-1");
      expect(cm.isSpectator("spec-1")).toBe(false);
    });

    it("getSpectatorGameId returns the correct gameId before removal and null after", () => {
      const cm = new ConnectionManager();
      cm.addSpectatorSocket("game-1", makeSocket("spec-1"));
      cm.addSpectatorSocket("game-1", makeSocket("spec-2"));
      expect(cm.getSpectatorGameId("spec-1")).toBe("game-1");
      cm.removeSocket("spec-1");
      expect(cm.getSpectatorGameId("spec-1")).toBeNull();
      // spec-2 count decrements correctly: from 2 to 1
      expect(cm.getSpectatorCount("game-1")).toBe(1);
    });
  });
});
