# LLD 140: Rematch does not work in games with CPU/AI opponents

Fixes the practice-game rematch bug from user feedback (issue triaged from 1 report,
route `/game/c44…`). Regression window: human-only rematch shipped in LLD 67 (commit
`bace684`); it broke for practice games when AI seats landed on top of it (LLD 118 `f07a2a3`,
LLD 120 `f9e4b69`). Direct upstream LLDs: **67** (rematch) and **118** (AI-seat foundation);
**120** (create/lobby/board AI labels) is the source of the `isAi` flag the frontend reuses.

## Scope

**Root cause.** `GameService.createRematch` (`gameService.ts:152`) rebuilds the roster from
`connectedPlayerIds` only. AI/CPU seats never open a socket, so
`connectionManager.getConnectedPlayerIds` never returns them and they are always filtered
out. LLD 118 §E then deliberately *strips* `practice`/`aiPlayerIds` from the carried-over
config (`gameService.ts:198-208`). For the common 1-human + N-CPU practice game the roster
collapses to `[host]` (length 1) and the `rematchPlayerIds.length < 2` guard
(`gameService.ts:184`) throws `NOT_ENOUGH_PLAYERS`. On the frontend the button is enabled
whenever `props.isHost && props.players.length >= 2` (`GameOverView.vue:163`) — and `players`
is the full CPU-inclusive roster (`GameView.vue:109`) — so the button looks live but the ack
always fails with the generic "Couldn't start rematch. Try again."

**Covers:**

1. **Backend — re-seat AI on rematch of a practice game.** `createRematch` no longer strips
   the AI markers. When the finished game was a practice game (`gameConfig.practice === true`),
   the rematch is created as a **fresh practice game** that re-seats the **same number** of
   CPU/AI opponents via the existing `addAiSeats` path (new synthetic ids), keeping
   `practice: true`. Human-only (non-practice) rematch behavior is unchanged.
2. **Backend — honest roster guard.** The `< 2` guard is evaluated against the **total** new
   roster (connected humans + re-seated AI) against the engine minimum, so a 1-human + N-CPU
   game no longer throws `NOT_ENOUGH_PLAYERS`.
3. **Frontend — honest Rematch enable state.** `GameOverView.vue`'s enable condition counts
   only the seats that will actually be in the new game (connected humans that finished + the
   CPUs that will be re-seated), so the button's enabled/disabled state matches what the
   backend accepts. No clickable-but-always-fails state.
4. **Frontend — "Rematch lineup" row.** A small "You + N CPUs" line on the game-over screen
   using the existing `AiBadge` atom so the returning CPUs are not a surprise.

**Explicitly does NOT cover:**

- Re-introducing sockets for CPU seats. Re-seating happens **only** via the existing
  `addAiSeats` path at game creation (server-driven, no socket) — same mechanism as LLD 118.
- Smart AI / move quality. Re-seated CPUs use the existing `getAutoTimeoutAction` default.
- Any change to `game:rematch` / `game:rematchStarted` socket events or their payloads
  (LLD 67). The signature of `createRematch` is unchanged.
- Any schema/migration change. `game_config` JSONB is used as-is.
- Reviving human players who disconnected before the rematch. Same as LLD 67 — dropped.
- Changing human-only rematch behavior in any observable way (regression-guarded).

## Approach

**Owner-approved Option A (RECOMMENDED): a practice rematch stays a practice game and
re-seats the same number of CPU/AI opponents.** This reverses the LLD 118 §E decision (which
made a practice rematch a human-only game) for the practice case only. Human-vs-human rematch
is untouched. Rationale: it matches the acceptance criterion's preferred outcome (host lands
in a fresh *practice* game with the same lineup), and it is the minimal honest fix — the CPUs
the host was just playing return, rather than the button silently failing.

### A. `createRematch` re-seats AI for practice games (`gameService.ts`)

