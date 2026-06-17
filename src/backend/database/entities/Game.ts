import type { GameType, GameStatus } from "@shared/engine-types";

export class Game {
  gameId: string = "";
  gameType: GameType = "big2";
  playerIds: string[] = [];
  playerDisplayNames: Record<string, string> = {};
  maxPlayers: number = 4;
  status: GameStatus = "CREATED";
  state: Record<string, unknown> = {};
  turnTimerSeconds: number | null = null;
  createdAt: Date = new Date();
  updatedAt: Date = new Date();
  version: number = 1;
}
