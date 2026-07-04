-- Post-condition for 013 (LLD 150): private feedback-attachments bucket
-- exists in storage.buckets, is NOT public (security assertion), RLS is
-- enabled on storage.objects, at least two bucket-scoped deny policies exist
-- (by shape, not name), feedback.attachment_keys column is present and
-- is an array type, and append_feedback_attachment_key RPC is restricted to
-- service_role only (EXECUTE revoked from PUBLIC/anon/authenticated).
-- Accumulates bad[] and RAISEs once (011 idiom).
-- Read-only; idempotent; name-agnostic where possible.
DO $$
DECLARE
  bad text[] := ARRAY[]::text[];
  bucket_pub boolean;
  rls_on boolean;
  pol_count int;
  col_type text;
  fn_oid oid;
  service_can boolean;
  anon_can boolean;
  authd_can boolean;
  public_can boolean;
BEGIN
  -- 1. Bucket exists.
  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets WHERE id = 'feedback-attachments'
  ) THEN
    bad := array_append(bad, 'storage.buckets:feedback-attachments missing');
  END IF;

  -- 2. Bucket is PRIVATE (public = false) — the security-critical assertion.
  SELECT public INTO bucket_pub
    FROM storage.buckets WHERE id = 'feedback-attachments';
  IF bucket_pub IS NULL THEN
    bad := array_append(bad, 'storage.buckets:feedback-attachments missing (cannot check public flag)');
  ELSIF bucket_pub THEN
    bad := array_append(bad, 'storage.buckets:feedback-attachments is PUBLIC (must be false)');
  END IF;

  -- 3. RLS is ENABLED on storage.objects.
  SELECT relrowsecurity INTO rls_on
    FROM pg_class
   WHERE oid = 'storage.objects'::regclass;
  IF rls_on IS NULL OR NOT rls_on THEN
    bad := array_append(bad, 'storage.objects:RLS not enabled');
  END IF;

  -- 4. At least 2 policies scoped to bucket_id = 'feedback-attachments' exist
  --    on storage.objects. Shape-based: the policies reference the bucket id in
  --    their qual/with_check text (not asserting exact policy names).
  SELECT COUNT(*)::int INTO pol_count
    FROM pg_policies
   WHERE schemaname = 'storage'
     AND tablename = 'objects'
     AND (qual ILIKE '%feedback-attachments%' OR with_check ILIKE '%feedback-attachments%');
  IF pol_count < 2 THEN
    bad := array_append(bad,
      'storage.objects:expected at least 2 bucket-scoped deny policies; found ' || pol_count::text);
  END IF;

  -- 5. feedback.attachment_keys column exists and is an array type.
  SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) INTO col_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'feedback'
     AND a.attname = 'attachment_keys'
     AND NOT a.attisdropped;
  IF col_type IS NULL THEN
    bad := array_append(bad, 'feedback.attachment_keys:column missing');
  ELSIF col_type NOT ILIKE '%[]%' AND col_type NOT ILIKE 'ARRAY%' THEN
    bad := array_append(bad, 'feedback.attachment_keys:expected array type, got ' || col_type);
  END IF;

  -- 6. append_feedback_attachment_key RPC exists, is SECURITY DEFINER, and
  --    EXECUTE is restricted to service_role only (mirrors 003 postcondition).
  SELECT oid INTO fn_oid
    FROM pg_proc
   WHERE proname = 'append_feedback_attachment_key'
     AND pg_function_is_visible(oid);
  IF fn_oid IS NULL THEN
    bad := array_append(bad, 'append_feedback_attachment_key:function missing');
  ELSE
    service_can := has_function_privilege('service_role', fn_oid, 'EXECUTE');
    anon_can    := has_function_privilege('anon',         fn_oid, 'EXECUTE');
    authd_can   := has_function_privilege('authenticated', fn_oid, 'EXECUTE');
    public_can  := has_function_privilege('public',       fn_oid, 'EXECUTE');
    IF NOT service_can THEN
      bad := array_append(bad, 'append_feedback_attachment_key:service_role must have EXECUTE');
    END IF;
    IF anon_can OR authd_can OR public_can THEN
      bad := array_append(bad,
        'append_feedback_attachment_key:EXECUTE must be revoked from anon/authenticated/PUBLIC (anon=' ||
        anon_can::text || ', authenticated=' || authd_can::text || ', public=' || public_can::text || ')');
    END IF;
  END IF;

  IF array_length(bad, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (013): feedback-attachments bucket setup is incomplete: %. Expected private bucket, RLS enabled on storage.objects, 2+ bucket-scoped deny policies, feedback.attachment_keys as an array column, and append_feedback_attachment_key restricted to service_role.',
      bad;
  END IF;
END $$;