The current flow: build human-only `rematchPlayerIds` from `connectedPlayerIds`, guard `< 2`,
`clearJoinCode(old)`, `createGame(..., rematchConfig)` with `practice`/`aiPlayerIds` stripped,
attach carried-over human roster, `startGame`. The fix inserts an AI re-seat step and moves
the count guard.

**Steps (deltas from current code called out):**

1–4. Load / `GAME_NOT_FINISHED` / `NOT_HOST` / `REMATCH_ALREADY_STARTED` idempotency guard —
   **unchanged** (`gameService.ts:157-172`).

5. Determine practice-ness and CPU count from the **old** game:
   - `const oldAiIds = oldGame.gameConfig.aiPlayerIds ?? []`
   - `const aiSeatCount = oldAiIds.length`
   - `const isPractice = oldGame.gameConfig.practice === true`
   (Both read from persisted config — authoritative, not client-supplied.)

6. Build the connected-human roster exactly as today: filter `oldGame.playerIds` to
   `connectedPlayerIds`, host-first. **Note:** because AI ids are never connected, this filter
   already yields **humans only** — so `rematchHumanIds` needs no explicit AI exclusion. Do
   **not** re-order or reuse old AI ids; they are regenerated in step 9.

7. **Move the count guard to be roster-total aware.** Replace the flat
   `if (rematchHumanIds.length < 2) throw NOT_ENOUGH_PLAYERS` with a guard against the
   **projected total seats** and the **human minimum**:
   - `const projectedTotal = rematchHumanIds.length + (isPractice ? aiSeatCount : 0)`
   - Require **≥ 1 connected human** (a rematch is always host-initiated, so ≥1 is guaranteed,
     but assert it for clarity): if `rematchHumanIds.length < 1` → `NOT_ENOUGH_PLAYERS`.
   - Require the projected total to satisfy the engine minimum:
     `const engineMin = ENGINE_MIN_PLAYERS[oldGame.gameType] ?? 2`; if
     `projectedTotal < engineMin` → `NOT_ENOUGH_PLAYERS`.
   - For a **non-practice** game this reduces to `rematchHumanIds.length < engineMin` (Big2:
     `< 2`, Tonk: `< 3`) — i.e. **stricter/identical** to today for human-only games (see
     Edge Case 7 on the intentional Tonk tightening). For the 1-human + N-CPU practice case,
     `projectedTotal = 1 + N ≥ engineMin`, so it passes.
   This early throw happens **before** `clearJoinCode`, so a rejected rematch leaves the old
   game's code intact and re-clickable — same property LLD 67 relied on.

8. `clearJoinCode(old)` + cache invalidation + `hostDisplayName` — **unchanged**
   (`gameService.ts:190-196`).

9. **Config carry-over — stop stripping for practice games.** Replace the unconditional
   strip (`gameService.ts:198-208`) with:
   - **Practice game:** forward a `rematchConfig` that **omits** `aiPlayerIds` (the old
     synthetic ids are dead; `addAiSeats` will mint fresh ones) but **preserves** other
     game-mechanic config (e.g. `deckRoundsTarget` for Tonk). Do **not** set `practice` on the
     initial `createGame` config — `addAiSeats` (step 11) sets `practice: true` and repopulates
     `aiPlayerIds` as its documented side effect. So `rematchConfig` for a practice game =
     `{ ...oldGame.gameConfig }` with `practice` and `aiPlayerIds` removed (same object shape
     the strip produces today); the difference is what happens in step 11.
   - **Non-practice game:** identical to today — strip is a no-op because those configs never
     carry `practice`/`aiPlayerIds`; forward `{ ...oldGame.gameConfig }` (preserving
     `deckRoundsTarget`).
   In both branches the object passed to `createGame` carries no `practice`/`aiPlayerIds`; the
   only behavioral change is the subsequent `addAiSeats` call for the practice branch.

10. `createGame(newGameId, …, transferCode, rematchConfig)` then attach the carried-over
    **human** roster and `saveGame` — **unchanged** (`gameService.ts:209-228`). The new row now
    has exactly the connected humans as seats, host first.

