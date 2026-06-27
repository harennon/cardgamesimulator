# LLD 48: Game room ID not visible during gameplay

## Scope

**Covers:**

- Making the 4-character room (join) code visible on the `GameBoard` during `IN_PROGRESS` state. The chip is also **mounted** during the `SHOW_FINAL_PLAY` transient (it lives in the opponents bar, which is always present on the board), but it is **intentionally allowed to be covered** by the final-play overlay for that brief state — see Edge Case 5. "Visible during gameplay" means the steady-state `IN_PROGRESS` board; the SHOW_FINAL_PLAY overlay covering it for ~a second is expected, not a regression.
- Tapping/clicking the code copies it to the clipboard, reusing the existing copy pattern from `GameLobbyView.vue`.
- Surviving a mid-game reconnect/refresh: the code must be available even when the client never saw a `lobby:state` event (i.e. it loaded directly into an in-progress game).
- Threading `joinCode` into the in-game state payload as a **read-only, additive, display-only** field:
  - the `game:state` WebSocket payload (`EnrichedPlayerView`),
  - the REST `SerializableGame` returned by `GET /api/getGameState`.
- Passing `gameId` and `joinCode` from `GameView.vue` into `GameBoard.vue` as props.
- Desktop and mobile layouts.

**Does NOT cover:**

- Any change to game-engine state, rules, or the `InternalGameState` shape. `joinCode` is never part of engine state.
- Spectator-side display of the room code (the `EnrichedSpectatorView` / `game:spectatorState` payload). Out of scope; spectators already chose this game and the feedback is from players. Can be a follow-up.
- The lobby room-code chip (already shipped in LLD 28 — reused as a styling reference only).
- Code generation, resolution, or join-by-code flows (LLD 28).
- Showing the room code on the game-over screen (`GameOverView` already receives `gameId`; not in this issue).

## Approach

### Why the scope is larger than "pass a prop"

The naive hypothesis (pass `lobbyJoinCode` from `GameView` to `GameBoard`) breaks on refresh. `lobbyJoinCode` in `GameView.vue` is only populated by the `lobby:state` socket event, which the server emits **only for `CREATED` games** (`socketHandler.handleGameJoin`). When a client loads directly into an `IN_PROGRESS` game (refresh, late tab open, reconnect), it receives `game:state` instead of `lobby:state`, so `lobbyJoinCode` stays `""`. The REST `getGameState` call made on mount also carries no code (`SerializableGame` has no `joinCode`). Therefore the code must be added to the in-game payloads.

### Decision: where to source the code on the client

The code reaches the in-game view through **two independent additive paths**, both already touched on mount:

1. **`game:state` (`EnrichedPlayerView.joinCode`)** — the authoritative in-game source. Available on first join, on reconnect, and on every broadcast. This is what `GameBoard` ultimately renders.
2. **REST `SerializableGame.joinCode`** — used as the initial value for `GameView`'s code ref so the code can render in the brief window before the first `game:state` arrives, and as a fallback if the socket payload is ever empty.

`GameView` holds a single `roomCode` ref, seeded from the REST response on mount, kept in sync from `lobby:state` (CREATED), and overwritten by `game:state.joinCode` once present. It passes `roomCode` (and `gameId`) to `GameBoard`.

**Rejected alternative:** adding the code only to `game:state` and not REST. Rejected because there is a visible gap between mount and first `game:state` where the chip would be empty; seeding from REST removes the flicker for one additive field at negligible cost.

### Server side (additive, read-only)

`Game.joinCode` already exists on the entity (added by LLD 28) and is already read in `handleGameJoin` for `lobby:state`. The change is to surface it in three places, but the **two `game:state` emit sites source `joinCode` differently** because they have different data in scope. This is the correction from design review — see below.

**1. Join-time `game:state` emit (`handleGameJoin`, ~line 216).** This path already loads the full `Game` row (`const game = await gameService.getGame(gameId)`, line 150) before emitting. So here, and only here, `game.joinCode` is in scope. Add `joinCode: game.joinCode ?? null` to the existing `{ ...injectConnectionStatus(view), turnDeadline }` emit object.

**2. `broadcastGameState` (~lines 37–65).** This function does **not** have a `Game` row in scope. It only calls `gameService.getGameState(gameId)`, which returns `InternalGameState` — the engine state, which by design excludes `joinCode` (the code never enters the engine, see Scope). Therefore `game.joinCode` does not exist here and writing it would not compile.

