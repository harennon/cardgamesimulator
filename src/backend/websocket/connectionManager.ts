import type { TypedSocket } from "./socketServer.js";
import type { PlayerId } from "@shared/engine-types";

/**
 * Tracks which sockets belong to which players in which games.
 * A player may have multiple sockets (multiple tabs).
 * A player is "connected" if they have at least one active socket.
 */
export class ConnectionManager {
  // gameId -> playerId -> Set<socketId>
  private readonly playerSockets: Map<string, Map<PlayerId, Set<string>>> =
    new Map();
  // socketId -> socket reference (for individual emit)
  private readonly sockets: Map<string, TypedSocket> = new Map();
  // socketId -> { gameId, playerId } (reverse lookup for disconnect)
  private readonly playerSocketMeta: Map<
    string,
    { gameId: string; playerId: PlayerId }
  > = new Map();
  // gameId -> Set<socketId> (spectator sockets)
  private readonly spectatorSockets: Map<string, Set<string>> = new Map();
  // socketId -> gameId (reverse lookup for spectator disconnect)
  private readonly spectatorSocketMeta: Map<string, string> = new Map();

  /** Register a player socket for a game. */
  addPlayerSocket(
    gameId: string,
    playerId: PlayerId,
    socket: TypedSocket,
  ): void {
    if (!this.playerSockets.has(gameId)) {
      this.playerSockets.set(gameId, new Map());
    }
    const gamePlayers = this.playerSockets.get(gameId)!;
    if (!gamePlayers.has(playerId)) {
      gamePlayers.set(playerId, new Set());
    }
    gamePlayers.get(playerId)!.add(socket.id);

    this.sockets.set(socket.id, socket);
    this.playerSocketMeta.set(socket.id, { gameId, playerId });
  }

  /** Register a spectator socket for a game. */
  addSpectatorSocket(gameId: string, socket: TypedSocket): void {
    if (!this.spectatorSockets.has(gameId)) {
      this.spectatorSockets.set(gameId, new Set());
    }
    this.spectatorSockets.get(gameId)!.add(socket.id);
    this.sockets.set(socket.id, socket);
    this.spectatorSocketMeta.set(socket.id, gameId);
  }

  /**
   * Remove a socket. Returns the gameId, playerId, and role if the socket was registered.
   */
  removeSocket(
    socketId: string,
  ): {
    gameId: string;
    playerId: PlayerId;
    role: "player" | "spectator";
  } | null {
    const playerMeta = this.playerSocketMeta.get(socketId);
    if (playerMeta) {
      const { gameId, playerId } = playerMeta;
      this.playerSocketMeta.delete(socketId);
      this.sockets.delete(socketId);

      const gamePlayers = this.playerSockets.get(gameId);
      if (gamePlayers) {
        const playerSet = gamePlayers.get(playerId);
        if (playerSet) {
          playerSet.delete(socketId);
          if (playerSet.size === 0) {
            gamePlayers.delete(playerId);
          }
        }
        if (gamePlayers.size === 0) {
          this.playerSockets.delete(gameId);
        }
      }

      return { gameId, playerId, role: "player" };
    }

    const spectatorGameId = this.spectatorSocketMeta.get(socketId);
    if (spectatorGameId) {
      this.spectatorSocketMeta.delete(socketId);
      this.sockets.delete(socketId);

      const spectatorSet = this.spectatorSockets.get(spectatorGameId);
      if (spectatorSet) {
        spectatorSet.delete(socketId);
        if (spectatorSet.size === 0) {
          this.spectatorSockets.delete(spectatorGameId);
        }
      }

      // playerId is not tracked for spectators — use empty string as sentinel
      return { gameId: spectatorGameId, playerId: "", role: "spectator" };
    }

    return null;
  }

  /** Get all player socket instances for a game (for individual PlayerView emit). */
  getPlayerSockets(
    gameId: string,
  ): Array<{ playerId: PlayerId; socket: TypedSocket }> {
    const gamePlayers = this.playerSockets.get(gameId);
    if (!gamePlayers) return [];

    const result: Array<{ playerId: PlayerId; socket: TypedSocket }> = [];
    for (const [playerId, socketIds] of gamePlayers.entries()) {
      for (const socketId of socketIds) {
        const socket = this.sockets.get(socketId);
        if (socket) {
          result.push({ playerId, socket });
        }
      }
    }
    return result;
  }

  /** Get the number of spectators connected to a game. */
  getSpectatorCount(gameId: string): number {
    return this.spectatorSockets.get(gameId)?.size ?? 0;
  }

  /** Check if a player has any active connections to a game. */
  isPlayerConnected(gameId: string, playerId: PlayerId): boolean {
    const gamePlayers = this.playerSockets.get(gameId);
    if (!gamePlayers) return false;
    const playerSet = gamePlayers.get(playerId);
    return (playerSet?.size ?? 0) > 0;
  }

  /** Get all connected player IDs for a game. */
  getConnectedPlayerIds(gameId: string): PlayerId[] {
    const gamePlayers = this.playerSockets.get(gameId);
    if (!gamePlayers) return [];
    return Array.from(gamePlayers.keys()).filter(
      (playerId) => (gamePlayers.get(playerId)?.size ?? 0) > 0,
    );
  }
}