11. **NEW — re-seat AI for practice games.** If `isPractice && aiSeatCount >= 1`:
    `await this.addAiSeats(newGameId, aiSeatCount)`. This reuses the LLD 118 method verbatim:
    it appends `aiSeatCount` fresh `ai:<uuid>` seats to `playerIds`, assigns display names
    (`CPU 1`, `CPU 2`, … via `aiNameForOrdinal`), sets `gameConfig.practice = true`, and
    populates `gameConfig.aiPlayerIds`. No AI seat ever opens a socket — driving is handled by
    the existing `autoPlayAbandoned` loop after `startGame`, exactly as for a fresh practice
    game created via `POST /createGame` (LLD 120).
    - **`maxPlayers` headroom is guaranteed:** the new roster is `humans + aiSeatCount`, and
      `humans ≤ old humans` and `aiSeatCount = old AI count`, so
      `humans + aiSeatCount ≤ old total ≤ oldGame.maxPlayers`. `addAiSeats`'s `GAME_FULL` guard
      therefore never trips on the rematch path. (Reasoned, not merely asserted — see Edge
      Case 5.)

12. `this.joinCodeCache.set(newGameId, transferCode)` then
    `const state = await this.startGame(newGameId, requesterId)` — **unchanged**
    (`gameService.ts:230-234`). `startGame` re-reads the row (now including the AI seats), so
    the engine deals to every seat and the human-count guard passes (≥1 human, total ≥
    engineMin). The socket handler's post-`startGame` `autoPlayAbandoned` call
    (`socketHandler.ts:460`) drives any CPU seats whose turn comes up — including a CPU-first
    deal — with no new call site.

13. Return `{ newGameId, state }` — **unchanged**.

**Why re-seat via `addAiSeats` and not carry old ids forward?** Old `ai:<uuid>` ids are
meaningless in the new game (the engine deals by seat, ids are opaque), and reusing them would
require re-deriving `aiPlayerIds` and display names by hand — exactly the ad-hoc entity
mutation LLD 118 centralized into `addAiSeats`. Minting fresh seats through the one supported
seam keeps the diff surgical and the persisted shape identical to a fresh practice game.

**Stats/history.** A re-seated rematch keeps `practice: true`, so its completion is excluded
from stats/history by the existing `applyAction` → `recordGameCompletion(state, practice)`
guard (LLD 118 §D). This is the correct behavior: a practice rematch is still practice. (This
also fixes the latent LLD 118 §E data concern in the *opposite* direction — there is no
now-all-human rematch to mis-record, because practice rematches stay practice and human-only
rematches were never practice.)

### B. Frontend — honest enable state + lineup row (`GameOverView.vue`, `GameView.vue`)

The board `gameState.players` at `COMPLETED` are `PlayerPublicInfo[]` and **already carry
`isAi`** (server-injected via `getAiSeatIds` in `broadcastGameState`, LLD 120 §B). So the
component can distinguish humans from CPUs without any new prop or server field.

- **`canRematch` must count the seats that will actually be in the new game.** The new game =
  connected humans that finished + re-seated CPUs. `players` (the results roster) reflects who
  finished. The honest projected count is:
  - `humanCount = players.filter(p => !p.isAi).length`
  - `aiCount = players.filter(p => p.isAi).length`
  - `projectedTotal = humanCount + aiCount` (which equals `players.length` when nobody
    disconnected during results).
  Enable when `isHost && humanCount >= 1 && projectedTotal >= engineMin`. Because the engine
  minimum differs by game type (Big2 = 2, Tonk = 3), pass an `engineMin` prop (see below)
  rather than hardcoding `>= 2`. For a human-only Big2 game this is `players.length >= 2` —
  identical to today. For a 1-human + N-CPU practice game it is `1 + N >= 2` (true for N ≥ 1) —
  the button is correctly **enabled**.
  - Rationale for the human-count factor: the results roster does not itself drop a human who
    disconnected on the game-over screen, so the *display* projection can over-count by at most
    the humans who left after finishing. The **server remains authoritative** (it rebuilds from
    live `connectedPlayerIds`); if a human left, the server's `NOT_ENOUGH_PLAYERS` still fires
    and the existing error path shows. This is the same best-effort-client / authoritative-server
    split LLD 67 established; the change here only removes the *systematic* false-positive for
    CPU games, it does not claim perfect client prediction.
