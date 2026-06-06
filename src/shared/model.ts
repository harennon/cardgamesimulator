export interface EchoRequest {
    "string": string;
}

export interface EchoResponse {
    "string": string;
}

// GAME Requests
import type { GameType, GameStatus } from "./engine-types.js";
export type { GameType, GameStatus };

export interface CreateGameRequest {
    "gameType": GameType;
    "maxPlayers": number;
    "gameOptions": { [key: string]: string };
}

export interface CreateGameResponse {
    "gameId": string;
    "gameType": GameType;
}

export interface JoinGameRequest {
    "gameId": string;
}

export interface JoinGameResponse {
    "gameId": string;
    "gameType": GameType;
}

export interface GetGameStateRequest {
    "gameId": string;
}

export interface GetGameStateResponse {
    "gameId": string;
    "gameState": SerializableGame;
}

export interface SerializableGame {
    "gameId": string;
    "gameType": GameType;
    "maxPlayers": number;
    "playerIds": string[];
    "status": GameStatus;
    "state": SerializableGameState;
}

export type SerializableGameState = Record<string, unknown>;