`broadcastGameState` must obtain the code by **separately loading the `Game` row**: add `const game = await gameService.getGame(gameId);` near the top of the function (after the existing `getGameState` null-guard) and emit `joinCode: game?.joinCode ?? null`. `gameService.getGame` already exists (`gameService.ts` line 44; delegates to `gameRepo.getGame`). One additional DB read per broadcast; acceptable because broadcasts are per-state-change, not per-frame, and the row is small. (See "Rejected alternative" below for why we do not thread the code through `InternalGameState` to avoid the read.)

Inside `broadcastGameState`, add `joinCode: game?.joinCode ?? null` **only to the per-player `game:state` emit** (the `for (const … of playerSockets)` loop emit, ~lines 52–58). Do **not** add it to the `game:spectatorState` emit (~lines 60–64): per Scope, the spectator payload (`EnrichedSpectatorView`) does not carry `joinCode`.

This correction matters because `broadcastGameState` is the path used on **every** state-change broadcast (`game:action`, `game:start`, timer expiry, disconnect/reconnect) and on the **reconnect re-broadcast** (`handleGameJoin` ~line 230). If `broadcastGameState` did not carry `joinCode`, the "always carries it on reconnect / every broadcast" guarantee (Reconciliation rule) would not hold, and the chip would go blank on the first post-mount broadcast.

**3. `serializeGameForPlayer` (`serializer.ts`).** This function already receives the full `Game` row as its first argument, so `game.joinCode` is in scope. Add `joinCode: game.joinCode` to the returned `SerializableGame`.

This is display/share metadata only. It does not pass through the engine, `getPlayerView`, or `InternalGameState`. It is enrichment applied at the transport layer, exactly like `turnDeadline` is today — consistent with architecture principle 9 (thin transport enriches the view) and principle 4 (engine stays pure).

**Rejected alternative (avoiding the extra read):** add `joinCode` to `InternalGameState` so `broadcastGameState` could read it from the cached state with no extra DB call. Rejected because it violates Scope ("`joinCode` is never part of engine state") and architecture principle 4 (pure engine, no display/share metadata in engine state). The one extra small read per broadcast is the cheaper tradeoff than polluting engine state.

**Type divergence (deliberate — do not "normalize"):** the new `EnrichedPlayerView.joinCode` and `SerializableGame.joinCode` are typed `string | null` (a game may genuinely have no code; the engine/transport carries `null`). The pre-existing `LobbyStatePayload.joinCode` is typed `string` and defaults to `""` (`game.joinCode ?? ""`, line 181). These are intentionally different and both correct: the lobby path coerces to empty string, the in-game paths preserve `null`. The frontend reconciliation (`gameState.value?.joinCode ?? roomCode.value`) and `RoomCodeChip`'s `code: string` prop handle both null and empty-string as "no chip". **The implementer must not change `LobbyStatePayload.joinCode` to `string | null` nor coerce the in-game payloads to `""`** — leave each path as specified.

**Information-hiding note:** the join code is not hidden information — every player in the room already has it (it was shown in the lobby and is shareable by design). Adding it to the per-player view does not leak any opponent's private data.

### Frontend

