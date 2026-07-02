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

**Where the "enough seats for the engine" check lives.** `addAiSeats` deliberately does **not** validate that the resulting total seat count can reach the engine minimum (e.g. it does not reject a single AI seat for Tonk). It validates only lobby-level invariants (`maxPlayers`, `count >= 1`, `CREATED` status). The engine-minimum check is owned **solely by the relaxed start gate** (Approach B: `game.playerIds.length < engineMin` → `NOT_ENOUGH_PLAYERS`), which is the authoritative guard and the last checkpoint before `engine.initialize`. Rationale: seats are added incrementally (host + human joins + AI seats can arrive in any order during the `CREATED` lobby), so a total-count check at each `addAiSeats` call would be premature and could reject valid interim states. Centralizing the minimum-seat check at the start gate avoids a duplicated/omitted validation and keeps a single source of truth. The sub-issue-2 UI may surface a friendlier pre-check, but it is advisory; the start gate remains the enforcement point.

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
- **Memoization invariant (load-bearing).** `addAiSeats` mutates `aiPlayerIds` while the game is still `CREATED`. If the memo were populated during `CREATED` — before the last `addAiSeats` call — it could cache an incomplete set that is never refreshed. Therefore the invariant is: **the `aiPlayerIds` memo must not be populated until the game has left `CREATED` (i.e. only on/after `startGame` sets `IN_PROGRESS`).** Two mechanisms satisfy this; the implementer picks one:
  - **(preferred) `isAiSeat` only memoizes when `game.status !== "CREATED"`.** During `CREATED` it may read through without caching (there is no hot-path caller during `CREATED` — the only consumer is the `IN_PROGRESS` auto-play loop), and it caches the immutable set on the first read once the game is running. This keeps `addAiSeats` free of memo concerns.
  - **(alternative) `addAiSeats` invalidates the memo entry** (`aiSeatCache.delete(gameId)`) after each mutation.
  This is stated as a correctness-by-invariant requirement, not an incidental note: the only current consumer is the `IN_PROGRESS` auto-play path, and the memo must never observe a partially-seated `CREATED` game. `isAiSeat` must never be relied on to gate behavior *during* `CREATED`.
- Replace the three `connectionManager.isAbandoned(...)` call sites that gate auto-play with `shouldAutoPlay(...)`:
  - `autoPlayAbandoned` loop condition (~line 109).
  - `handleGameAction`'s post-action "next player abandoned?" check (~line 456).
  - `handleTimerExpired`'s post-action next-player check (~line 642).
- The **divergence guard** (`maxIterations = playerCount * MAX_AUTO_ACTIONS_PER_SEAT`) stays. In an all-but-one-AI game the loop may drive several consecutive seats per human action; the cap is per-seat so it still bounds correctly. In a **1-human + N-AI** game the human still takes real turns, so the loop only runs across the contiguous AI seats between human turns, then stops at the human (correct exit at the `!shouldAutoPlay` branch).

**Kicking off AI turns after the human acts and at game start.** `handleGameAction` already calls `autoPlayAbandoned` after a human move when the *next* seat is driven. With `shouldAutoPlay`, this now fires for AI seats too — no new call site needed there. **However**, two gaps must be closed:

1. **Game start.** After `handleGameStart` → `startGame`, if the **first** seat to act is an AI seat, nothing currently drives it. Add a call to `autoPlayAbandoned` at the end of `handleGameStart` (after the initial broadcast), mirroring the post-action pattern. For human-first games this is a no-op (the first seat is not driven), so human-vs-human is unaffected.

   **Timer ordering when the first seat is AI.** `handleGameStart` currently calls `turnTimerService.startTurn(gameId, true)` unconditionally (~line 337) before the broadcast. When the first actor is an AI seat, this would arm a real turn timer *on the AI seat* for the brief window before `autoPlayAbandoned` runs. This is benign (a timer expiry would just call `getAutoTimeoutAction` for the same AI seat), but the timer is redundant/confusing and should not be left armed. Required handling: **the initial `startTurn(gameId, true)` must be skipped when the first seat is an AI seat**, deferring turn-timer arming to `autoPlayAbandoned` (which arms the timer via `startTurn(gameId, false)` only when it stops at a human, `i > 0`). Concretely, gate the initial `startTurn(true)` on `!(await gameService.isAiSeat(gameId, firstSeatId))` where `firstSeatId` is the seat at `state.currentPlayerIndex` returned from `startGame`. `registerGame` still happens unconditionally so the timer service is configured for later human turns. For human-first games this is unchanged (the initial `startTurn(true)` still fires). Note: per the memoization invariant, `isAiSeat` is consulted here only *after* `startGame` has set `IN_PROGRESS`, so the memo is safe to populate at this point.
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

### E. Rematch strips the practice/AI marker (`GameService.createRematch`, ~line 131)

`createRematch` carries `oldGame.gameConfig` forward verbatim into the new game (line 184) and rebuilds the roster from `connectedPlayerIds` (lines 154–157). AI seats are **server-driven and never hold a socket**, so `connectionManager.getConnectedPlayerIds` never returns an `ai:` id, and the rematch roster is therefore **always human-only**. This creates two problems if the config is copied blindly:

