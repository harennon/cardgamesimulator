-- 006: Repair the composite primary key that 004 failed to apply on databases
-- where the ORIGINAL player_stats PK was not named 'player_stats_pkey'.
--
-- 004 step 4 dropped the PK by a HARDCODED name ('player_stats_pkey') and then
-- re-added the composite (user_id, game_type) only if no PK existed. That is
-- correct on fresh local/CI databases (a clean `supabase start` creates
-- player_stats with the default PK name 'player_stats_pkey'). But prod's
-- player_stats was originally created by TypeORM (see 001's header), where the
-- PK landed as 'player_stats_pkey1' (the '1' suffix because 'player_stats_pkey'
-- was already taken at creation time). On prod, 004's hardcoded
-- DROP CONSTRAINT IF EXISTS player_stats_pkey matched nothing, the un-dropped
-- 'player_stats_pkey1' kept the NOT-EXISTS guard false, and the composite PK was
-- never applied -- leaving prod with a single-column PRIMARY KEY (user_id).
-- 005's RPC uses ON CONFLICT (user_id, game_type), which REQUIRES a constraint
-- on exactly (user_id, game_type), so every stats write would error on prod.
--
-- This migration repoints the PK by its ACTUAL constraint name (looked up
-- dynamically, never hardcoded), so it works whether the existing PK is named
-- 'player_stats_pkey1' (prod) or 'player_stats_pkey' (fresh). It only acts when
-- the PK is not already the correct composite, so it is a no-op on fresh/CI
-- databases where 004 already succeeded. Idempotent: safe to re-run (matches
-- the IF [NOT] EXISTS discipline of 001-005). Table name is unqualified so it
-- resolves via search_path (consistent with 004 and the throwaway-schema tests).
DO $$
DECLARE
  pk_name text;
  is_composite boolean;
BEGIN
  -- Is the current PK already exactly the composite (user_id, game_type)?
  -- attname is sorted so column order in the PK definition does not matter:
  -- ['game_type', 'user_id'] is the sorted form of (user_id, game_type).
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'player_stats'::regclass
      AND c.contype = 'p'
      AND (
        SELECT array_agg(att.attname::text ORDER BY att.attname::text)
        FROM unnest(c.conkey) AS k
        JOIN pg_attribute att
          ON att.attrelid = c.conrelid AND att.attnum = k
      ) = ARRAY['game_type', 'user_id']
  ) INTO is_composite;

  IF NOT is_composite THEN
    -- Find whatever PK currently exists (by its real name) and drop it.
    SELECT conname INTO pk_name
    FROM pg_constraint
    WHERE conrelid = 'player_stats'::regclass AND contype = 'p';

    IF pk_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE player_stats DROP CONSTRAINT %I', pk_name);
    END IF;

    -- Re-add with the conventional name so prod ends up consistent with fresh
    -- databases (where the PK is already named 'player_stats_pkey').
    ALTER TABLE player_stats
      ADD CONSTRAINT player_stats_pkey PRIMARY KEY (user_id, game_type);
  END IF;
END $$;
