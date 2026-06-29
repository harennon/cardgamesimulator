-- Post-condition for 009 (LLD 77 §6): games has a deck_rounds_target column of
-- integer type. Name-agnostic / shape-based, idempotent, read-only.
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT format_type(att.atttypid, att.atttypmod)
    INTO col_type
  FROM pg_attribute att
  WHERE att.attrelid = to_regclass('games')
    AND att.attname = 'deck_rounds_target'
    AND NOT att.attisdropped;

  IF col_type IS NULL THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (009): games.deck_rounds_target column is missing.';
  END IF;

  IF col_type <> 'integer' THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (009): games.deck_rounds_target is %, expected integer.',
      col_type;
  END IF;
END $$;
