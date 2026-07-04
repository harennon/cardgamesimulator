-- 012: retention prune for game_history (LLD 149). game_history (010) is
-- append-only and unbounded; windowed stats never read past YTD, so rows older
-- than the longest window + margin are dead weight against the 500 MB free-tier
-- cap. This DELETEs rows older than 13 months (YTD max reach ~12 months + 1
-- month margin => a live window can never read a pruned row). player_stats (the
-- lifetime aggregate) is NEVER referenced here and is not a prune candidate.

-- Fixed retention floor. Interval literal (not a backend param): this is a
-- data-lifecycle policy invoked by the DB scheduler with no backend in the loop.
CREATE OR REPLACE FUNCTION prune_game_history()
RETURNS bigint AS $$
DECLARE
  deleted bigint;
BEGIN
  DELETE FROM game_history
  WHERE played_at < now() - INTERVAL '13 months';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RAISE NOTICE 'prune_game_history: deleted % row(s) older than 13 months', deleted;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Same grant discipline as increment_player_stats / get_windowed_stats: only the
-- backend/scheduler context may execute it. REVOKE from PUBLIC first.
REVOKE EXECUTE ON FUNCTION prune_game_history FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prune_game_history FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION prune_game_history TO service_role;

-- Schedule daily via Supabase Cron (pg_cron). Idempotent: re-scheduling the same
-- job name updates it in place, so re-applying this migration never duplicates
-- the job. Guarded so the migration still applies where pg_cron is absent (E4).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'prune-game-history',           -- stable job name (idempotent upsert)
      '5 4 * * *',                    -- 04:05 UTC daily, off busy hours
      $cron$ SELECT prune_game_history(); $cron$
    );
  ELSE
    RAISE NOTICE 'pg_cron not present; prune_game_history created but not scheduled (enable Supabase Cron on this project).';
  END IF;
END $$;
