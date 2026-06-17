export class PlayerStats {
  userId: string = ""; // References Supabase auth.users.id (no FK — different schema)
  gamesPlayed: number = 0;
  gamesWon: number = 0;
  gamesLost: number = 0;
  totalScore: number = 0;
  lastPlayedAt: Date = new Date();
}
