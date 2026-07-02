# LLD 118: Backend — AI-seat foundation (1-human start, auto-driven AI turns, stats/history exclusion)

Parent: #127. Order 1 of 3. Backend-only. No UI, no migration.

## Scope

**Covers (backend/engine only):**

1. A synthetic **AI seat** concept: seat one or more non-human players (each a distinct synthetic `playerId`) and mark a game as **practice** (contains AI seats). Persisted in the existing `games.game_config` JSONB column via an extension of the `GameConfig` type. No new column, no migration.
2. Relaxing `GameService.startGame` so a game starts with **1 human + N AI seats**, while hard-guarding **at least 1 human** (all-AI games rejected).
3. Driving AI seats' turns to completion via the **existing** `autoPlayAbandoned` loop + each engine's `getAutoTimeoutAction` — an AI seat is treated as "always driven by the loop."
4. Excluding practice/AI games from **both** stats writes in `StatsService.recordGameCompletion`: the aggregate `incrementStats` **and** the `recordGameHistory` append.

**Explicitly does NOT cover:**

- Any frontend/UI change. The create-game/lobby UI that seats AI players is sub-issue 2 of #127.
- Any HTTP endpoint to create an AI game (no route change in this increment). Seating AI players and marking practice is exercised in this increment **only** through the service/repository layer and tests. (The route is sub-issue 2's concern; this LLD defines the persisted shape it must produce.)
- Move quality / smart AI. AI seats use the existing `getAutoTimeoutAction` default only. Smart play is #128, separate and later.
- Any new migration or schema change. Uses `game_config` JSONB as-is.
- Removing/altering the guest (`isGuest`) skip. The AI/practice skip is **added alongside** it.

## Approach

### A. AI-seat identity and the practice marker

Extend `GameConfig` (in `src/shared/model.ts`) with two optional fields:

```ts
export interface GameConfig {
  deckRoundsTarget?: number; // existing (Tonk)
  practice?: boolean;        // NEW: true iff this game contains AI seats
  aiPlayerIds?: string[];    // NEW: the synthetic playerIds seated as AI (subset of Game.playerIds)
}
```

- **`practice`** is the single authoritative "exclude from stats/history" flag. It is set true whenever the game is seeded with ≥1 AI seat.
- **`aiPlayerIds`** records *which* seats are synthetic. Needed by (a) the start gate to count humans = `playerIds.length - aiPlayerIds.length`, and (b) future increments (#128, UI). It is a subset of `Game.playerIds`.
- Both fields are absent for ordinary human-vs-human games (backward compatible; `mapGame` already defaults missing config to `{}`).

**AI seat ID scheme.** Each AI seat gets a synthetic `playerId` of the form `ai:<uuid>` (e.g. `ai:` + `crypto.randomUUID()`). Rationale:
- Must be globally unique and never collide with a Supabase user id or a guest session id (guest ids are bare UUIDs from `guestSessionStore`). The `ai:` prefix guarantees no collision with either and is trivially greppable/identifiable.
- `isGuest()` returns false for `ai:` ids (they are not in `guestSessionStore`) — so the AI skip must be a **separate** check, not folded into `isGuest`.
- The prefix is an implementation detail of seat creation; the stats-exclusion decision keys off `game_config.practice`, **not** off parsing the id (see D — `recordGameCompletion` never sees `game_config`, only `InternalGameState`, so parsing would be fragile anyway).

**Where seats are created (this increment).** Provide a `GameService` method that seats AI players onto a `CREATED` game and marks it practice, so tests (and later the sub-issue-2 route) have a single supported entry point rather than mutating the entity ad hoc:

```ts
// GameService
async addAiSeats(gameId: string, count: number): Promise<Game>
```

Behavior:
- Loads the game; throws `GAME_NOT_FOUND` if absent, `GAME_ALREADY_STARTED` if `status !== "CREATED"`.
- Rejects if `playerIds.length + count > maxPlayers` (`GAME_FULL`).
- Rejects `count < 1` (`INVALID_AI_COUNT`).
- Appends `count` synthetic seats: for each, an id `ai:<uuid>` pushed to `playerIds`, a display name (`"CPU 1"`, `"CPU 2"`, … numbered by AI-seat ordinal) into `playerDisplayNames`, and the id into `gameConfig.aiPlayerIds`.
- Sets `gameConfig.practice = true`.
- Persists via `gameRepo.saveGame` (participates in optimistic locking like any other seat mutation).

This keeps the entity mutation in one tested place and mirrors how `joinGame` appends human seats. The `count`/naming/`maxPlayers` interaction with the eventual UI is sub-issue 2's problem; this method is the seam it will call.

### B. Relaxed start gate (`GameService.startGame`, ~line 91)

Replace the flat `minPlayers = 2` / `playerIds.length < 2` rejection with a human-count guard:

- Compute `aiIds = new Set(game.gameConfig.aiPlayerIds ?? [])`.
- `humanCount = game.playerIds.filter(id => !aiIds.has(id)).length`.
- **Reject `humanCount < 1`** with `NO_HUMAN_PLAYERS` (all-AI or empty games rejected).
- **Reject `game.playerIds.length < engineMin`** with `NOT_ENOUGH_PLAYERS`, where `engineMin` is the engine's own minimum (Big2 = 2, Tonk = 3). The total seat count (humans + AI) must still satisfy the engine's minimum, since the engine deals to every seat.

Do **not** keep a hardcoded `minPlayers = 2`; the engines already enforce 2–4 (Big2) and 3–8 (Tonk) in `initialize`, and the human-count guard is the new invariant. Source the per-engine minimum from a small map (below) rather than hardcoding, so Tonk's min-3 is respected on the start path (today `minPlayers=2` under-guards Tonk but the engine's `initialize` throws — we keep that as the backstop but guard correctly here for a clean error).

For the `config` passed to `engine.initialize`, set `minPlayers` to the engine minimum (not a flat 2). `maxPlayers` stays `game.maxPlayers`.

Regular human-vs-human games are unaffected: with no `aiPlayerIds`, `humanCount === playerIds.length`, so a 2-human Big2 game still passes exactly as before, and a 1-human game still fails (now with `NOT_ENOUGH_PLAYERS` for Big2 since total < 2, or `NO_HUMAN_PLAYERS` never triggers because the single human is human).

### C. Driving AI turns (reuse `autoPlayAbandoned`)

The auto-play loop (`socketHandler.ts` ~line 88) already: while the current seat is `isAbandoned`, computes `engine.getAutoTimeoutAction(state)`, applies it, broadcasts, and repeats until a non-driven seat or `COMPLETED`. The move generators are exactly what we want (Big2 pass/lowest, Tonk draw→discard-highest). We must make an **AI seat count as "driven by the loop"** without pretending it is an abandoned human.

**Mechanism (recommended): a `shouldAutoPlay(gameId, playerId)` predicate.** Introduce one predicate that the loop and the post-action check consult instead of `isAbandoned` directly:

```
shouldAutoPlay(gameId, playerId) := isAiSeat(gameId, playerId) || connectionManager.isAbandoned(gameId, playerId)
```

- `isAiSeat` is resolved from the game's `gameConfig.aiPlayerIds`. The socket layer already has the `Game` (via `gameService.getGame`) and the state; expose AI-seat membership through a cheap lookup. Recommended: `GameService.isAiSeat(gameId, playerId)` backed by the same read-through pattern as `getJoinCode` (memoize the `aiPlayerIds` set per game, since it is immutable once the game starts). This avoids a DB read on the hot auto-play path and keeps the socket layer thin.
- Replace the three `connectionManager.isAbandoned(...)` call sites that gate auto-play with `shouldAutoPlay(...)`:
  - `autoPlayAbandoned` loop condition (~line 109).
  - `handleGameAction`'s post-action "next player abandoned?" check (~line 456).
  - `handleTimerExpired`'s post-action next-player check (~line 642).
- The **divergence guard** (`maxIterations = playerCount * MAX_AUTO_ACTIONS_PER_SEAT`) stays. In an all-but-one-AI game the loop may drive several consecutive seats per human action; the cap is per-seat so it still bounds correctly. In a **1-human + N-AI** game the human still takes real turns, so the loop only runs across the contiguous AI seats between human turns, then stops at the human (correct exit at the `!shouldAutoPlay` branch).

**Kicking off AI turns after the human acts and at game start.** `handleGameAction` already calls `autoPlayAbandoned` after a human move when the *next* seat is driven. With `shouldAutoPlay`, this now fires for AI seats too — no new call site needed there. **However**, two gaps must be closed:

1. **Game start.** After `handleGameStart` → `startGame`, if the **first** seat to act is an AI seat, nothing currently drives it. Add a call to `autoPlayAbandoned` at the end of `handleGameStart` (after the initial broadcast), mirroring the post-action pattern. For human-first games this is a no-op (the first seat is not driven), so human-vs-human is unaffected.
2. **Human turn timer path.** Unchanged — humans still get a timer. When a human's action advances to an AI seat, the existing `handleGameAction` branch skips the timer and calls `autoPlayAbandoned` (now true for AI). Good.

**Why not a separate AI driver loop?** A parallel driver would duplicate the exit-condition and completion-broadcast logic already hardened in `autoPlayAbandoned` (timer unregister, `clearGameAbandoned`, completion broadcast). Reusing one loop is the minimal, lowest-blast-radius change and satisfies the acceptance criterion "reuse the existing loop."

**AI seats never open a socket → never hit the join gate.** Confirmed: AI seats are server-driven. Nothing calls `game:join` on their behalf; `connectionManager` never registers a socket for an `ai:` id; `getPlayerSockets` therefore never yields an AI seat, so `broadcastGameState` simply doesn't emit to them (correct — there is no client). The human join gate at `socketHandler.ts` ~line 185 (`game.playerIds.includes(userId)`) is only reached by real client sockets authenticating as their own `userId`; an AI id is never a socket's `userId`. **No change to the join gate is required or made.** The one requirement: AI ids must be present in `game.playerIds` (they are, via `addAiSeats`) so the engine deals them a hand and `getAutoTimeoutAction` can act for them.

### D. Stats + history exclusion (the correctness trap)

`StatsService.recordGameCompletion(state)` receives **only** `InternalGameState`, which does **not** carry `game_config`. The practice flag lives on the `Game` entity. Two ways to get the flag to the skip:

- **Option D1 (recommended): pass a `practice` boolean into `recordGameCompletion`.** `GameService.applyAction` already loads the `Game` (`getGame`) right before firing stats. Change the call to `this.statsService.recordGameCompletion(result.newState, game.gameConfig.practice === true)`. `recordGameCompletion` gains a `practice = false` parameter and, when true, **returns immediately before the per-player loop** — skipping *both* `incrementStats` and `recordGameHistory` for every seat in one guard. Minimal, explicit, and impossible to half-apply (both writes are inside the loop the guard precedes).
- **Option D2: stamp `practice` onto `InternalGameState`.** Add a `practice?: boolean` to engine state at `initialize`. Rejected: it pollutes the pure engine state with a non-game concept, touches both engines, widens the serialized state shape, and gains nothing over D1 (the service already has the `Game`).

**Chosen: D1.** Signature becomes:

```ts
async recordGameCompletion(
  state: InternalGameState,
  practice: boolean = false,
): Promise<void>
```

Guard, placed after the existing `status`/`scores` early-returns and before the `for (const playerScore …)` loop:

```
if (practice) return;
```

Because the guard is above the loop, it skips **both** writes for **all** seats — satisfying the acceptance criterion that a test checking only the aggregate is insufficient. The existing per-player `isGuest()` skip is unchanged and still runs for non-practice games.

The default `practice = false` keeps every other caller (there is exactly one: `applyAction`) and all existing tests behaving identically unless they opt in.

## Interfaces / Types

**`src/shared/model.ts` — extend `GameConfig`:**

```ts
export interface GameConfig {
  deckRoundsTarget?: number;
  practice?: boolean;      // true iff the game contains AI seats
  aiPlayerIds?: string[];  // synthetic playerIds seated as AI; subset of Game.playerIds
}
```

**`src/backend/service/gameService.ts`:**

```ts
// New
async addAiSeats(gameId: string, count: number): Promise<Game>;
// New — memoized AI-seat membership (immutable post-start)
isAiSeat(gameId: string, playerId: PlayerId): Promise<boolean>;
// startGame: internal change only (human-count guard); signature unchanged.
// applyAction: passes game.gameConfig.practice into recordGameCompletion.
```

**`src/backend/service/statsService.ts`:**

```ts
async recordGameCompletion(
  state: InternalGameState,
  practice?: boolean, // default false; when true, skips BOTH writes for all seats
): Promise<void>;
```

**`src/backend/websocket/socketHandler.ts`:** introduce a local helper used by the three auto-play gates:

```ts
async function shouldAutoPlay(
  gameId: string,
  playerId: PlayerId,
  gameService: GameService,
  connectionManager: ConnectionManager,
): Promise<boolean>; // isAiSeat || isAbandoned
```

(These three sites are currently synchronous `isAbandoned` checks; making them consult an async `isAiSeat` requires `await`. The memoized lookup avoids DB latency; the call sites are already inside `async` functions.)

New error codes (thrown as `Error(message)`, surfaced by the socket ack like existing ones): `NO_HUMAN_PLAYERS`, `GAME_FULL`, `INVALID_AI_COUNT`. `NOT_ENOUGH_PLAYERS` is reused.

## State Model

- **Persisted (Supabase `games` row):** `player_ids` includes AI ids; `player_display_names` includes AI names; `game_config` JSONB now may carry `{ practice: true, aiPlayerIds: [...] , deckRoundsTarget? }`. Written by `addAiSeats` via `saveGame` (already persists `game_config`). No schema change — `game_config` column and its `mapGame`/`saveGame` round-trip already exist.
- **In-memory (engine `InternalGameState`):** unchanged. AI seats appear as ordinary `PlayerInfo` entries in `players[]`; the engine has no notion of "AI" (keeps the engine pure — architecture principle 4). `randomSeed`, hands, turn order all identical to a human game.
- **In-memory (GameService memo):** `aiPlayerIds` set per game, populated on first `isAiSeat`/`getGame` read, mirroring the existing `joinCodeCache` pattern. Safe to memoize because AI seats are fixed once the game leaves `CREATED`.
- **In-memory (ConnectionManager):** unchanged. AI seats are never registered; `abandonedPlayers` never contains an AI id. AI-driven-ness comes entirely from `game_config`, orthogonal to abandonment.
- **Stats/history writes:** for a practice game, **zero** rows written to `player_stats` and **zero** rows to `game_history` for any seat (human or AI). For a normal game, unchanged (guests skipped per-seat; registered humans get both writes).

## Edge Cases

1. **All-AI game (0 humans).** `startGame` throws `NO_HUMAN_PLAYERS`. Verified by the human-count guard, independent of total seat count.
2. **1 human + 1 AI for Big2 (total 2).** Allowed: `humanCount = 1 ≥ 1`, total `2 ≥ engineMin(2)`. Starts.
3. **1 human + 1 AI for Tonk (total 2).** Rejected with `NOT_ENOUGH_PLAYERS` (Tonk min 3). The human guard passes but the engine minimum does not. (Sub-issue-2 UI must seat ≥2 AI for Tonk; this LLD only guarantees the guard is correct.)
4. **1 human + 2 AI for Tonk (total 3).** Allowed. Starts and plays to completion.
5. **First seat to act is an AI seat.** `handleGameStart` now calls `autoPlayAbandoned`, which drives AI seats until the human's turn (or completion). If the human is the first actor, it is a no-op.
6. **Game completes on an AI move inside the loop.** The existing loop's `COMPLETED` branch fires: timer unregistered, abandoned cleared, final broadcast. `applyAction` then fires `recordGameCompletion(state, practice=true)` → **skipped**. (Completion can occur on either a human's action handler or the auto-loop; both route stats through `applyAction`, so the practice flag is honored on both paths.)
7. **AI seat reaches an empty/finished hand (Big2 `finishedPlayerIndices`).** `getAutoTimeoutAction` and the engine already skip finished seats via `getNextActivePlayerIndex`; the loop advances past them. No AI-specific handling needed.
8. **Divergence guard exhausted.** Unchanged behavior: logs a warning, arms no timer. Only reachable via an engine bug; the practice path doesn't change the guard's math (per-seat cap).
9. **`getAutoTimeoutAction` returns `null` for an AI seat.** Loop returns (as today). For Big2 this only happens with an empty hand at a live index (shouldn't occur for the current seat); for Tonk the draw/discard actions are always producible while `IN_PROGRESS`. No stall introduced beyond existing behavior.
10. **Practice flag present but `aiPlayerIds` empty/absent.** Defensive: `practice === true` still forces the stats/history skip (the flag is authoritative). `humanCount` would equal total seats, so the game would start as if all-human — but stats are still excluded. `addAiSeats` always sets both together, so this only arises from hand-crafted data; the skip erring toward "exclude" is the safe direction (never leaks a practice game into stats).
11. **Guest + AI in the same game.** Not a target configuration (a guest is a human seat). If it occurs, `practice=true` skips *everyone* (both guest and registered), which is correct — a practice game records nothing.
12. **Optimistic-lock conflict while adding AI seats.** `addAiSeats` uses `saveGame`; on `OptimisticLockError` the caller (tests / future route) retries by reloading — same contract as `joinGame`. This LLD does not add retry logic inside `addAiSeats` (single-writer during CREATED lobby setup); document that the caller owns retry if it races with human joins.

## Dependencies

- **Must exist (all present):** `game_config` JSONB column + `GameConfig` type (migration 009); `saveGame`/`mapGame` round-trip of `game_config` (supabaseDb); `getAutoTimeoutAction` on both engines; `autoPlayAbandoned` loop; `recordGameCompletion` two-write structure (migration 010 `game_history`); `GameService.getGame`.
- **No new migration.** Uses `game_config` as-is.
- **Blocks:** #127 sub-issue 2 (create-game/lobby UI) consumes `addAiSeats`, the `GameConfig.practice`/`aiPlayerIds` shape, and the relaxed start gate. #128 (smart AI) consumes `aiPlayerIds` to target which seats get better moves.
- **No dependency on** the turn-timer service semantics beyond what the loop already handles.

## Test Requirements

Follow testing-principles: pure/seeded, self-contained, invariant checks, full-game simulation. Use `SeededPRNG` for reproducibility. Tests are automated; no manual table.

### Unit — start gate (`gameService.startGame`)
- 1 human + 1 AI, Big2 → starts (`status IN_PROGRESS`, engine dealt all seats). **Regression-adjacent:** assert AI seat received a hand.
- 0 human + N AI → throws `NO_HUMAN_PLAYERS`.
- 1 human + 1 AI, Tonk (total 2) → throws `NOT_ENOUGH_PLAYERS`.
- 1 human + 2 AI, Tonk (total 3) → starts.
- **Regression:** 2 humans, no AI, Big2 → starts exactly as before. 1 human, no AI, Big2 → still `NOT_ENOUGH_PLAYERS`. 2 humans, no AI, Tonk → still rejected (< 3).

### Unit — `addAiSeats`
- Seats `count` AI ids (prefix `ai:`), sets `practice=true`, populates `aiPlayerIds`, adds display names, persists.
- `count` exceeding `maxPlayers - current` → `GAME_FULL`.
- Called on non-`CREATED` game → `GAME_ALREADY_STARTED`. `count < 1` → `INVALID_AI_COUNT`.

### Unit — `isAiSeat`
- Returns true for a seated AI id, false for a human id and for an unknown id. Memoization returns a consistent result without re-reading after first load.

### Unit — stats/history exclusion (`statsService.recordGameCompletion`)
- **Practice game, both engines' score shapes:** call with `practice=true` and a completed state carrying registered (non-guest) players → assert `incrementStats` **not called** AND `recordGameHistory` **not called** (spy/fake repo, assert zero invocations of *each*). This is the criterion that a spec checking only the aggregate would miss.
- **Regression, non-practice:** `practice=false` (default) with registered players → both `incrementStats` and `recordGameHistory` called once per registered player, with the same derived values as today (win/loss, loss-centric breakdown). Guest seats still skipped.
- **Loss-centric (Tonk) path** under `practice=true` → still fully skipped (both writes) despite the `trueLoser` breakdown.

### Integration — full-game simulation to `COMPLETED` (both engines)
- **Big2, 1 human + 1 AI (seeded):** drive the game via the same auto-loop mechanism (AI seats auto-play; the "human" seat also follows a legal-action strategy picking from `validActions`, or is likewise auto-driven for the smoke test). Assert: (a) every applied action is legal (`engine.validateAction` true before apply / `applyAction.success`), (b) invariant checks after each action (card conservation, current player is active, status monotonic), (c) terminates at `COMPLETED` with a winner and scores.
- **Tonk, 1 human + 2 AI (seeded):** same assertions; runs multiple tricks to match end (`trueLoser` resolved).
- Assert the AI seats produced **only** the `getAutoTimeoutAction` moves (no smart logic) — i.e. Big2 AI passes when not free/first else plays lowest; Tonk AI draws-from-stock then discards highest.

### Integration — end-to-end exclusion
- Create a game, `addAiSeats`, start, drive to `COMPLETED` through `applyAction` (so the fire-and-forget stats call runs with `practice=true`). Using a fake `PlayerStatsRepository`, assert **zero** `incrementStats` calls and **zero** `recordGameHistory` calls for the human seat. (Explicitly assert both counters are 0 — not just the aggregate.)
- **Regression E2E:** same flow with 2 humans, no AI → human seats get exactly one `incrementStats` and one `recordGameHistory` each; confirms the shared `applyAction`→stats path is unbroken.

### Socket-layer (targeted, if socket tests exist in repo)
- After `handleGameStart` where the first actor is an AI seat, the loop advances to the human's turn (or completion) without a client acting.
- `shouldAutoPlay` returns true for an AI id and for an abandoned human, false for a connected human — verifying the three gates behave for both cases (no regression to abandoned-human auto-play).
- Confirm no socket is ever registered for an `ai:` id (the join gate is never exercised by AI): assert `connectionManager.getPlayerSockets(gameId)` contains no AI id after a full driven game.
