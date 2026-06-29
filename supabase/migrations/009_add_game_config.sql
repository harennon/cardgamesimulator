-- 009: Add the generic game_config JSONB column for creator-configurable,
-- game-specific options (Tonk deckRoundsTarget first). Big2 rows stay '{}'.
-- Bare ADD COLUMN touches no constraint, so it is immune to the TypeORM-era
-- PK-name drift on prod (games_pkey1). Idempotent.
ALTER TABLE games ADD COLUMN IF NOT EXISTS game_config JSONB NOT NULL DEFAULT '{}'::jsonb;
