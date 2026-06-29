-- 009: Add creator-configurable deckRoundsTarget to games (LLD 93 / #60).
-- Additive, nullable INT (mirrors turn_timer_seconds). NULL = creator did not
-- choose; gameService coalesces NULL to the engine default (8) at start.
-- Name-agnostic: a bare ADD COLUMN touches no constraint, so prod's games_pkey1
-- drift is irrelevant. IF NOT EXISTS makes the add re-runnable (001-008 discipline).
ALTER TABLE games
  ADD COLUMN IF NOT EXISTS deck_rounds_target INT;
