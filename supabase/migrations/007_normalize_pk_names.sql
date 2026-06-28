-- 007: Normalize the primary-key constraint names on `games` and `feedback`
-- back to the conventional 'games_pkey' / 'feedback_pkey'.
--
-- 001 uses CREATE TABLE IF NOT EXISTS. On prod the tables already existed
-- (created by TypeORM `synchronize`, see 001's header), so 001 was a no-op
-- there and TypeORM's artifacts persisted: the PK constraints landed as
-- 'games_pkey1' / 'feedback_pkey1' (the '1' suffix appears when the default
-- '*_pkey' name was already taken at creation time). Fresh `supabase start`
-- databases run 001 for real and get the conventional '*_pkey' names. Hence
-- the drift is invisible in CI but live on prod -- the same root cause that
-- broke 004 on player_stats (see 006's header).
--
-- The drift is functionally harmless today, but any FUTURE migration that
-- hardcodes e.g. `DROP CONSTRAINT IF EXISTS games_pkey` would silently skip on
-- prod -- exactly the latent repeat-bug class that 006 had to repair. This
-- migration looks up the PK by its ACTUAL name (queried from pg_constraint,
-- NEVER hardcoding the '*_pkey1' name) and RENAMEs it to the conventional name
-- only when it differs. RENAME is metadata-only: it preserves the constraint
-- object and its backing unique index (no rewrite, no window where the PK is
-- absent, no FK breakage). It is a no-op on fresh/CI databases where the name
-- is already conventional, and idempotent (safe to re-run). player_stats is
-- intentionally omitted -- 006 already named its PK 'player_stats_pkey'. Table
-- names are unqualified so they resolve via search_path (consistent with 004,
-- 006, and the throwaway-schema tests).

DO $$
DECLARE
  pk_name text;
BEGIN
  SELECT conname INTO pk_name
  FROM pg_constraint
  WHERE conrelid = 'games'::regclass AND contype = 'p';

  IF pk_name IS NOT NULL AND pk_name <> 'games_pkey' THEN
    EXECUTE format('ALTER TABLE games RENAME CONSTRAINT %I TO games_pkey', pk_name);
  END IF;
END $$;

DO $$
DECLARE
  pk_name text;
BEGIN
  SELECT conname INTO pk_name
  FROM pg_constraint
  WHERE conrelid = 'feedback'::regclass AND contype = 'p';

  IF pk_name IS NOT NULL AND pk_name <> 'feedback_pkey' THEN
    EXECUTE format('ALTER TABLE feedback RENAME CONSTRAINT %I TO feedback_pkey', pk_name);
  END IF;
END $$;
