/**
 * Pure helper functions for injecting the isAi flag at the socket serialization
 * boundary. Exported so tests can import the real production code rather than
 * maintaining hand-copied mirrors.
 *
 * isAi is derived exclusively from gameConfig.aiPlayerIds (server-persisted).
 * It is never trusted from the client and never inferred from the "ai:" id prefix.
 */
import type { PlayerPublicInfo, PlayerInfo } from "@shared/engine-types";

/**
 * Return a new copy of `players` with `isAi` injected for seats whose id
 * appears in `aiIds`. When `aiIds` is empty the property is omitted entirely
 * (keeps the human-only payload shape unchanged).
 */
export function injectBoardAi(
  players: readonly PlayerPublicInfo[],
  aiIds: ReadonlySet<string>,
): PlayerPublicInfo[] {
  return players.map((p) => ({
    ...p,
    ...(aiIds.size > 0 ? { isAi: aiIds.has(p.playerId) } : {}),
  }));
}

/**
 * Build the lobby PlayerInfo[] from raw game data.
 * Tags AI seats from the persisted aiIds set — never from the client or from
 * the id-prefix scheme. When aiIds is empty, isAi is omitted (human-only
 * regression: payload shape unchanged).
 */
export function buildLobbyPlayers(
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
