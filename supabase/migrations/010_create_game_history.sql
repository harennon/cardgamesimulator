-- 010: per-game history. One append-only row per completed game per registered
-- player. Enables time-windowed stats (lifetime/30d/ytd) that a running
-- aggregate cannot slice. player_stats (the lifetime fast path) is untouched.
-- Brand-new table => immune to the TypeORM-era PK-name drift; PK is an inline,
-- UNNAMED surrogate so no hardcoded constraint name (LLD 66 lesson).
CREATE TABLE IF NOT EXISTS game_history (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL,            -- Supabase auth.users.id; no FK (different schema), mirrors player_stats
  game_type  VARCHAR(50) NOT NULL,
  won        BOOLEAN NOT NULL,
  lost       BOOLEAN NOT NULL,
  score      INT NOT NULL,
  played_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Windowed queries filter by user + date; group by game_type. A fresh object
-- (CREATE INDEX IF NOT EXISTS), not a drift target, so the unqualified name is safe.
CREATE INDEX IF NOT EXISTS idx_game_history_user_played
  ON game_history (user_id, game_type, played_at);

-- Grants mirror the CLEANED 001/008 end-state: service_role full; anon/authenticated
-- SELECT-only (no write DML to anon). The backend uses service_role and bypasses RLS.
GRANT ALL ON game_history TO service_role;
GRANT SELECT ON game_history TO authenticated;
GRANT SELECT ON game_history TO anon;

-- Windowed aggregation in SQL (server-authoritative, architecture-principles #1).
-- The cutoff (p_since) is computed in the backend and passed as a parameter so
-- the SQL stays a dumb, window-agnostic date filter (never now() - interval here).
-- Returns the same compact per-game-type shape the handler already maps. STABLE
-- read-only; SECURITY DEFINER bypasses RLS like increment_player_stats.
CREATE OR REPLACE FUNCTION get_windowed_stats(p_user_id UUID, p_since TIMESTAMPTZ)
RETURNS TABLE (game_type VARCHAR, games_played BIGINT, games_won BIGINT,
               games_lost BIGINT, total_score BIGINT, last_played_at TIMESTAMPTZ) AS $$
  SELECT game_type,
         count(*),
         count(*) FILTER (WHERE won),
         count(*) FILTER (WHERE lost),
         coalesce(sum(score), 0),
         max(played_at)
  FROM game_history
  WHERE user_id = p_user_id AND played_at >= p_since
  GROUP BY game_type;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Same grant discipline as increment_player_stats: only the backend (service_role)
-- may call this. Revoke from PUBLIC first (Postgres grants EXECUTE to PUBLIC by default).
REVOKE EXECUTE ON FUNCTION get_windowed_stats FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_windowed_stats FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION get_windowed_stats TO service_role;
