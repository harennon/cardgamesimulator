-- Enable RLS on all tables
ALTER TABLE games ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

-- Service role (used by backend) bypasses RLS automatically.
-- These policies only apply to requests authenticated with the anon key (direct PostgREST access).

-- === GAMES policies ===

-- Players can view games they are part of
CREATE POLICY "Users can view their own games"
  ON games FOR SELECT
  USING (auth.uid() = ANY(player_ids));

-- No direct INSERT/UPDATE/DELETE via PostgREST — all mutations go through the backend (service role)
-- This is the server-authoritative principle: clients cannot mutate game state directly.

-- === PLAYER_STATS policies ===

-- Users can only read their own stats
CREATE POLICY "Users can view their own stats"
  ON player_stats FOR SELECT
  USING (auth.uid() = user_id);

-- No direct INSERT/UPDATE/DELETE — backend handles stat recording via service role

-- === FEEDBACK policies ===

-- Users can insert their own feedback
CREATE POLICY "Users can insert feedback"
  ON feedback FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can view their own feedback (optional, for future "my submissions" feature)
CREATE POLICY "Users can view their own feedback"
  ON feedback FOR SELECT
  USING (auth.uid() = user_id);

-- No UPDATE/DELETE — feedback is immutable
