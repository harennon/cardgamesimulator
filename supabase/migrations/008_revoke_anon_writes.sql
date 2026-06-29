-- 008: Revoke INSERT/UPDATE/DELETE on games, player_stats, feedback from `anon`
-- so the grants match 001's declared SELECT-only intent for the anon role.
--
-- 001 uses CREATE TABLE IF NOT EXISTS. On prod the tables already existed
-- (created by TypeORM, see 001's header), so 001's GRANT block was applied but
-- the tables also carried Supabase's default role grants from the TypeORM era,
-- which include INSERT/UPDATE/DELETE for `anon`. 001 lines 54-56 declare anon
-- as SELECT-only; this migration removes the stray write grants so prod matches
-- that intent. Fresh `supabase start` databases never had these grants, so this
-- is a no-op there.
--
-- This is NOT closing an open door: RLS is enabled (002) with no
-- INSERT/UPDATE/DELETE policies on games/player_stats, and feedback's insert
-- policy requires auth.uid() = user_id (null for anon), so RLS already blocks
-- every anon write (proven by rls.test.ts "Security test 1"). The REVOKE is
-- defense-in-depth: it removes unnecessary privilege surface so we are not
-- relying on RLS alone -- if a policy is ever loosened, the grant is not
-- waiting to become live. REVOKE is inherently idempotent (revoking an absent
-- grant is a silent no-op and does not error), so this is safe on fresh DBs.
-- SELECT for anon is left intact (matches 001 lines 54-56).

REVOKE INSERT, UPDATE, DELETE ON games        FROM anon;
REVOKE INSERT, UPDATE, DELETE ON player_stats FROM anon;
REVOKE INSERT, UPDATE, DELETE ON feedback     FROM anon;