- **Too-few-players hint** (`data-testid="rematch-too-few"`) shows when `isHost && !canRematch`
  — unchanged trigger, but now correctly does **not** show for a valid CPU game. Copy stays
  "Only you are still here. Need at least 2 players." for the Big2 human-only case; see
  Frontend Design for the Tonk-aware wording note.
- **Rematch lineup row** (new, `data-testid="rematch-lineup"`): rendered for the host when
  `canRematch` and `aiCount >= 1`. Reads e.g. "Rematch: You + 2 CPUs" with the CPU count
  rendered next to an `AiBadge`. Purely informational; see Frontend Design.

`GameView.vue` passes a new `engineMin` prop to `GameOverView` derived from the current game
type (`gameState.gameType` → `Big2 = 2`, `Tonk = 3`), reusing the same per-engine minimum the
backend keeps in `ENGINE_MIN_PLAYERS`. `onRematch` / `rematchError` wiring is unchanged.

## Interfaces / Types

**`src/backend/service/gameService.ts`** — internal change only; signature unchanged:

```ts
// createRematch: re-seats AI for practice games; roster-total-aware count guard.
async createRematch(
  oldGameId: string,
  requesterId: PlayerId,
  connectedPlayerIds: readonly PlayerId[],
): Promise<{ newGameId: string; state: InternalGameState }>;
```

No new error codes. `NOT_ENOUGH_PLAYERS` is reused with a broadened (roster-total) meaning.
`ENGINE_MIN_PLAYERS` (already defined, `gameService.ts:18`) is the source of the per-engine
minimum used by the new guard.

**`src/frontend/component/game/GameOverView.vue`** — new prop + derived state:

```ts
const props = defineProps<{
  // …existing props…
  engineMin: number; // NEW: engine seat minimum for the current game type (Big2 2, Tonk 3)
}>();

// canRematch now counts humans + AI from the results roster (both already carry isAi)
const humanCount = computed(() => props.players.filter((p) => !p.isAi).length);
const aiCount = computed(() => props.players.filter((p) => p.isAi).length);
const canRematch = computed(
  () =>
    props.isHost &&
    humanCount.value >= 1 &&
    props.players.length >= props.engineMin,
);
```

**`src/frontend/component/game/GameView.vue`** — pass the new prop:

```ts
:engine-min="gameState.gameType === 'tonk' ? 3 : 2"
```

(`gameState.gameType` is already present on the client state; reuse it. If a shared constant
map exists, prefer importing it over the inline ternary — implementer's discretion, but keep
the two numbers in sync with backend `ENGINE_MIN_PLAYERS`.)

No new socket events, no new REST fields, no `PlayerPublicInfo` change (the `isAi` flag from
LLD 120 is sufficient).

## State Model

- **Persisted (Supabase `games`):** rematch of a practice game inserts a new row whose
  `game_config` carries `{ practice: true, aiPlayerIds: [<fresh ai:uuid…>], deckRoundsTarget? }`
  and whose `player_ids` = connected humans (host first) + fresh AI seats. Same shape a fresh
  practice game produces via `POST /createGame` + `addAiSeats`. The old row's `join_code` is
  cleared (transferred) exactly as in LLD 67. Human-only rematch persists an identical row to
  today (no `practice`/`aiPlayerIds`).
