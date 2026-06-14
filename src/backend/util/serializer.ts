import { SerializableGame, SerializableGameState } from "@shared/model";
import { Game } from "@/database/entities/Game";

export function serializeGameForPlayer(
  game: Game,
  _userId: string,
): SerializableGame {
  return {
    gameId: game.gameId,
    gameType: game.gameType,
    maxPlayers: game.maxPlayers,
    status: game.status,
    playerIds: game.playerIds,
    playerDisplayNames: game.playerDisplayNames,
    state: game.state as SerializableGameState,
    turnTimerSeconds: game.turnTimerSeconds,
  };
}
