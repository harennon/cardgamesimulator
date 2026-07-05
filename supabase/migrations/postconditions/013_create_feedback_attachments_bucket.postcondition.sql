-- Post-condition for 013 (LLD 153): private feedback-attachments bucket exists,
-- deny-by-construction policies on storage.objects, attachment_keys column on
-- feedback, and append_feedback_attachment_key grant discipline verified.
--
-- Shape-based / name-agnostic (LLD 77 §6.2 #2): asserts presence, shape, and
-- privilege set without referencing constraint or index names. Idempotent.
-- Accumulates failures in bad[] and raises once (011 idiom).

DO $$
DECLARE
  bad            text[] := '{}';
  bucket_exists  boolean;
  bucket_public  boolean;
  rls_enabled    boolean;
  policy_count   int;
  col_exists     boolean;
  fn_count       int;
  fn_oid         oid;
  service_can    boolean;
  anon_can       boolean;
  authd_can      boolean;
  public_can     boolean;
BEGIN
  -- 1. Bucket exists.
  SELECT EXISTS (
    SELECT 1 FROM storage.buckets WHERE id = 'feedback-attachments'
  ) INTO bucket_exists;
  IF NOT bucket_exists THEN
    bad := array_append(bad,
      'POSTCONDITION FAILED (013): bucket feedback-attachments is absent from storage.buckets');
  END IF;

  -- 2. Bucket is private (the security-critical assertion).
  SELECT public INTO bucket_public
  FROM storage.buckets
  WHERE id = 'feedback-attachments';
  IF bucket_public IS DISTINCT FROM false THEN
    bad := array_append(bad,
      'POSTCONDITION FAILED (013): bucket feedback-attachments must have public = false');
  END IF;

  -- 3. RLS is enabled on storage.objects.
  SELECT relrowsecurity INTO rls_enabled
  FROM pg_class
  WHERE oid = 'storage.objects'::regclass;
  IF NOT COALESCE(rls_enabled, false) THEN
    bad := array_append(bad,
      'POSTCONDITION FAILED (013): RLS is not enabled on storage.objects');
  END IF;

  -- 4. At least 2 policies on storage.objects reference the bucket id
  --    (shape-based: we check that both the SELECT and INSERT deny policies exist).
  SELECT count(*) INTO policy_count
  FROM pg_policies
  WHERE schemaname = 'storage'
    AND tablename  = 'objects'
    AND (qual LIKE '%feedback-attachments%' OR with_check LIKE '%feedback-attachments%');
  IF policy_count < 2 THEN
    bad := array_append(bad,
      format('POSTCONDITION FAILED (013): expected >= 2 deny policies on storage.objects for feedback-attachments, found %s', policy_count));
  END IF;

  -- 5. feedback.attachment_keys column exists and is an array type.
  SELECT EXISTS (
    SELECT 1
    FROM pg_attribute a
    JOIN pg_class     c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type      t ON t.oid = a.atttypid
    WHERE c.relname   = 'feedback'
      AND n.nspname   = 'public'
      AND a.attname   = 'attachment_keys'
      AND NOT a.attisdropped
      AND t.typcategory = 'A'   -- 'A' = Array in pg_type
  ) INTO col_exists;
  IF NOT col_exists THEN
    bad := array_append(bad,
      'POSTCONDITION FAILED (013): feedback.attachment_keys column is absent or not an array type');
  END IF;

  -- 6. append_feedback_attachment_key exists and grant discipline is correct.
  SELECT count(*) INTO fn_count
  FROM pg_proc
  WHERE proname = 'append_feedback_attachment_key'
    AND pg_function_is_visible(oid);
  IF fn_count <> 1 THEN
    bad := array_append(bad,
      format('POSTCONDITION FAILED (013): expected exactly 1 visible append_feedback_attachment_key function, found %s', fn_count));
  ELSE
    SELECT oid INTO fn_oid
    FROM pg_proc
    WHERE proname = 'append_feedback_attachment_key'
      AND pg_function_is_visible(oid);

    service_can := has_function_privilege('service_role', fn_oid, 'EXECUTE');
    anon_can    := has_function_privilege('anon',         fn_oid, 'EXECUTE');
    authd_can   := has_function_privilege('authenticated',fn_oid, 'EXECUTE');
    public_can  := has_function_privilege('public',       fn_oid, 'EXECUTE');

    IF NOT service_can THEN
      bad := array_append(bad,
        'POSTCONDITION FAILED (013): service_role must have EXECUTE on append_feedback_attachment_key');
    END IF;
    IF anon_can OR authd_can OR public_can THEN
      bad := array_append(bad,
        format('POSTCONDITION FAILED (013): EXECUTE on append_feedback_attachment_key must be revoked from anon/authenticated/PUBLIC (anon=%s, authenticated=%s, public=%s)',
               anon_can, authd_can, public_can));
    END IF;
  END IF;

  IF array_length(bad, 1) > 0 THEN
    RAISE EXCEPTION '%', array_to_string(bad, E'\n');
  END IF;
END $$;