- **In-memory (engine `InternalGameState`):** unchanged / AI-agnostic. Re-seated CPUs are
  ordinary `PlayerInfo` entries; the engine deals them hands like any seat (principle 4).
- **In-memory (GameService memos):** `joinCodeCache` mutated on the two keys as in LLD 67.
  `aiSeatCache` for the **new** gameId is populated on first `getAiSeatIds`/`isAiSeat` read
  after `startGame` sets `IN_PROGRESS` (LLD 118 memo invariant — safe because seats are fixed
  once `IN_PROGRESS`; `addAiSeats` here runs while the new game is still `CREATED`, before
  `startGame`).
- **Connection/room state:** unchanged. AI seats are never registered as sockets; the loop
  drives them. Connected humans navigate to the new room and `game:join` as in LLD 67.
- **Client:** `GameOverView` derives `humanCount`/`aiCount` from `players` (already `isAi`-
  tagged). No new persisted or transient client state.

## Edge Cases

1. **1 human + N CPU practice game, Big2 (the reported bug).** Old bug: `NOT_ENOUGH_PLAYERS`.
   Fixed: `rematchHumanIds = [host]` (1), `aiSeatCount = N`, `projectedTotal = 1 + N ≥ 2`,
   guard passes; `addAiSeats(new, N)` re-seats N CPUs; `startGame` deals 1 + N seats and drives
   the CPU turns. Frontend button correctly enabled.
2. **2 humans + 1 CPU mixed practice game.** Both humans connected → `rematchHumanIds` = 2,
   `aiSeatCount = 1`, `projectedTotal = 3`; re-seats 1 CPU; new game is a 2-human + 1-CPU
   practice game. Still `practice: true` → excluded from stats (correct). Required regression
   test (b).
3. **2 humans + 1 CPU, but one human disconnected on the results screen.** Server rebuilds from
   live `connectedPlayerIds` → `rematchHumanIds` = 1, `aiSeatCount = 1`, `projectedTotal = 2 ≥
   2` (Big2) → **still valid**, re-seats 1 CPU, starts a 1-human + 1-CPU practice game. (The
   client's `canRematch` may have shown enabled based on 2 humans in the roster; the server
   silently succeeds with the smaller-but-valid roster. No error.)
4. **1 human + 1 CPU practice game, but the human is the only connected seat (always true for
   CPUs).** `projectedTotal = 1 + 1 = 2 ≥ 2` (Big2) → valid. This is the case LLD 118 §E
   explicitly could **not** rematch (it threw `NOT_ENOUGH_PLAYERS`); Option A fixes it.
5. **`maxPlayers` headroom on re-seat.** `humans + aiSeatCount ≤ old total ≤ maxPlayers`, so
   `addAiSeats`'s `GAME_FULL` guard never trips (see Approach A step 11). No special handling.
6. **Non-practice human-vs-human rematch.** `isPractice === false` → no `addAiSeats` call;
   config forwarded intact (`deckRoundsTarget` preserved for Tonk). Byte-for-byte identical to
   today. Regression-guarded.
