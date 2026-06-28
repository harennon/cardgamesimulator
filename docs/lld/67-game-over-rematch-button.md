# LLD 67: Add a restart/play-again button on the game over screen

## Scope

Make the "Rematch" button on the game-over screen functional. On the host's click,
the server creates a **fresh game** carrying over the connected players from the
finished game, reuses the same room/join code, starts it, and routes all connected
players into the new round via a socket broadcast.

**Covers:**

- A new socket event `game:rematch` (host-initiated), handled in `socketHandler.ts`.
- A new `GameService.createRematch()` that builds a new game record from a finished
  one (new `gameId`, reused `joinCode`, connected players only) and starts it.
- Frontend wiring of `GameOverView.vue` for the Option A states: host active button,
  non-host passive ("Host can start a rematch"), too-few-players disabled, error.
- Routing connected players from the old game room into the new game (new `gameId` →
  new route `/game/:newGameId`).

**Does NOT cover (explicitly out of scope):**

- Copy-link / native-share parts of planned LLD 12 — rematch only.
- A ready-up roster (Option B) or countdown-to-bail (Option C). Deferred per CEO call.
- Re-architecting `startGame`. We do not mutate a finished game back to `CREATED`.
- Spectator rematch participation. Spectators are not carried into the new game (a
  spectator may re-join the new game manually if they wish; not specified here).
- Bringing disconnected/departed players back automatically. They are dropped.
- Any change to engine rules, scoring, or `getPlayerView`.

## Approach

**Option A — Instant Rematch (host-driven, one click).** CEO decision recorded on
issue #64. Rationale: lowest-friction, satisfies the CX "no dead ends" principle
(customer-experience.md:13) and the already-specified Rematch semantics
(customer-experience.md:309, 324-325), and reuses the existing host-only "Start Game"
pattern rather than inventing a new protocol.

**Key technical decisions:**

1. **New game record, not in-place restart.** `gameService.startGame` is gated to
   `status === "CREATED"` (gameService.ts:81) and throws `GAME_ALREADY_STARTED`
   otherwise. Rather than relax that guard (which would corrupt the finished game's
   record and its stats), `createRematch()` creates a brand-new `Game` row with a new
   `gameId` and then calls the existing `startGame()` path. This keeps the completed
   game's record and stats intact, and the new game records its own stats on
   completion. (`statsService.recordGameCompletion` operates on the per-game
   `InternalGameState`; two distinct games → two independent stat recordings.)