A small reused chip component (`RoomCodeChip.vue`) renders the "ROOM CODE" label + code and owns the copy-to-clipboard behavior (lifted verbatim from `GameLobbyView.vue`'s `copyJoinCode`, including the `clipboardFallback` path). `GameBoard` renders it inside the opponents bar (`game-board__opponents` / `OpponentRow`). See **Frontend Design**.

## Interfaces / Types

### Shared: `src/shared/socket-events.ts`

```typescript
/** PlayerView enriched with timer deadline + room code for WebSocket emission. */
export interface EnrichedPlayerView extends PlayerView {
  readonly turnDeadline: number | null; // epoch ms, or null if no timer
  readonly joinCode: string | null; // 4-char room code; null if game has none
}
```

`EnrichedSpectatorView` is intentionally **not** changed (spectator display out of scope).

> **Type note:** `joinCode` here is `string | null` (and likewise on `SerializableGame` below). This deliberately differs from the existing `LobbyStatePayload.joinCode: string` (which defaults to `""`). Do **not** unify these — see Approach "Type divergence".

### Shared: `src/shared/model.ts`

```typescript
export interface SerializableGame {
  gameId: string;
  gameType: GameType;
  maxPlayers: number;
  playerIds: string[];
  playerDisplayNames: Record<string, string>;
  status: GameStatus;
  state: SerializableGameState;
  turnTimerSeconds: number | null;
  joinCode: string | null; // 4-char room code; null if game has none
}
```

### Frontend: new component `src/frontend/component/game-ui/RoomCodeChip.vue`

```typescript
const props = defineProps<{
  code: string; // already-resolved room code; component renders nothing if empty
}>();
// No emits. Owns its own copy + toast state internally.
```

Renders nothing (`v-if="code"`) when `code` is empty/null so it never shows a blank chip.

### Frontend: `GameBoard.vue` props (additive)

```typescript
const props = defineProps<{
  gameState: EnrichedPlayerView;
  selectedIndices: Set<number>;
  selectionCount: number;
  actionError: string | null;
  actionPending: boolean;
  turnTimerSeconds: number | null;
  roomCode: string; // NEW — resolved 4-char code ("" if unknown)
}>();
```

`gameId` is **not** added as a new prop because the code (not the UUID) is what users share; `gameState.gameId` is already available if ever needed. Passing the human-facing `roomCode` satisfies the acceptance criteria.

## State Model

```
Server (no engine change):
  Game.joinCode (persisted, set at creation — LLD 28) — the ONLY source of truth
    → socketHandler join-time game:state (handleGameJoin): Game row already loaded (line 150),
        emit { ...view, turnDeadline, joinCode: game.joinCode ?? null }
    → socketHandler broadcastGameState: NO Game row in scope (only getGameState → InternalGameState,
        which has no joinCode). Must separately call gameService.getGame(gameId) and
        emit { ...view, turnDeadline, joinCode: game?.joinCode ?? null } on the per-player loop only.
        (One extra small DB read per broadcast — accepted; see Approach "Rejected alternative".)
    → serializer: serializeGameForPlayer (receives Game row arg) adds joinCode: game.joinCode
  InternalGameState / getPlayerView: UNCHANGED (code never enters engine — hence broadcastGameState
        cannot read it from getGameState and must load the Game row)

Client — GameView.vue owns one ref `roomCode = ref("")`:
  1. onMounted REST getGameState → roomCode.value = game.joinCode ?? ""   (seed; removes flicker)
  2. lobby:state handler (CREATED only) → roomCode.value = payload.joinCode (existing lobbyJoinCode kept)
  3. game:state arrives (via useGameState) → roomCode reconciled from gameState.joinCode
  GameView passes :room-code="roomCode" to GameBoard.

GameBoard.vue:
  prefers props.gameState.joinCode (authoritative, always fresh) else props.roomCode (seed/fallback)
    → <RoomCodeChip :code="displayCode" />
```

**Reconciliation rule (in `GameView`):** prefer the live socket value when present. Concretely, derive the code passed down as `gameState.value?.joinCode ?? roomCode.value`. This means: REST seed shows immediately; once `game:state` lands its `joinCode` wins; on reconnect `game:state` always carries it. **This guarantee holds only because `broadcastGameState` was corrected to load the `Game` row and include `joinCode`** (see Approach) — the reconnect re-broadcast and every subsequent state-change broadcast all flow through `broadcastGameState`, so if that path omitted `joinCode` the chip would blank out on the first broadcast after mount.

**Persistence:** `joinCode` is already persisted on the `games` row (LLD 28). No new persistence, no new DB column, no migration. All new client state is in-memory UI state that resets on reload.

## Frontend Design

**Chosen direction: Option C** — a stacked "ROOM CODE" label over the code, anchored to the **far-left of the opponents bar** (`game-board__opponents`), mirroring the lobby chip styling at miniature scale. Approved from the mockup `docs/mockups/in-game-room-code-display.html` (Option C). The mockup file is present on this branch (restored from the `lld-47-in-game-room-code-display` branch where it was originally authored) so the implementer can view it directly; serve `docs/mockups/` on port 8090 to review.

**Why C over A/B (the load-bearing reason):** On mobile, the game-log toggle (`.log-toggle`, the "stack" / hamburger icon that opens the played-history drawer) is fixed at `top: 60px; right: 8px` (`GameBoard.vue` unscoped styles, LLD 11). Options A and the mockup's right-aligned placements put the room code at the **top-right**, which collides with that stack icon. The mockup frames do not render the stack icon, so the overlap is not visible in them — but it is real in the running app. Anchoring the chip to the **far-left** of the opponents bar keeps it clear of the right-side toggle and of the active-turn timer (which renders on the active opponent, right side). This is the deciding factor for Option C.

### Layout & placement

- The chip lives at the far-left of the opponents bar, positioned absolutely within `game-board__opponents` (or rendered as the first child of `OpponentRow` with `position: absolute; left`). It must not consume horizontal flow space that pushes opponents — it sits in the dead space to the left of the opponent pills.
- Vertically centered in the 80px (desktop) / `--mobile-opponent-height` (52px mobile) opponents row.
- `z-index` below the wood-rim (`< 100`) and below the mobile `.log-toggle` (200) and `.log-drawer` (300) — it must never sit above gameplay chrome.

### Visual spec (reuse lobby tokens; miniature scale)

- **Label:** "ROOM CODE" (desktop) / "ROOM" (mobile), `0.5rem` desktop / `0.4rem` mobile, uppercase, `letter-spacing: 0.14em`, `color: var(--text-muted)`. Optional small copy-glyph SVG to the right of the label (per mockup), `opacity 0.5` → `1` on hover.
- **Code:** monospace (`var(--font-mono)` / `"Courier New"`), `1rem` desktop / `0.74rem` mobile, `font-weight: 700`, `letter-spacing: 0.22em` desktop / `0.12em` mobile, `color: var(--gold-accent)`.
- **Container:** `inline-flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 4px 6px; border-radius: 6px;` Hover: `background: rgba(201,168,76,0.1)`. Cursor pointer. No heavy border (distinguishes it from the dominant lobby chip; it must stay subtle and not obstruct cards).
- **Copy feedback:** on tap/click, copy the code; show a "Copied!" toast positioned just below the chip (`top: calc(100% + 4px); left: 0`) for ~2s, mirroring `GameLobbyView`'s `codeCopied`. On clipboard failure show "Long-press to copy." (`clipboardFallback`), same fallback as the lobby.

### Accessibility & non-obstruction

- The chip is a `<button>` (or `role="button"` with keyboard handler) with `aria-label="Room code {{code}}. Tap to copy."` matching the lobby pattern.
- `data-testid="ingame-room-code-chip"` for tests.
- It occupies dead space in the top bar and is sized to not overlap opponent pills, card backs, the active-turn timer, the play area, or the hand. On the narrowest supported width (375px) it fits left of the first opponent pill; if space is tight, the label collapses to "ROOM" (mobile rule) to stay compact.

### Reuse

`RoomCodeChip.vue` lifts the `copyJoinCode` clipboard logic (success toast + `clipboardFallback` "Long-press to copy.") verbatim from `GameLobbyView.vue` rather than inventing a new copy mechanism. Styling consumes existing `game-variables.css` tokens (`--gold-accent`, `--text-muted`, font vars). No refactor of `GameLobbyView` or `OpponentRow` beyond inserting the chip.

## Edge Cases

1. **Refresh/reconnect mid-game:** client gets `game:state` (not `lobby:state`); `joinCode` is now on that payload, so the chip renders. Primary bug being fixed.
2. **Game has no join code (`joinCode` null):** legacy games created before LLD 28, or any null case. `RoomCodeChip` renders nothing (`v-if="code"`). No empty/blank chip, no "null" text.
3. **First `game:state` not yet arrived:** REST-seeded `roomCode` renders the chip immediately; reconciliation prefers `gameState.joinCode` once it lands. No flicker, no layout shift (chip is absolutely positioned in dead space).
4. **Clipboard API unavailable (older mobile browsers, insecure context):** `navigator.clipboard.writeText` throws → show "Long-press to copy." fallback toast, identical to the lobby behavior.
5. **`SHOW_FINAL_PLAY` overlay:** `GameBoard` still renders underneath the overlay; the chip remains mounted in the opponents bar. The final-play overlay (`z-index: 100`) sits **above** the chip and **intentionally covers it** for the duration of this brief transient state. This is the **specified, intended behavior** (not a bug): the chip is not raised above the overlay, and it reappears the instant the overlay dismisses. QA should treat the chip being hidden under the final-play overlay as correct, and verify it is visible again immediately after the overlay clears. This is consistent with the Scope clarification that "visible during gameplay" refers to the steady-state `IN_PROGRESS` board.
6. **Mobile stack/log toggle overlap:** avoided by far-left placement (see Frontend Design). Verify the chip does not collide with `.log-toggle` (`top:60px; right:8px`) or `.log-drawer` when open.
7. **Long opponent names / 4 opponents on mobile:** opponents row already truncates names (`max-width: 60px`, LLD 11). The chip is absolutely positioned and does not participate in the pill flex flow, so it does not shrink pills; ensure opponent pills have enough left offset (small `padding-left` / `margin-left` on the row) so the first pill does not sit under the chip on the narrowest screens.
8. **Spectator view:** spectators do not get `joinCode` (out of scope). `game:spectatorState` is unchanged; the chip only renders in the player `GameBoard`. No regression for spectators (they simply do not see the chip).
9. **Code value integrity:** the code is server-supplied and read-only; the client never writes it back. No action, no `game:action`, no engine path is touched.

## Dependencies

- **LLD 28 (Mobile Invite Code)** — provides `Game.joinCode`, the `join_code` column, and the lobby copy pattern being reused. Already implemented.
- **LLD 11 (Mobile Layout)** — defines the opponents-bar mobile sizing, the `.log-toggle` / `.log-drawer` positions that drive the Option C placement decision, and the CSS-variable approach. Already implemented.
- **Existing files modified:**
  - `src/shared/socket-events.ts` — add `joinCode` to `EnrichedPlayerView`.
  - `src/shared/model.ts` — add `joinCode` to `SerializableGame`.
  - `src/backend/websocket/socketHandler.ts` — include `joinCode` in the two per-player `game:state` emits, sourced differently per the Approach: join-time emit uses the already-loaded `game.joinCode`; `broadcastGameState` adds a `gameService.getGame(gameId)` call and uses `game?.joinCode ?? null` (its `getGameState` result has no `joinCode`). Spectator emit unchanged.
  - `src/backend/util/serializer.ts` — include `joinCode` in `serializeGameForPlayer`.
  - `src/frontend/component/game/GameView.vue` — own a `roomCode` ref, seed from REST, pass to `GameBoard`.
  - `src/frontend/component/game/GameBoard.vue` — accept `roomCode` prop, render `RoomCodeChip` in the opponents area.
- **New file:** `src/frontend/component/game-ui/RoomCodeChip.vue`.
- No new backend dependency, no DB migration, no engine change.

## Test Requirements

### Unit / Component (frontend)

- **`RoomCodeChip`** renders the code and "ROOM CODE" label when `code` is non-empty.
- **`RoomCodeChip`** renders nothing when `code` is `""`/null (edge case 2).
- **`RoomCodeChip`** click copies `code` to clipboard (mock `navigator.clipboard.writeText`) and shows the "Copied!" toast.
- **`RoomCodeChip`** shows the "Long-press to copy." fallback when `writeText` rejects (edge case 4).
- **`GameBoard`** renders `RoomCodeChip` with the code from `gameState.joinCode` when present.
- **`GameBoard`** falls back to the `roomCode` prop when `gameState.joinCode` is null/absent.
- **`GameBoard`** does not render the chip when both sources are empty.
- **`GameView`** seeds `roomCode` from the REST `getGameState` response on mount and passes it to `GameBoard`.
- **`GameView`** reconciliation prefers `gameState.joinCode` over the seeded `roomCode` once `game:state` is received.

### Unit (backend)

- **`serializeGameForPlayer`** includes `joinCode` from the `Game` row (and `null` when the row's `joinCode` is null).

### Integration (backend)

- On **join-time** `game:state` (the `handleGameJoin` IN_PROGRESS/COMPLETED branch), the emitted payload includes the game's `joinCode` (assert alongside existing `turnDeadline`).
- On **`broadcastGameState`** (triggered via e.g. `game:action` or the reconnect re-broadcast), the per-player `game:state` payload includes `joinCode` — this is the regression-critical path the design review flagged, since `broadcastGameState` does not have the `Game` row from `getGameState` and must load it separately. Assert a post-action broadcast carries the same `joinCode` as the join-time emit.
- The `game:spectatorState` payload from `broadcastGameState` does **not** include `joinCode` (spectator out of scope; confirm no accidental leak into the spectator shape).
- A game with `joinCode === null` emits `joinCode: null` on both emit paths (no throw, no `undefined` shape drift).
- **Information-hiding regression:** the existing `getPlayerView` leakage assertions still hold — adding `joinCode` at the transport layer does not introduce any opponent-hand data into the per-player payload.

### Manual / Visual (exception per testing-principles §5 — layout/responsiveness)

- Desktop: room-code chip visible far-left of the opponents bar, does not overlap opponent pills, timer, play area, or hand. Click copies; toast shows.
- Mobile (375px): chip visible far-left, collapses label to "ROOM", does **not** overlap the `.log-toggle` stack icon (top-right) or the open log drawer.
- Refresh an `IN_PROGRESS` game in the browser → chip still shows the correct code (the core bug).
