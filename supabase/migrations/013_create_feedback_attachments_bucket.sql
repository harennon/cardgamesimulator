-- 013: First use of Supabase Storage. Create a PRIVATE bucket for feedback
-- attachments and RLS on storage.objects so clients cannot read/write it
-- directly; only the backend service_role (bypasses RLS) can. Idempotent &
-- name-agnostic (008/011 idiom): safe on fresh `supabase start` AND on prod.

-- 1. Private bucket (public=false disables the anon CDN read path). Idempotent.
INSERT INTO storage.buckets (id, name, public)
VALUES ('feedback-attachments', 'feedback-attachments', false)
ON CONFLICT (id) DO NOTHING;

-- 2. RLS on storage.objects is already enabled by Supabase's own migrations.
--    Add SELECT + INSERT policies SCOPED to this bucket that no anon/authenticated
--    client can satisfy (deny-by-construction). service_role bypasses RLS, so the
--    backend is unaffected. Guard each CREATE on pg_policies (CREATE POLICY IF NOT
--    EXISTS does not exist) so re-running is a clean no-op (011 idiom).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'feedback_attachments_no_client_read'
  ) THEN
    CREATE POLICY feedback_attachments_no_client_read
      ON storage.objects FOR SELECT
      USING (bucket_id = 'feedback-attachments' AND false);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'feedback_attachments_no_client_write'
  ) THEN
    CREATE POLICY feedback_attachments_no_client_write
      ON storage.objects FOR INSERT
      WITH CHECK (bucket_id = 'feedback-attachments' AND false);
  END IF;
END $$;

-- 3. Link column on feedback (idempotent; no binary in Postgres — keys only).
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS attachment_keys TEXT[] NOT NULL DEFAULT '{}';

-- 4. RPC: atomically append a key to feedback.attachment_keys and return the
--    updated array. service_role calls this from the backend; SECURITY DEFINER
--    runs as the function owner (postgres), bypassing RLS just as service_role
--    already does for direct table access. Idempotent (OR REPLACE).
CREATE OR REPLACE FUNCTION append_feedback_attachment_key(
  p_feedback_id UUID,
  p_key         TEXT
) RETURNS TEXT[]
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
AS $$
  UPDATE feedback
     SET attachment_keys = array_append(attachment_keys, p_key)
   WHERE id = p_feedback_id
   RETURNING attachment_keys;
$$;
