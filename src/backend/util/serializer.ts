import { GameStatus, GameType, SerializableGame } from "@shared/model";
import { ObjectLiteral } from "typeorm";

export function serializeGameForPlayer(gameLiteral: ObjectLiteral, _accountId: string): SerializableGame {
    return {
        gameId: gameLiteral.gameId,
        gameType: gameLiteral.gameType as GameType,
        maxPlayers: gameLiteral.maxPlayers,
        status: gameLiteral.status as GameStatus,
        accountIds: gameLiteral.accountIds,
        state: JSON.parse(gameLiteral.state) as SerializableGame, // for now, need to remove sensitive data
    };

}