import type { PlayerInfo } from "@shared/engine-types";

/**
 * Build the initial lobby player list from the REST getGameState response.
 * Derives isAi from gameConfig.aiPlayerIds — never from the "ai:" id prefix.
 * Returns PlayerInfo[] ready for the lobby display.
 */
export function buildRestLobbyPlayers(
  playerIds: string[],
  playerDisplayNames: Record<string, string>,
  aiPlayerIds: string[] | undefined,
): PlayerInfo[] {
  const aiIdSet = new Set(aiPlayerIds ?? []);
  return playerIds.map((id) => ({
    playerId: id,
    displayName: playerDisplayNames[id] ?? id,
    ...(aiIdSet.size > 0 ? { isAi: aiIdSet.has(id) } : {}),
  }));
}