7. **Tonk human-only rematch with exactly 2 connected humans.** New guard requires
   `projectedTotal ≥ engineMin(3)` → `2 < 3` → `NOT_ENOUGH_PLAYERS`. This is **stricter** than
   the old flat `< 2` guard (which wrongly let a 2-human Tonk rematch through to `startGame`,
   where the engine's `initialize` threw a less-clear error). This tightening is intentional and
   correct — the pre-check now matches the engine minimum and returns the right error early. A
   2-human Big2 rematch is unaffected (`2 ≥ 2`).
8. **Practice flag set but `aiPlayerIds` empty/absent (hand-crafted data).** `aiSeatCount = 0`,
   so `addAiSeats` is not called (`aiSeatCount >= 1` gate); the rematch is created with
   `rematchConfig` carrying no `practice`/`aiPlayerIds` → behaves as a human-only rematch. Safe
   degradation (matches LLD 118 Edge Case 10's "erring toward exclude" spirit, here erring
   toward a valid human game).
9. **Double-fire / idempotency.** Unchanged — the `oldGame.joinCode === null` guard
   (`REMATCH_ALREADY_STARTED`) still fires before any re-seat; the second call inserts no row.
10. **CPU is the first seat to act in the rematched game.** `startGame` returns state with a CPU
    at `currentPlayerIndex`; the socket handler already skips the initial human timer for an
    AI first seat and calls `autoPlayAbandoned` (`socketHandler.ts:437-466`, LLD 118 §C). The
    rematch path routes through the **same** `handleGameRematch` → (no; see note) — actually
    `handleGameRematch` calls `startGame` inside `createRematch` and then, on the socket side,
    arms the timer via `startTurn(newGameId, true)` unconditionally (`socketHandler.ts:511`) and
    does **not** call `autoPlayAbandoned`. **This is a gap that must be closed** — see Edge
    Case 11.
11. **CPU-first deal must be driven on the rematch path (socket layer).** `handleGameRematch`
    (`socketHandler.ts:475-522`) currently: `createRematch` → register timer →
    `startTurn(newGameId, true)` → emit `game:rematchStarted`. Unlike `handleGameStart`, it does
    **not** (a) skip the initial timer when the first seat is AI, nor (b) call
    `autoPlayAbandoned`. For a re-seated practice rematch whose first dealt seat is a CPU, the
    CPU would sit idle until a human acts (there may be no human to act) — a stall. **Required
    handling:** mirror `handleGameStart`'s AI-first block in `handleGameRematch`:
    - Compute `firstSeatId = state.players[state.currentPlayerIndex]?.playerId` from the
      `createRematch` return, `firstIsAi = firstSeatId != null && await
      gameService.isAiSeat(newGameId, firstSeatId)`.
    - Only call `startTurn(newGameId, true)` when `!firstIsAi` (still `registerGame`
      unconditionally when `turnTimerSeconds != null`).
    - After emitting `game:rematchStarted`, call
      `autoPlayAbandoned(io, newGameId, gameService, connectionManager, turnTimerService)` so a
      CPU-first (or all-CPU-until-human) opening is driven — exactly the post-start pattern.
    For a human-first or non-practice rematch this is a no-op (first seat not AI → timer armed
    as today, loop drives nothing). This keeps the two start paths consistent.
12. **Guest host of a practice game.** Practice games are a registered-host capability
    (LLD 120 §A), so a guest cannot have created one; `isPractice` is false for any guest-hosted
    game. No special handling — the guest rematch path is the human-only branch.

## Dependencies

Must exist before implementation (all present on `main`):

- **LLD 67** — `createRematch`, `game:rematch`/`game:rematchStarted`, `clearJoinCode`,
  `GameOverView` rematch props/wiring, `GameView` `onRematch`/`rematchError`. Direct upstream.
- **LLD 118** — `GameService.addAiSeats`, `isAiSeat`, `getAiSeatIds`, `GameConfig.practice`/
  `aiPlayerIds`, the relaxed `startGame` gate (`ENGINE_MIN_PLAYERS`), `shouldAutoPlay` /
  `autoPlayAbandoned` AI driving, the `handleGameStart` AI-first timer-skip pattern that
  `handleGameRematch` must mirror. Direct upstream.
- **LLD 120** — the `isAi` flag on `PlayerPublicInfo` (server-injected via `getAiSeatIds`) and
  the `AiBadge.vue` atom the lineup row reuses. Source of the frontend building blocks.
- No new migration; `game_config` JSONB used as-is.

## Test Requirements

Automated unless inherently visual. Follow testing-principles: self-contained (each test builds
its own game via the in-memory repo + cache; no shared `beforeEach` game state), seeded PRNG,
invariant checks. Tests mirror `tests/.../gameService` and the existing socket integration
harness.

### Unit — `GameService.createRematch` (in-memory repo + cache; no server/DB)

- **(a) REQUIRED regression — 1-human + N-CPU Big2 practice rematch succeeds.** Old game
  COMPLETED, `gameConfig = { practice: true, aiPlayerIds: [ai1, ai2] }`, `connectedPlayerIds =
  [host]`. Assert: does **not** throw; new `gameId !== oldGameId`; new game `IN_PROGRESS`; new
  `playerIds.length === 3` (host + 2 fresh AI); new `gameConfig.practice === true`; new
  `gameConfig.aiPlayerIds.length === 2` and those ids are **fresh** (not equal to the old
  `[ai1, ai2]`); the human host is `playerIds[0]`; every seat was dealt a hand.
- **(b) REQUIRED regression — 2-human + 1-CPU mixed practice rematch succeeds.** `connectedPlayerIds
  = [host, humanB]`, `aiPlayerIds = [ai1]`. Assert new roster = `[host, humanB, <1 fresh AI>]`,
  `practice === true`, `aiPlayerIds.length === 1` (fresh id), starts.
- **Re-seat count matches the old game.** Old game with `aiSeatCount = 3` → new
  `gameConfig.aiPlayerIds.length === 3`.
- **Practice preserved → stats excluded.** After (a) completes (drive to `COMPLETED` through
  `applyAction`), assert `recordGameCompletion` was invoked with `practice === true` (or, via a
  fake stats repo, assert **zero** `incrementStats` and **zero** `recordGameHistory` writes).
- **Roster-total guard — practice game below engine min.** 1-human + 1-CPU **Tonk** practice
  (`projectedTotal = 2 < 3`) → `NOT_ENOUGH_PLAYERS`; no row inserted; old code intact
  (re-clickable). 1-human + 2-CPU Tonk (`= 3`) → succeeds.
- **REQUIRED regression — human-only rematch unchanged.** 2-human Big2 COMPLETED, no AI →
  succeeds; new `gameConfig` has **no** `practice`/`aiPlayerIds`; `addAiSeats` **not** called;
  roster = the 2 humans. (Assert `deckRoundsTarget` preserved for a Tonk 3-human human-only
  rematch.)
- **REQUIRED regression — human-only Big2 solo still rejected.** 1 connected human, no AI →
  `NOT_ENOUGH_PLAYERS` (unchanged).
- **Tonk human-only tightening (Edge Case 7).** 2 connected humans, no AI, Tonk →
  `NOT_ENOUGH_PLAYERS` (now caught at the pre-check with the correct code, not deep in
  `initialize`).
- **`maxPlayers` headroom.** Old game `maxPlayers = 4`, roster 1 human + 3 AI → re-seat of 3
  succeeds without `GAME_FULL`.
- **Idempotency unchanged.** Second `createRematch` for the same finished practice game →
  `REMATCH_ALREADY_STARTED`; no second row; no re-seat.
- **Practice flag but empty `aiPlayerIds` (Edge Case 8).** `practice: true`, `aiPlayerIds: []`,
  1 connected human, Big2 → treated as human-only; solo → `NOT_ENOUGH_PLAYERS` (no `addAiSeats`
  call). 2 connected humans → succeeds as human-only.

### Integration — socket handler `handleGameRematch` (existing socket harness)

- **CPU-first deal is driven (Edge Case 11).** Rematch a 1-human + 1-CPU Big2 practice game
  whose new deal seats a CPU first. Assert: the initial human `startTurn(true)` is **not**
  called on the CPU seat, and after `game:rematchStarted` the auto-loop advances to the human's
  turn (or completion) with no client acting — i.e. `handleGameRematch` mirrors
  `handleGameStart`'s AI-first handling.
- **Human-first rematch unchanged.** Rematch where the first dealt seat is human → initial
  `startTurn(true)` still fires; loop drives nothing. (Regression.)
- **No socket ever registered for an AI id** after a driven rematch (reuse the LLD 118
  assertion): `getPlayerSockets(newGameId)` contains no `ai:` id.
- **Human-only rematch broadcast unchanged.** Non-host connected client still receives
  `game:rematchStarted { newGameId }` and the host acks `{ success: true, newGameId }`.

### Unit — frontend `GameOverView.vue` (component test, DOM assertions)

- **Enable state — CPU game.** `isHost`, `engineMin = 2`, `players = [1 human, 2 CPU]` (CPUs
  `isAi: true`) → Rematch button **enabled**; `rematch-too-few` hint **absent**.
- **Enable state — Big2 human-only regression.** `players = [2 humans]`, `engineMin = 2` →
  enabled (unchanged). `players = [1 human]` → disabled + `rematch-too-few` shown.
- **Enable state — Tonk.** `engineMin = 3`, `players = [1 human, 1 CPU]` (total 2 < 3) →
  disabled. `players = [1 human, 2 CPU]` → enabled.
- **Lineup row.** With `isHost` and `players = [1 human, 2 CPU]`, `data-testid="rematch-lineup"`
  renders and shows the CPU count (e.g. "You + 2 CPUs") with an `AiBadge`. With a human-only
  roster the lineup row is **absent**.
- **Non-host.** `isHost = false` → passive "Host can start a rematch"; no lineup row; no button.

### Manual (visual only)

- One-line check that the "Rematch lineup" row and its `AiBadge` render legibly on the
  game-over screen (desktop + mobile stacked layout). Everything else is covered by the DOM/unit
  and integration assertions above.

## Frontend Design

**Frontend decision: approved (Option A).** No new mockup loop — this reuses the existing
game-over layout (LLD 67) and the existing `AiBadge` atom (LLD 120, Variant B, `--ai-accent`
steel-blue). The only new element is one informational lineup row; it introduces no new visual
language.

- **Honest button state (the core fix).** The Rematch button's enabled/disabled state now
  matches what the backend accepts: it counts the connected humans that finished **plus** the
  CPUs that will be re-seated, gated on the engine minimum for the game type. A 1-human + N-CPU
  practice game shows an **enabled** Rematch button (previously enabled-but-always-failing).
  The server stays authoritative; the client change only removes the systematic false-positive.
- **Rematch lineup row (new, `data-testid="rematch-lineup"`).** Rendered for the host when
  `canRematch && aiCount >= 1`, directly under the actions row (or under the too-few hint slot,
  reusing `.game-over__rematch-hint` styling so no new CSS class is strictly required). Copy:
  "Rematch: You + {{ aiCount }} CPU{{ aiCount === 1 ? '' : 's' }}" with a single inline
  `<AiBadge />` next to the count so the returning CPUs are visually unmistakable and match the
  steel-blue identity used in the lobby/board. Static, non-interactive, `flex-shrink: 0` on the
  badge so it is never clipped on mobile (matches LLD 120's badge handling).
- **Too-few-players hint.** Still shown when `isHost && !canRematch`. For Big2 the existing copy
  "Only you are still here. Need at least 2 players." is correct. For Tonk (min 3) the literal
  "2 players" is slightly off; **recommended** (low-effort) to make the number reflect
  `engineMin` — e.g. "Need at least {{ engineMin }} players." — so the hint is accurate for both
  engines. Implementer may keep the Big2 copy if a shared string is awkward; the number is the
  only load-bearing part.
- **Mobile.** Reuses the existing `.game-over__actions` stacked column and 48px min-height
  buttons (`GameOverView.vue:558-575`). The lineup row is a single short line; it stacks
  naturally. No new breakpoints.
- **Reduced motion.** The lineup row and badge are static — no animation, no
  `prefers-reduced-motion` handling needed.

Component contract additions (`GameOverView.vue`): new prop `engineMin: number`; derived
`humanCount`, `aiCount`, and the updated `canRematch`. No new emits. The `isAi` flag is read
from the existing `players: readonly PlayerPublicInfo[]` prop — no new prop for AI membership.
