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

2. **Reuse the join code.** The new game is created with the **same** `joinCode` as
   the finished game so the invite code players already shared keeps working. This
   requires a create path that accepts a caller-supplied join code (see Interfaces).
   Because the old game keeps its row, two games temporarily share a join code; see
   Edge Cases for how `getGameByJoinCode` ambiguity is avoided.

3. **Connected players only, host-anchored.** The new game's player roster is the
   subset of the finished game's players who are **currently connected** to the old
   game room (`connectionManager.getConnectedPlayerIds(oldGameId)`), ordered with the
   **host first** so the host-detection rule (`playerIds[0]` is host) holds in the new
   game. Departed/disconnected players are excluded. Guests are kept as guests (their
   guest IDs are ordinary player IDs; no re-auth).

4. **Server-authoritative guards.** All three constraints are enforced inside
   `createRematch()` on the server; the client only sends intent (`{ gameId }`):
   - **Host-only:** requester must equal `oldGame.playerIds[0]`, else `NOT_HOST`.
   - **Finished game only:** old game must be `COMPLETED`, else `GAME_NOT_FINISHED`.
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
  error?: string; // SocketErrorCode-style string on failure
}

// ServerToClientEvents — add:
/** A rematch was started by the host. Connected clients navigate to newGameId. */
"game:rematchStarted": (payload: GameRematchStartedPayload) => void;

export interface GameRematchStartedPayload {
  newGameId: string;
}
```

Add `"GAME_NOT_FINISHED"` to `SocketErrorCode`. (`NOT_HOST` and
`NOT_ENOUGH_PLAYERS` already exist.)

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
 * Throws: GAME_NOT_FOUND, NOT_HOST, GAME_NOT_FINISHED, NOT_ENOUGH_PLAYERS.
 */
async createRematch(
  oldGameId: string,
  requesterId: PlayerId,
  connectedPlayerIds: readonly PlayerId[],
): Promise<{ newGameId: string; state: InternalGameState }>;
```

Behavior:

1. Load `oldGame`; if null → `GAME_NOT_FOUND`.
2. If `oldGame.status !== "COMPLETED"` → `GAME_NOT_FINISHED`.
3. If `oldGame.playerIds[0] !== requesterId` → `NOT_HOST`.
4. Build `rematchPlayerIds` = `oldGame.playerIds` filtered to those in
   `connectedPlayerIds`, **preserving old order**, then ensure the host is first
   (the host is the requester and, being the one who clicked, is connected). If
   `rematchPlayerIds.length < 2` → `NOT_ENOUGH_PLAYERS`.
5. `newGameId = crypto.randomUUID()`.
6. Create the new row via `gameRepo.createGame(newGameId, gameType, hostId,
   maxPlayers, hostDisplayName, turnTimerSeconds, oldGame.joinCode)`, then add the
   remaining `rematchPlayerIds` with their carried-over display names and
   `saveGame()`. (A small helper assembles the full roster; see State Model.)
7. Call `this.startGame(newGameId, hostId)` (reuses all existing validation +
   shuffle + cache + persist + `markClean`).
8. Mark the old `joinCode` cache entry for the new game (`joinCodeCache.set`).
9. Return `{ newGameId, state }`.

> Note on `createGame` signature: it currently sets only the creator as the initial
> player. To carry over multiple players we either (a) call `createGame` then push
> the rest of `rematchPlayerIds` / `playerDisplayNames` onto the returned `Game` and
> `saveGame`, or (b) add a repository helper. Recommended: **(a)** — no new repo
> method, mirrors how `joinGame` mutates `playerIds`/`playerDisplayNames` and saves.

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
   `ack({ success: false, error: <code> })`.
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

- **Persisted (DB):** A **new** `Game` row (`newGameId`, status `IN_PROGRESS`, reused
  `joinCode`, carried-over `playerIds`/`playerDisplayNames`/`maxPlayers`/
  `gameType`/`turnTimerSeconds`, fresh dealt `state`). The **old** row is untouched
  (`status COMPLETED`).
- **In-memory:** New game state cached via existing `startGame` (`cache.set` +
  `markClean`). New game's join code memoized in `joinCodeCache`. New turn timer
  registered. Old game's in-memory artifacts (timer already unregistered at
  completion; abandoned set already cleared) are unaffected.
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
   scope; remaining players use "Back to Home". (Acceptable: host-only model.)
5. **Guest as host or participant.** Guest IDs are ordinary player IDs; carried over
   as-is, no re-auth. New game starts normally (CX:325).
6. **Double-trigger (host clicks twice / ack + broadcast race).** `rematchPending`
   disables the button after first click; navigation to the same route is idempotent.
   If two `game:rematch` events do slip through, two new games are created — mitigate
   by disabling the button on `actionPending` and clearing it only on navigation/error.
   (Two orphan games are harmless; the host's client navigates to the first
   `newGameId` it receives.)
7. **Join-code ambiguity (old + new game share the code).** `getGameByJoinCode` could
   now match either row. **Required handling:** `createRematch` must ensure the new
   game is the one resolved by the code. Recommended: when creating the new row, the
   old `COMPLETED` row should no longer be discoverable by code. Two acceptable
   options (pick one in implementation, document in code):
   - (a) Null out `oldGame.joinCode` and `saveGame(oldGame)` as part of the rematch
     transaction (the old finished game no longer needs its code). **Recommended** —
     simplest, guarantees uniqueness.
   - (b) Make `getGameByJoinCode` prefer the most-recently-created non-COMPLETED game.
   This must be resolved before implementation; flag to design-reviewer.
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
- **Join code reuse:** new game's `joinCode === oldGame.joinCode`; and per the chosen
  ambiguity fix (case 7), `getGameByJoinCode(code)` resolves to the new game.
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
- `game:rematch` from a non-host → ack `NOT_HOST`, no broadcast.
- `game:rematch` from a spectator socket → `SPECTATOR_CANNOT_ACT`.
- After rematch, a player `game:join(newGameId)` receives a `game:state` with
  `status` IN_PROGRESS and the reused `joinCode`.
- Turn timer is registered/started for the new game when the old game had a timer.

### Security

- Server ignores any client-supplied roster/host claim — only `socket.data.userId`
  and server-computed `getConnectedPlayerIds` determine eligibility (assert a spoofed
  payload cannot add a non-host or a disconnected player).

### Manual (UI only — not automatable)

- Visual check of the four Option-A states against the mockup (host active, non-host
  passive, too-few disabled, error) and mobile stacked layout. Everything else is
  covered by automated tests above.
