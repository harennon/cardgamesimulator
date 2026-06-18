CREATE TABLE IF NOT EXISTS join_codes (
  code TEXT PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_join_codes_game_id ON join_codes (game_id);

-- Allow service_role full access, anon/authenticated can SELECT (resolve codes)
GRANT ALL ON join_codes TO service_role;
GRANT SELECT ON join_codes TO authenticated;
GRANT SELECT ON join_codes TO anon;
