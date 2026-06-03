export interface EchoRequest {
    "string": string;
}

export interface EchoResponse {
    "string": string;
}

// AUTH Requests
export interface GetNonceRequest {
    "authRequestId": string;
}

export interface GetNonceResponse {
    "authRequestId": string;
    "nonce": string;
}

export interface CreateAccountRequest {
    "authRequestId": string;
    "payload": string;
}

export interface CreateAccountResponse {
    "authRequestId": string;
    "jwt": string;
}

export interface GetAuthTokenRequest {
    "authRequestId": string;
    "payload": string;
}

export interface GetAuthTokenResponse {
    "authRequestId": string;
    "jwt": string;
}

export interface BatchGetUsernameRequest {
    "accountIds": string[];
}

export interface BatchGetUsernameResponse {
    "accounts": Account[];
    "failures": AccountFailure[];
}

export interface Account {
    "accountId": string;
    "username": string;
}

export interface AccountFailure {
    "accountId": string;
    "failureReason": string;
    "failureCode": number;
}

export interface AccountPayload {
    "username": string;
    "password": string;
}

// GAME Requests
import type { GameType, GameStatus } from "./engine-types.js";
export type { GameType, GameStatus };

export interface CreateGameRequest {
    "gameType": GameType;
    "numPlayers": number;
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
    "accountId": string;
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
    "accountIds": string[];
    "status": GameStatus;
    "state": SerializableGameState;
}

export interface SerializableGameState {}