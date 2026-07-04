-- 011: Lock down game_history on prod (revoke stray writes + enable RLS).
--
-- 010 created game_history intending anon/authenticated to be SELECT-only (010
-- lines 21-25). But prod's `public` schema carries TypeORM-era ALTER DEFAULT
-- PRIVILEGES that auto-grant INSERT/UPDATE/DELETE to `anon` AND `authenticated`
-- on every new public table. 010 never revoked them, so they are LIVE on prod
-- (VERIFIED: scripts/fixtures/captures/prod-db-diff-posto10.txt shows all six
-- grant statements). This is the same drift class 008's header documents, except
-- 008 only revoked from `anon`; the capture proves game_history carries the stray
-- grants on BOTH roles.
--
-- Unlike the 008 case (where RLS in 002 already blocked anon writes, so the
-- REVOKE was pure defense-in-depth), game_history has NO RLS. So the grant is a
-- genuinely open door: a holder of the public anon key (shipped in the frontend)
-- can INSERT/UPDATE/DELETE game_history rows directly via PostgREST -- forge or
-- delete other users' history, which feeds time-windowed stats (LLD 101). This
-- migration is therefore a SECURITY fix, not just hygiene.
--
-- Two hardening steps, one logical concern:
--   1. REVOKE the stray write grants (008 idiom, extended to `authenticated`).
--      REVOKE of an absent grant is a silent Postgres no-op, so this is safe on
--      fresh `supabase start` DBs. SELECT is left intact (matches 010).
--   2. ENABLE ROW LEVEL SECURITY + a SELECT-own-rows policy (mirrors player_stats
--      in 002). RLS is defense-in-depth ON TOP OF the revoke: it guarantees even
--      a SELECT is row-scoped to the owner, and no future loosened grant silently
--      reopens writes.
--
-- service_role (backend) is UNTOUCHED: it keeps 010's GRANT ALL and bypasses RLS,
-- so increment_player_stats / get_windowed_stats / history inserts are unaffected.
-- No frontend path reads/writes game_history with the anon/authenticated key.
--
-- Gate note (LLD 77b): on the run that applies 011, `supabase db diff --linked`
-- emits `enable row level security` + `create policy` for game_history. The
-- linked-diff adapter classifies them direction:"drop" and self-attributes them
-- to pending 011 via a raw-text scan (which reads INSIDE this DO $$ block), then
-- drops them as benign -- so they need NO acknowledgedResidual entry. Only the
-- six direction:"add" stray grants are residual; those are acknowledged
-- transiently (issue #176) and removed in the Phase-2 cleanup PR after 011 is
-- applied. 011 emits ONLY `enable` + `create policy` (never `disable`/`drop
-- policy`/`alter policy`, which 77b deliberately does not classify).

-- 1. Revoke the stray TypeORM-era write grants (present on prod for BOTH roles;
--    008 idiom, extended to `authenticated`). SELECT left intact (matches 010).
REVOKE INSERT, UPDATE, DELETE ON game_history FROM anon;
REVOKE INSERT, UPDATE, DELETE ON game_history FROM authenticated;

-- 2. Enable RLS + a SELECT-own-rows policy (mirrors player_stats in 002). No
--    write policies -- the backend uses service_role, which bypasses RLS.
ALTER TABLE game_history ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY IF NOT EXISTS does not exist in Postgres; guard on pg_policies.
-- The guard filters on current_schema() (NOT a literal 'public') so it is correct
-- both on prod (public) and in the throwaway fixture schema the migration tests
-- use -- VERIFIED against the local supabase stack that pg_policies.schemaname for
-- a policy created under `SET search_path TO <schema>` equals current_schema() at
-- run time, so a second run cleanly skips the CREATE (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'game_history'
      AND policyname = 'game_history_select_own'
  ) THEN
    CREATE POLICY game_history_select_own
      ON game_history FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;
