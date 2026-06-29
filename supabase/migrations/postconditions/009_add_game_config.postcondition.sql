-- Post-condition for 009 (LLD 77 §6, LLD 95): games has a game_config column
-- and its type is EXACTLY jsonb.
--
-- Shape-based / name-agnostic: asserts column presence and its type via
-- pg_attribute + format_type, NEVER a constraint name (the LLD 66 §004 failure
-- mode). A bare ADD COLUMN touches no constraint, so this holds on drifted prod
-- (games_pkey1), fresh CI, and the prod-shaped fixture alike. Idempotent and
-- read-only. Resolves games via search_path.
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT format_type(att.atttypid, att.atttypmod)
    INTO col_type
  FROM pg_attribute att
  WHERE att.attrelid = to_regclass('games')
    AND att.attname = 'game_config'
    AND NOT att.attisdropped;

  IF col_type IS NULL THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (009): games.game_config column is missing.';
  END IF;

  IF col_type <> 'jsonb' THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (009): games.game_config type is %, expected jsonb.',
      col_type;
  END IF;
END $$;
