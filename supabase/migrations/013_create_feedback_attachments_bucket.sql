-- 013: Feedback attachment storage foundation (LLD 153).
--
-- Provisions the private `feedback-attachments` Storage bucket, deny-by-construction
-- RLS policies on storage.objects (so only the backend service_role key can
-- read/write objects), a link column on feedback, and a SECURITY DEFINER RPC
-- for atomic key appends.
--
-- All parts are idempotent / name-agnostic (008/011 idiom). No binary in Postgres:
-- the column holds only the storage path (key), never the image bytes.
-- The backend service_role bypasses RLS and is the sole Storage accessor.

-- 1. Private bucket. ON CONFLICT DO NOTHING makes this idempotent.
INSERT INTO storage.buckets (id, name, public)
VALUES ('feedback-attachments', 'feedback-attachments', false)
ON CONFLICT (id) DO NOTHING;

-- 2. Deny-by-construction RLS policies on storage.objects for this bucket.
--    Supabase already has RLS enabled on storage.objects; we add two policies
--    with `AND false` predicates so anon/authenticated can never satisfy them.
--    The service_role key bypasses RLS entirely — it is the sole accessor.
--    CREATE POLICY IF NOT EXISTS does not exist in Postgres; guard via pg_policies.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'feedback_attachments_no_client_read'
  ) THEN
    CREATE POLICY feedback_attachments_no_client_read
      ON storage.objects FOR SELECT
      USING (bucket_id = 'feedback-attachments' AND false);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'feedback_attachments_no_client_write'
  ) THEN
    CREATE POLICY feedback_attachments_no_client_write
      ON storage.objects FOR INSERT
      WITH CHECK (bucket_id = 'feedback-attachments' AND false);
  END IF;
END $$;

-- 3. Link column: storage path keys stored as a text array on the feedback row.
--    No binary in Postgres. ADD COLUMN IF NOT EXISTS is idempotent.
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS attachment_keys TEXT[] NOT NULL DEFAULT '{}';

-- 4. Atomic key-append RPC. Returns the post-append attachment_keys array so the
--    caller can enforce the per-report cap against the authoritative DB value
--    (closes the check-then-append race, E11). SECURITY DEFINER with the same
--    grant discipline as increment_player_stats (003) and prune_game_history (012).
CREATE OR REPLACE FUNCTION append_feedback_attachment_key(p_feedback_id UUID, p_key TEXT)
RETURNS TEXT[]
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE feedback
  SET attachment_keys = array_append(attachment_keys, p_key)
  WHERE id = p_feedback_id
  RETURNING attachment_keys;
$$;

REVOKE EXECUTE ON FUNCTION append_feedback_attachment_key(UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION append_feedback_attachment_key(UUID, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION append_feedback_attachment_key(UUID, TEXT) TO service_role;
