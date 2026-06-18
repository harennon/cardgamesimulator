-- Create tables (previously managed by TypeORM synchronize)

CREATE TABLE IF NOT EXISTS games (
  game_id UUID PRIMARY KEY,
  game_type VARCHAR(50) NOT NULL DEFAULT 'big2',
  player_ids UUID[] NOT NULL DEFAULT '{}',
  player_display_names JSONB NOT NULL DEFAULT '{}',
  max_players INT NOT NULL DEFAULT 4,
  status VARCHAR(20) NOT NULL DEFAULT 'CREATED',
  state JSONB NOT NULL DEFAULT '{}',
  turn_timer_seconds INT,
  join_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS player_stats (
  user_id UUID PRIMARY KEY,
  games_played INT NOT NULL DEFAULT 0,
  games_won INT NOT NULL DEFAULT 0,
  games_lost INT NOT NULL DEFAULT 0,
  total_score INT NOT NULL DEFAULT 0,
  last_played_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category VARCHAR(20) NOT NULL,
  description VARCHAR(500) NOT NULL,
  metadata JSONB,
  user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for player lookups in games
CREATE INDEX IF NOT EXISTS idx_games_player_ids ON games USING GIN (player_ids);
CREATE INDEX IF NOT EXISTS idx_games_status ON games (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_games_join_code ON games (join_code)
  WHERE join_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback (created_at DESC);

-- Grant table access to Supabase roles.
-- service_role: full access (backend bypasses RLS).
-- authenticated/anon: limited by RLS policies in 002_enable_rls.sql.
GRANT ALL ON games TO service_role;
GRANT ALL ON player_stats TO service_role;
GRANT ALL ON feedback TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON games TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON player_stats TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON feedback TO authenticated;

GRANT SELECT ON games TO anon;
GRANT SELECT ON player_stats TO anon;
GRANT SELECT ON feedback TO anon;
