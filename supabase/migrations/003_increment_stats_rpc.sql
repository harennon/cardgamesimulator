-- Stored procedure for atomic stat increment (upsert)
-- Called by the backend via supabase.rpc('increment_player_stats', {...})

CREATE OR REPLACE FUNCTION increment_player_stats(
  p_user_id UUID,
  p_games_played INT,
  p_games_won INT,
  p_games_lost INT,
  p_total_score INT
) RETURNS VOID AS $$
BEGIN
  INSERT INTO player_stats (user_id, games_played, games_won, games_lost, total_score, last_played_at)
  VALUES (p_user_id, p_games_played, p_games_won, p_games_lost, p_total_score, NOW())
  ON CONFLICT (user_id) DO UPDATE SET
    games_played = player_stats.games_played + p_games_played,
    games_won = player_stats.games_won + p_games_won,
    games_lost = player_stats.games_lost + p_games_lost,
    total_score = player_stats.total_score + p_total_score,
    last_played_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- SECURITY DEFINER means this function runs with the definer's privileges (superuser),
-- bypassing RLS. This is safe because it's only callable via RPC and the backend
-- controls the inputs.

-- Restrict direct RPC calls: only the backend (service_role) should call this.
-- Must revoke from PUBLIC first (Postgres grants EXECUTE to PUBLIC by default).
REVOKE EXECUTE ON FUNCTION increment_player_stats FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION increment_player_stats FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_player_stats TO service_role;
