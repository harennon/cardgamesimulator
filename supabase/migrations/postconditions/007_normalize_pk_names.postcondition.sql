-- Post-condition for 007 (LLD 77 §6.2): `games` and `feedback` each have a
-- PRIMARY KEY on the correct column -- games.(game_id), feedback.(id) -- exactly
-- as 001 declares. 007 RENAMEs the TypeORM-era '*_pkey1' PK constraints back to
-- the conventional '*_pkey' names; the rename is metadata-only and leaves the PK
-- columns untouched, so the durable end-state to assert is the PK *shape*.
--
-- Name-agnostic / shape-based (LLD 77 §6.2 #2): asserts the PK exists and covers
-- the intended column(s), NEVER a constraint name -- the whole lesson of the
-- drift incident is to assert shape, not artifact names (a name-based assertion
-- would have masked exactly the '*_pkey1' drift this surface cleans up). Holds on
-- drifted prod, fresh CI, and the throwaway-schema fixture alike. Idempotent and
-- read-only. Resolves table names via search_path (consistent with 004/006).
DO $$
DECLARE
  cols text[];
BEGIN
  -- 1. games: PK is exactly (game_id).
  SELECT array_agg(att.attname::text ORDER BY att.attname::text)
    INTO cols
  FROM pg_constraint c
  JOIN unnest(c.conkey) AS k ON true
  JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = k
  WHERE c.conrelid = to_regclass('games') AND c.contype = 'p';

  IF cols IS DISTINCT FROM ARRAY['game_id'] THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (007): games PK is %, expected primary key on (game_id).',
      cols;
  END IF;

  -- 2. feedback: PK is exactly (id).
  SELECT array_agg(att.attname::text ORDER BY att.attname::text)
    INTO cols
  FROM pg_constraint c
  JOIN unnest(c.conkey) AS k ON true
  JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = k
  WHERE c.conrelid = to_regclass('feedback') AND c.contype = 'p';

  IF cols IS DISTINCT FROM ARRAY['id'] THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (007): feedback PK is %, expected primary key on (id).',
      cols;
  END IF;
END $$;