2. **Transfer the join code to the new game (not naive reuse).** The new game keeps the
   **same** `joinCode` as the finished game so the invite code players already shared
   keeps working. This is a **transfer**, not a duplication: the DB enforces a partial
   unique index `idx_games_join_code ON games (join_code) WHERE join_code IS NOT NULL`
   (migration `001_create_tables.sql:39-40`), so two rows may **not** hold the same
   non-null code. Therefore the rematch flow must **clear the old row's `join_code` and
   persist that clear BEFORE inserting the new row** with the code. If the old code were
   left in place, the new `INSERT` would fail the unique constraint (the same
   `duplicate`/`unique` error `createGame.ts:61-63` retries on) — the failure happens at
   **INSERT time**, not at resolve time. See key decision 2a (repository capability) and
   the step ordering in `createRematch` below.

   **2a. New repository capability required.** The existing `saveGame()`
   (`supabaseDb.ts:100-128`) updates only `game_type, player_ids,
   player_display_names, max_players, status, state, turn_timer_seconds, version,
   updated_at` — it does **not** write `join_code`. There is no existing way to
   clear or change a join code. The LLD adds a focused repository method:

   ```ts
   // GameRepository (database.ts)
   /** Clear the join code on a game row so the code can be transferred to another
    *  game. Persists join_code = NULL. Used by the rematch flow before inserting
    *  the new game with the freed code. */
   clearJoinCode(gameId: string): Promise<void>;
   ```

   Supabase implementation: `UPDATE games SET join_code = NULL, updated_at = now()
   WHERE game_id = $1`. It deliberately does **not** participate in the optimistic
   `version` check used by `saveGame` (the old game is `COMPLETED` and otherwise
   immutable; this is a one-shot terminal edit). Considered alternatives and why
   rejected: (b) give the new game a fresh code and accept the old code becoming
   dead — rejected because it breaks the Decision-2 CX benefit ("the invite code
   players already shared keeps working"); the previously-shared code would silently
   404. (c) make `getGameByJoinCode` prefer the newest non-COMPLETED row — rejected
   because the unique index blocks the duplicate `INSERT` outright, so resolve-time
   preference never gets a chance to run. Transfer (clear-then-reuse) is the only
   option that both passes the constraint and keeps the shared code live.

3. **Connected players only, host-anchored.** The new game's player roster is the
   subset of the finished game's players who are **currently connected** to the old
   game room (`connectionManager.getConnectedPlayerIds(oldGameId)`), ordered with the
   **host first** so the host-detection rule (`playerIds[0]` is host) holds in the new
   game. Departed/disconnected players are excluded. Guests are kept as guests (their
   guest IDs are ordinary player IDs; no re-auth).

4. **Server-authoritative guards.** All constraints are enforced inside
   `createRematch()` on the server; the client only sends intent (`{ gameId }`):
   - **Host-only:** requester must equal `oldGame.playerIds[0]`, else `NOT_HOST`.
   - **Finished game only:** old game must be `COMPLETED`, else `GAME_NOT_FINISHED`.
   - **Rematch-once (idempotency):** the finished game may be rematched at most once,
     detected by `oldGame.joinCode === null` (a prior rematch transferred the code away),
     else `REMATCH_ALREADY_STARTED`. Prevents double-fire from creating a second
     `IN_PROGRESS` game / colliding on the shared code (see Edge Case 6). Does not rely
     on the client disabling the button.
   - **Min 2 connected:** connected roster must have `>= 2` players, else
     `NOT_ENOUGH_PLAYERS`.

5. **Dedicated socket event, not `game:start`.** Add `game:rematch`. `game:start`
   operates on the current (CREATED) game and would not fit; overloading it would
   muddle the lobby flow. `game:rematch` creates + starts the new game and broadcasts
   the new `gameId` to the old room so every connected client navigates.

6. **Routing via a broadcast carrying the new gameId.** On success the server emits
   `game:rematchStarted { newGameId }` to `game:<oldGameId>`. Every connected player
   client (host and non-hosts alike) navigates to `/game/<newGameId>`, where the
   existing `GameView` mount flow runs `game:join` and receives `game:state` for the
   already-`IN_PROGRESS` new game. No new lobby is shown — players land directly in the
   dealt round (the CX "returns to lobby with remaining players" line is satisfied in
   spirit: only remaining connected players are carried over; since the new game is
   created already-started, they go straight into the round rather than an idle lobby).

## Interfaces / Types

### Shared socket-events (`src/shared/socket-events.ts`)

```ts
// ClientToServerEvents — add:
"game:rematch": (
  payload: GameRematchPayload,
  ack: (response: GameRematchResponse) => void,
) => void;

export interface GameRematchPayload {
  gameId: string; // the FINISHED game's id
}

export interface GameRematchResponse {
  success: boolean;
  newGameId?: string; // present on success
  error?: string; // free-form error string; see note below
}

// ServerToClientEvents — add:
/** A rematch was started by the host. Connected clients navigate to newGameId. */
"game:rematchStarted": (payload: GameRematchStartedPayload) => void;

export interface GameRematchStartedPayload {
  newGameId: string;
}
```

**On the `error` field type.** `GameRematchResponse.error` is a **free-form `string`**,
matching the existing ack convention: `GameJoinResponse`, `GameActionResponse`, and
`GameStartResponse` all declare `error?: string` (socket-events.ts:39,57,66), and the
current handlers already put non-`SocketErrorCode` strings in it (e.g.
`"SPECTATOR_CANNOT_ACT"` at socketHandler.ts:302,355 is **not** a member of the
`SocketErrorCode` union). It is **not** typed as `SocketErrorCode`. To keep tests
deterministic, the rematch handler MUST populate `error` with exactly one of these
literal values (the values tests assert on):

- `"NOT_HOST"`
- `"GAME_NOT_FINISHED"`
- `"NOT_ENOUGH_PLAYERS"`
- `"GAME_NOT_FOUND"`
- `"SPECTATOR_CANNOT_ACT"`
- `"REMATCH_ALREADY_STARTED"` (idempotency guard; see Edge Case 6)
- `"INTERNAL_ERROR"` (catch-all wrapper)

Separately, add `"GAME_NOT_FINISHED"` to the `SocketErrorCode` union for use by the
`socket.emit("error", ...)` path (`SocketErrorPayload.code` is typed `SocketErrorCode`).
(`NOT_HOST` and `NOT_ENOUGH_PLAYERS` already exist in the union; `SPECTATOR_CANNOT_ACT`
and `REMATCH_ALREADY_STARTED` are intentionally ack-only strings, consistent with the
existing spectator handling, and are not added to the union.)

### GameService (`src/backend/service/gameService.ts`)

```ts
/**
 * Create and start a fresh game from a finished one.
 * - requesterId must be the finished game's host (playerIds[0]).
 * - oldGame.status must be COMPLETED.
 * - connectedPlayerIds is the eligible roster (connected players from the old game),
 *   passed in by the socket layer (the service has no connection knowledge).
 * - Reuses oldGame.joinCode, maxPlayers, gameType, turnTimerSeconds.
 * Returns the new game's id and started state.
 * Throws: GAME_NOT_FOUND, NOT_HOST, GAME_NOT_FINISHED, REMATCH_ALREADY_STARTED,
 *   NOT_ENOUGH_PLAYERS.
 */
async createRematch(
  oldGameId: string,
  requesterId: PlayerId,
  connectedPlayerIds: readonly PlayerId[],
): Promise<{ newGameId: string; state: InternalGameState }>;
```

Behavior (ordering is load-bearing — the old code must be freed before the new INSERT):

1. Load `oldGame`; if null → `GAME_NOT_FOUND`.
2. If `oldGame.status !== "COMPLETED"` → `GAME_NOT_FINISHED`.
3. If `oldGame.playerIds[0] !== requesterId` → `NOT_HOST`.
4. **Idempotency guard (see Edge Case 6).** If `oldGame.joinCode === null`, the old game
   has already been rematched (its code was transferred away in a prior call) → throw
   `REMATCH_ALREADY_STARTED`. This is the single source of "this game can only be
   rematched once," enforced server-side and independent of the client's button state.
   Capture `transferCode = oldGame.joinCode` (non-null past this point) for step 7.
5. Build `rematchPlayerIds` = `oldGame.playerIds` filtered to those in
   `connectedPlayerIds`, **preserving old order**, then ensure the host (`requesterId`)
   is first (the host clicked, so is connected). If `rematchPlayerIds.length < 2` →
   `NOT_ENOUGH_PLAYERS`. (No code has been transferred yet, so an early throw here leaves
   the old game's code intact and re-clickable.)
6. `newGameId = crypto.randomUUID()`.
7. **Free the code on the old row, then persist:** `await
   this.gameRepo.clearJoinCode(oldGameId)` (sets `join_code = NULL`). Then invalidate the
   old game's join-code cache entry: `this.joinCodeCache.set(oldGameId, null)` so a later
   `getJoinCode(oldGameId)` does not return the stale code. This MUST complete before
   step 8.
8. **Insert the new row with the freed code:** `gameRepo.createGame(newGameId, gameType,
   requesterId, maxPlayers, hostDisplayName, turnTimerSeconds, transferCode)`. Because
   the old row's code is now `NULL`, the partial unique index is satisfied. Then push the
   remaining `rematchPlayerIds` / carried-over `playerDisplayNames` onto the returned
   `Game` and `saveGame()` (a small helper assembles the full roster; mirrors how
   `joinGame` mutates `playerIds`/`playerDisplayNames` and saves). Note: `saveGame` does
   not touch `join_code`, which is correct here — the code was already set by
   `createGame`'s INSERT and must not change.
9. Seed the new game's code into the cache: `this.joinCodeCache.set(newGameId,
   transferCode)`.
10. Call `this.startGame(newGameId, requesterId)` (reuses all existing validation +
    shuffle + cache + persist + `markClean`).
11. Return `{ newGameId, state }`.

> **Failure-window note.** Steps 7→8 are not a DB transaction (the repo exposes per-row
> ops only). If the process crashes between clearing the old code and inserting the new
> row, the old game is left with `join_code = NULL` and no successor exists — the shared
> code is dead but no constraint is violated and no game is corrupted. This is an
> acceptable, rare degradation (the players are already on the game-over screen and can
> fall back to "Back to Home"); a cross-row transaction is out of scope. The ordering is
> chosen so the *only* failure mode is a freed-but-unused code, never a unique-constraint
> violation.

> **Why not naive `createGame(..., oldGame.joinCode)` first?** The partial unique index
> would reject the INSERT while the old `COMPLETED` row still holds the code. The clear
> must be persisted first. See key decision 2.

### Socket handler (`src/backend/websocket/socketHandler.ts`)

```ts
async function handleGameRematch(
  socket, io, payload: GameRematchPayload,
  ack: (r: GameRematchResponse) => void,
  gameService, connectionManager, turnTimerService,
): Promise<void>
```

Behavior:

1. Validate `payload.gameId`; reject spectators (`SPECTATOR_CANNOT_ACT`).
2. `connectedPlayerIds = connectionManager.getConnectedPlayerIds(gameId)`.
3. `const { newGameId, state } = await gameService.createRematch(gameId,
   socket.data.userId, connectedPlayerIds)` — wrapped in try/catch; on throw,
   `ack({ success: false, error: <thrown Error.message> })`. The thrown message is one
   of the literal codes enumerated under "On the `error` field type" above
   (`NOT_HOST`, `GAME_NOT_FINISHED`, `NOT_ENOUGH_PLAYERS`, `GAME_NOT_FOUND`,
   `REMATCH_ALREADY_STARTED`); any unexpected throw is mapped to `"INTERNAL_ERROR"` by
   the outer `.catch` wrapper.
4. Register + start the turn timer for `newGameId` if `turnTimerSeconds != null`
   (same block as `handleGameStart`).
5. `io.to(\`game:${gameId}\`).emit("game:rematchStarted", { newGameId })`.
6. `ack({ success: true, newGameId })`.

> Note: we do **not** broadcast `game:state` for the new game here — connected
> clients navigate to the new route and re-`game:join`, which emits their filtered
> `game:state` (the new game is already `IN_PROGRESS`). This reuses the existing join
> path and avoids cross-room emission complexity.

Register the listener in `registerSocketHandlers` alongside the others, with the same
`.catch` → `ack({ success: false, error: "INTERNAL_ERROR" })` wrapper.

### Frontend

- **`useGameActions.ts`** — add:
  ```ts
  rematch(gameId: string): Promise<{ success: boolean; newGameId?: string; error?: string }>;
  ```
  Mirrors `startGame`: sets `actionPending`, emits `game:rematch`, returns the ack.

- **`GameView.vue`** — pass `isHost`, `actionPending`, and a rematch error ref into
  `GameOverView`; handle `@rematch` by calling `rematch(gameId)` and, on success,
  `router.push(\`/game/${newGameId}\`)`. Also register a `s.on("game:rematchStarted",
  ({ newGameId }) => router.push(\`/game/${newGameId}\`))` listener (this is what pulls
  **non-host** clients in). Guard against double-navigation if the host both gets the
  ack and the broadcast (navigate once; route guard / idempotent `push` to the same
  path is a no-op).

- **`GameOverView.vue`** — new props `isHost: boolean`, `rematchPending: boolean`,
  `rematchError: string | null`, `canRematch: boolean` (host AND >=2 connected
  players present in `players`); emit `rematch`. Replace the hardcoded disabled stub.

## State Model

- **Persisted (DB):** Two row writes, ordered. **(1)** The **old** row's `join_code` is
  set to `NULL` via `clearJoinCode(oldGameId)` (status stays `COMPLETED`; this is the
  only mutation to the old row, and it frees the code for transfer). **(2)** A **new**
  `Game` row is inserted (`newGameId`, status `IN_PROGRESS`, the **transferred**
  `joinCode`, carried-over `playerIds`/`playerDisplayNames`/`maxPlayers`/
  `gameType`/`turnTimerSeconds`, fresh dealt `state`). Write (1) MUST persist before
  write (2)'s INSERT to satisfy the partial unique index on `join_code`.
- **In-memory:** New game state cached via existing `startGame` (`cache.set` +
  `markClean`). `joinCodeCache` is mutated on two keys (both keyed by **gameId**, per
  gameService.ts:20): `joinCodeCache.set(oldGameId, null)` (invalidate the stale code so
  `getJoinCode(oldGameId)` no longer returns it) and `joinCodeCache.set(newGameId,
  transferCode)` (seed the new game's code). New turn timer registered for `newGameId`.
  Old game's other in-memory artifacts (timer already unregistered at completion;
  abandoned set already cleared) are unaffected.
- **Connection/room state:** Players remain in `game:<oldGameId>` until their client
  navigates; on mounting `/game/<newGameId>` they `game:join` the new room. No server
  push moves sockets between rooms — the client drives it.
- **Stats:** Old game's stats were recorded when it completed. New game records its
  own on completion. No shared mutation; two distinct `gameId`s.

State flow on click:

```
host clicks Rematch
  → emit game:rematch { oldGameId }
  → server: createRematch (new row + startGame) → broadcast game:rematchStarted { newGameId }
  → host ack { newGameId } → router.push(/game/newGameId)
  → non-hosts receive game:rematchStarted → router.push(/game/newGameId)
  → each client mounts GameView → game:join(newGameId) → receives game:state (IN_PROGRESS)
```

## Edge Cases

1. **Non-host clicks rematch (spoofed client).** Server rejects with `NOT_HOST`; no
   game created. (Client also hides the active button for non-hosts, but the server is
   authoritative.)
2. **Only 1 connected player remains (others left/disconnected).** Server returns
   `NOT_ENOUGH_PLAYERS`. Client shows the disabled "too few players" state:
   "Only you are still here. Need at least 2 players." (matches mockup C3 copy).
3. **A player disconnected mid-results (not yet left).** Excluded from the new roster
   — `getConnectedPlayerIds` reflects live connections only. CX:324 satisfied
   ("rematch with fewer players"). If their departure drops the count below 2, case 2
   applies.
4. **Host disconnected after game over.** Host is not connected → cannot emit
   `game:rematch` (no socket). Rematch simply isn't initiated. No host-transfer in
   scope; remaining players use "Back to Home". **CEO-acknowledged dead-end note:** this
   mildly tensions CX principle 5 ("No dead ends", customer-experience.md:13) and the
   "Rematch with fewer players" line (customer-experience.md:324) — if the host has left,
   the remaining *connected* players have no rematch affordance and can only return home.
   This is an accepted scope decision for the host-only model (Option A); host-transfer /
   "anyone can rematch" is explicitly deferred. If user feedback shows this dead-end is
   painful, the follow-up is to allow the most-senior connected player to host the
   rematch — flag to CEO at that point. Recorded here so the tradeoff is explicit rather
   than silent.
5. **Guest as host or participant.** Guest IDs are ordinary player IDs; carried over
   as-is, no re-auth. New game starts normally (CX:325).
6. **Double-trigger (host clicks twice / two `game:rematch` events / ack + broadcast
   race).** With join-code transfer plus the unique constraint, a true double-fire is
   **not** harmless and must be guarded server-side, not just by the client. The client
   disables the button on `rematchPending` and navigation to the same route is
   idempotent, but those are best-effort. The authoritative guard is in `createRematch`
   step 4: a game can be rematched **at most once**, detected by `oldGame.joinCode ===
   null` (the prior rematch transferred the code away). Sequence:
   - First `game:rematch`: old code is non-null → proceeds, clears the old code,
     transfers it to `newGameId` A, returns `{ success: true, newGameId: A }`.
   - Second `game:rematch` for the same `oldGameId`: reloads the old game, sees
     `joinCode === null` → throws `REMATCH_ALREADY_STARTED`; **no second row is
     inserted**, so there is no unique-constraint collision and no duplicate
     `IN_PROGRESS` game on the shared code. The handler acks `{ success: false, error:
     "REMATCH_ALREADY_STARTED" }`.
   - The host's client navigates to the first `newGameId` it receives (from its own ack
     or the broadcast, whichever arrives first); the duplicate ack's error is ignored
     because navigation has already occurred (idempotent `router.push`).
   This makes the operation effectively idempotent per `oldGameId` without a DB
   transaction or distributed lock.
7. **Join-code transfer / no resolve-time ambiguity.** Because of the partial unique
   index, at most one non-null code per value can ever exist, so `getGameByJoinCode` is
   **never** ambiguous — the framing of this as a query-resolution problem is incorrect.
   The real constraint is at **INSERT time**: a second row cannot be inserted with a code
   the old `COMPLETED` row still holds. **Required handling** (see key decision 2 / 2a and
   `createRematch` steps 7-8): add the `clearJoinCode(gameId)` repository method, clear
   and persist the old row's `join_code = NULL` **before** inserting the new row, and only
   then `createGame(..., transferCode)`. Note: nulling `oldGame.joinCode` and calling
   `saveGame(oldGame)` does **not** work — `saveGame` (supabaseDb.ts:100-128) does not
   write the `join_code` column, so the clear would not persist and the new INSERT would
   still collide. The new repository method is therefore mandatory, not optional.
8. **Old game not actually COMPLETED (client raced the finish).** `GAME_NOT_FINISHED`
   returned; client shows generic error.
9. **`maxPlayers` vs. carried roster.** Carried roster is always `<= old maxPlayers`,
   so no overflow. New game keeps the same `maxPlayers`; empty seats are joinable via
   the reused code (acceptable — same as a fresh lobby).
10. **Rematch error from server (any code).** Client shows "Couldn't start rematch.
    Try again." (mockup error state), re-enables the host button.

## Dependencies

Must exist before implementation (all present):

- LLD 3 — WebSocket layer (`socketHandler.ts`, `connectionManager.ts`,
  `socketServer.ts` typed events). This is the direct upstream.
- `GameService` (`startGame`, `getGame`, `joinCodeCache`), `GameRepository`
  (`createGame`, `saveGame`), `Game` entity, `joinCodeService.generateJoinCode`.
- **New repository method `clearJoinCode(gameId)`** must be added to the `GameRepository`
  interface (`database.ts`) and implemented in `SupabaseDB` (`supabaseDb.ts`) before
  `createRematch` can be implemented. This is a hard prerequisite — existing `saveGame`
  cannot clear the join code (it omits the `join_code` column). Any other repository
  implementations or repo test doubles/in-memory fakes must also implement it.
- `connectionManager.getConnectedPlayerIds` (exists, line 152).
- `StatsService.recordGameCompletion` (already keyed per-game via `applyAction`).
- Frontend: `useGameActions`, `useSocket`, `GameView.vue`, `GameOverView.vue`,
  vue-router.
- Approved mockup: `docs/mockups/rematch-play-again-button.html` on branch
  `lld-57-rematch-play-again-button` (Option A states). Visual direction approved; no
  re-mockup needed.

## Frontend Design

Per CLAUDE.md this is a visual UI change; the approved mockup already exists (Option A)
and the LLD matches it. No new mockup step. The Option-A states the implementation
must cover (all present in the mockup):

- **Host — ready to rematch (A1):** active gold-bordered "Rematch" button next to
  "Back to Home". Helper text below indicates a rematch starts a new round with the
  players still present.
- **Non-host — waiting on host (A2):** passive, non-interactive "Host can start a
  rematch" indicator (pulse dot) in place of the active button. Not clickable.
- **Dealing / transition:** brief "Dealing a new hand…" helper while navigation +
  re-join completes (the existing `GameView` "Connecting…"/board mount covers the
  landing; the game-over button may show a pending/disabled state between click and
  navigation).
- **Too few players (edge):** Rematch button disabled with message "Only you are still
  here. Need at least 2 players." Shown to the host when `< 2` players are present in
  the results roster.
- **Error:** "Couldn't start rematch. Try again." inline near the actions; host button
  re-enabled.
- **Mobile stacked layout:** the existing `.game-over__actions` already switches to a
  full-width stacked column at `max-width: 767px` (GameOverView.vue:379-389); the new
  states reuse that. New buttons keep `min-height: 48px`, `font-size: 16px` on mobile.

Component contract (`GameOverView.vue`):

- Props added: `isHost`, `rematchPending`, `rematchError`, plus a derived
  `canRematch` (host AND `players.length >= 2`). Connected-player count for the
  too-few-players state is derived from `players` (the results roster reflects who
  finished; combined with the server guard this is the display source).
- Emits: `rematch`.
- The button's `disabled`/variant is chosen by `isHost`, `canRematch`,
  `rematchPending` — but final authority is the server (a disabled-bypass click still
  hits the `NOT_HOST`/`NOT_ENOUGH_PLAYERS` guards).

## Test Requirements

### Unit — GameService (`tests/.../gameService` style, no server/DB; in-memory repo + cache)

- **Regression (required):** `createRematch` succeeds when the old game is
  `COMPLETED` — proves a new game can be started from a finished game, the path that
  `startGame` blocks with `GAME_ALREADY_STARTED`. Assert: new `gameId !== oldGameId`,
  new game `status === "IN_PROGRESS"`, hands dealt, old game still `COMPLETED`.
- **Join code transfer:** new game's `joinCode === <old code>`; the old game's
  `joinCode` is now `null` (cleared via `clearJoinCode`); `getGameByJoinCode(code)`
  resolves to the **new** game and never the old one. Assert the clear is persisted
  (re-fetch old game shows `joinCode === null`), not just mutated in memory.
- **Insert ordering (constraint regression):** with a repo fake that enforces the
  partial-unique-on-non-null-`join_code` rule, assert `createRematch` succeeds (proves
  the old code is cleared **before** the new INSERT). A test that inserts the new row
  *without* first clearing the old code must collide — documents why the ordering exists.
- **Idempotency (rematch-once):** calling `createRematch` twice for the same finished
  game — the second call throws `REMATCH_ALREADY_STARTED` (old game's `joinCode` is
  already `null`), no second new game is created, and no constraint collision occurs.
- **joinCodeCache mutation:** after `createRematch`, `getJoinCode(oldGameId)` returns
  `null` (stale entry invalidated) and `getJoinCode(newGameId)` returns the transferred
  code without an extra DB read (cache seeded).
- **Host-only:** `createRematch` with a non-host `requesterId` throws `NOT_HOST`; no
  new game persisted.
- **Min-2 guard:** `connectedPlayerIds` of length 1 throws `NOT_ENOUGH_PLAYERS`.
- **Roster = connected only, host first:** given old players `[host, B, C]` and
  `connectedPlayerIds = [C, host]` (B departed), new game `playerIds === [host, C]`
  (host first, B excluded), display names carried over.
- **Not-finished guard:** old game `IN_PROGRESS`/`CREATED` throws `GAME_NOT_FINISHED`.
- **Guest carry-over:** a guest-ID player in the connected roster is carried into the
  new game unchanged.
- **Stats isolation:** completing the old game records stats once; completing the new
  game records stats again — assert two independent `recordGameCompletion` calls /
  no double-counting on the old game (can assert via stats repo deltas).

### Integration — socket handler (existing socket integration harness)

- `game:rematch` from the host of a COMPLETED game → ack `{ success: true, newGameId }`
  and a `game:rematchStarted { newGameId }` broadcast received by other connected
  players in the old room.
- `game:rematch` from a non-host → ack `{ success: false, error: "NOT_HOST" }`, no
  broadcast.
- `game:rematch` from a spectator socket → ack `error: "SPECTATOR_CANNOT_ACT"`.
- A **second** `game:rematch` for the same finished game → ack `{ success: false, error:
  "REMATCH_ALREADY_STARTED" }`; no third game row, no duplicate broadcast.
- After rematch, a player `game:join(newGameId)` receives a `game:state` with
  `status` IN_PROGRESS and the **transferred** `joinCode`; `game:join(oldGameId)` /
  resolving the code routes to the new game only.
- Turn timer is registered/started for the new game when the old game had a timer.

### Security

- Server ignores any client-supplied roster/host claim — only `socket.data.userId`
  and server-computed `getConnectedPlayerIds` determine eligibility (assert a spoofed
  payload cannot add a non-host or a disconnected player).

### Manual (UI only — not automatable)

- Visual check of the four Option-A states against the mockup (host active, non-host
  passive, too-few disabled, error) and mobile stacked layout. Everything else is
  covered by automated tests above.
