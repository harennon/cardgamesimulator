-- 004: Make player_stats game-specific.
-- Adds game_type, backfills existing (Big2-only) rows, and repoints the PK
-- to the composite (user_id, game_type). Idempotent: safe to re-run if a prior
-- apply was interrupted (matches the IF [NOT] EXISTS discipline of 001-003).

-- 1. Backfill-safety guard: abort loudly if any non-big2 game has completed,
--    which would make the 'big2' backfill mis-attribute results (see LLD 66
--    §8.2 / edge case #9). Placed FIRST so the migration aborts before mutating
--    anything.
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM games
      WHERE game_type <> 'big2' AND status = 'COMPLETED') > 0 THEN
    RAISE EXCEPTION
      'Migration 004 aborted: % completed non-big2 game(s) exist. Backfilling player_stats as ''big2'' would mis-attribute their results. See LLD 66 §8.2.',
      (SELECT COUNT(*) FROM games WHERE game_type <> 'big2' AND status = 'COMPLETED');
  END IF;
END $$;

-- 2. Add the column with a one-shot backfill default.
--    Postgres fills all existing rows with 'big2' atomically (Big2 is the
--    only game shipped to date — see §2.2 decision 2). NOT NULL is safe
--    because the default covers every existing row. IF NOT EXISTS makes the
--    add re-runnable.
ALTER TABLE player_stats
  ADD COLUMN IF NOT EXISTS game_type VARCHAR(50) NOT NULL DEFAULT 'big2';

-- 3. Drop the default so future inserts MUST specify game_type explicitly
--    (the RPC always does). The default was only a backfill device.
--    DROP DEFAULT is a no-op if already dropped, so this is naturally re-runnable.
ALTER TABLE player_stats
  ALTER COLUMN game_type DROP DEFAULT;

-- 4. Repoint the primary key from (user_id) to (user_id, game_type).
--    DROP CONSTRAINT IF EXISTS makes the drop re-runnable; the ADD is guarded by
--    a NOT-EXISTS check so a re-run after the PK is already composite is a no-op.
--    NOTE: 'player_stats_pkey' is the verified PK constraint name (the Postgres
--    default for the inline PRIMARY KEY on player_stats in 001).
ALTER TABLE player_stats DROP CONSTRAINT IF EXISTS player_stats_pkey;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'player_stats'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE player_stats
      ADD CONSTRAINT player_stats_pkey PRIMARY KEY (user_id, game_type);
  END IF;
END $$;
