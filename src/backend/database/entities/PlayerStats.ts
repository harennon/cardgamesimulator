import type { GameType } from "@shared/engine-types";

export class PlayerStats {
  userId: string = ""; // References Supabase auth.users.id (no FK — different schema)
  gameType: GameType = "big2"; // part of the composite key with userId
  gamesPlayed: number = 0;
  gamesWon: number = 0;
  gamesLost: number = 0;
  totalScore: number = 0;
  lastPlayedAt: Date = new Date();
}