- A rematch would keep `practice: true` and a stale `aiPlayerIds` referencing ids that are no longer in `playerIds`. A now-all-human rematch would then be silently excluded from stats/history — a data-loss bug.
- A 1-human + 1-AI Big2 practice game could never be rematched: the lone connected human fails the `rematchPlayerIds.length < 2` guard (line 163) and throws `NOT_ENOUGH_PLAYERS`.

**Decision: a rematch of a practice game becomes a normal human-only game.** The AI seats do not carry over. Rationale: (a) re-seating AI on rematch is a UX/product decision that belongs to sub-issue 2's create-game flow, not to the backend foundation; (b) the connection-roster rebuild already drops AI seats, so the *only* correct config for the rematched roster is one with the AI marker removed. Re-seating AI would additionally require regenerating `aiPlayerIds` to match new synthetic ids and is explicitly out of scope here.

Mechanism: when building the rematch config, **strip** `practice` and `aiPlayerIds`, preserving only game-mechanic config (e.g. `deckRoundsTarget`). Concretely, derive a `rematchConfig` from `oldGame.gameConfig` with `practice`/`aiPlayerIds` omitted and pass **that** to `createGame` instead of `oldGame.gameConfig`.

The existing `rematchPlayerIds.length < 2` guard is **kept unchanged**: a rematch always requires ≥2 connected humans (a solo human cannot rematch a practice game into a valid game, and this LLD does not add AI re-seating that would make a solo rematch viable). The resulting error is the existing `NOT_ENOUGH_PLAYERS`, which is the correct signal for the sub-issue-2 UI to interpret (i.e. "rematch needs another human, or re-create as practice"). No new error code, and human-vs-human rematch is unaffected because those configs never carry `practice`/`aiPlayerIds`.

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
// createRematch: internal change only (strip practice/aiPlayerIds from the
//   config passed to createGame); signature unchanged.
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
- **In-memory (GameService memo):** `aiPlayerIds` set per game, mirroring the existing `joinCodeCache` pattern, but populated **only once the game has left `CREATED`** (see Approach C, "Memoization invariant"). AI seats are still mutable during `CREATED` (via `addAiSeats`); memoizing then could cache an incomplete set. Safe to memoize once `IN_PROGRESS` because AI seats are fixed thereafter.
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
13. **Rematch of a practice game.** `createRematch` strips `practice`/`aiPlayerIds` from the config it forwards, so the rematched game is a normal human-only game (see Approach E). Because AI seats never hold a socket, the connection-roster rebuild already drops them; if ≥2 humans were connected, the rematch starts as a clean non-practice game (stats/history recorded normally). If only 1 human was connected (e.g. 1-human + 1-AI Big2), the existing `rematchPlayerIds.length < 2` guard throws `NOT_ENOUGH_PLAYERS` — solo rematch of a practice game is not supported in this increment (no AI re-seating). Human-vs-human rematch is unchanged (those configs carry no practice/AI fields, so the strip is a no-op).

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
- Returns true for a seated AI id, false for a human id and for an unknown id (queried after the game is `IN_PROGRESS`).
- **Memoization invariant:** memo is not populated (or is invalidated) while the game is `CREATED`. Test: `addAiSeats` twice on a `CREATED` game (or interleave an `isAiSeat` read between two `addAiSeats` calls), then `startGame`, then assert `isAiSeat` returns true for **every** seated AI id — proving no stale/incomplete set was cached from the `CREATED` phase. After `IN_PROGRESS`, memoization returns a consistent result without re-reading.

### Unit — `createRematch` strips practice/AI
- Rematch of a completed 2-human + 1-AI Big2 practice game with 2 connected humans → new game starts with `practice`/`aiPlayerIds` **absent** from its `gameConfig`, roster is the 2 humans only, and a subsequent completion records stats (not skipped).
- Rematch of a completed 1-human + 1-AI Big2 practice game with only the 1 human connected → throws `NOT_ENOUGH_PLAYERS` (existing guard).
- **Regression:** rematch of a human-vs-human game is unchanged — config forwarded intact (e.g. `deckRoundsTarget` preserved for Tonk), no `practice`/`aiPlayerIds` introduced.

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
- **AI-first timer skip:** when the first seat is an AI seat, the initial `turnTimerService.startTurn(gameId, true)` is **not** called on the AI seat; the timer is armed (via `autoPlayAbandoned` → `startTurn(gameId, false)`) only when the loop stops at the human. When the first seat is human, the initial `startTurn(true)` still fires (regression).
- `shouldAutoPlay` returns true for an AI id and for an abandoned human, false for a connected human — verifying the three gates behave for both cases (no regression to abandoned-human auto-play).
- Confirm no socket is ever registered for an `ai:` id (the join gate is never exercised by AI): assert `connectionManager.getPlayerSockets(gameId)` contains no AI id after a full driven game.
