-- 005: Redefine increment_player_stats to be game-specific.
-- Adds p_game_type and uses the composite conflict target (user_id, game_type)
-- created by 004. Mirrors 003 exactly except for the new parameter and the
-- composite ON CONFLICT target.

-- Drop the old 5-arg signature first. Adding a parameter changes the function's
-- signature, so CREATE OR REPLACE would create a SECOND overload and leave the
-- stale 5-arg function callable (see LLD 66 §3.2). Dropping it explicitly avoids
-- two overloads coexisting. IF EXISTS keeps this re-runnable.
DROP FUNCTION IF EXISTS increment_player_stats(UUID, INT, INT, INT, INT);

CREATE OR REPLACE FUNCTION increment_player_stats(
  p_user_id      UUID,
  p_game_type    VARCHAR,
  p_games_played INT,
  p_games_won    INT,
  p_games_lost   INT,
  p_total_score  INT
) RETURNS VOID AS $$
BEGIN
  INSERT INTO player_stats (user_id, game_type, games_played, games_won, games_lost, total_score, last_played_at)
  VALUES (p_user_id, p_game_type, p_games_played, p_games_won, p_games_lost, p_total_score, NOW())
  ON CONFLICT (user_id, game_type) DO UPDATE SET
    games_played   = player_stats.games_played + p_games_played,
    games_won      = player_stats.games_won    + p_games_won,
    games_lost     = player_stats.games_lost   + p_games_lost,
    total_score    = player_stats.total_score  + p_total_score,
    last_played_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- SECURITY DEFINER means this function runs with the definer's privileges (superuser),
-- bypassing RLS. This is safe because it's only callable via RPC and the backend
-- controls the inputs.

-- Restrict direct RPC calls: only the backend (service_role) should call this.
-- A dropped-and-recreated function does NOT inherit the old grants (LLD 66 §3.2),
-- so the REVOKE/GRANT block from 003 must be repeated here.
-- Must revoke from PUBLIC first (Postgres grants EXECUTE to PUBLIC by default).
REVOKE EXECUTE ON FUNCTION increment_player_stats FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION increment_player_stats FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_player_stats TO service_role;
