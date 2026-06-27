# LLD 48: Game room ID not visible during gameplay

## Scope

**Covers:**

- Making the 4-character room (join) code visible on the `GameBoard` during `IN_PROGRESS` (and `SHOW_FINAL_PLAY`) state.
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

`Game.joinCode` already exists on the entity (added by LLD 28) and is already read in `handleGameJoin` for `lobby:state`. The change is to surface it in two more places:

- **`broadcastGameState` and the join-time `game:state` emit** in `socketHandler.ts`: include `joinCode: game.joinCode ?? null` alongside the existing `turnDeadline` spread. The `Game` row is already loaded in both code paths.
- **`serializeGameForPlayer`** in `serializer.ts`: add `joinCode: game.joinCode` to the returned `SerializableGame`.

This is display/share metadata only. It does not pass through the engine, `getPlayerView`, or `InternalGameState`. It is enrichment applied at the transport layer, exactly like `turnDeadline` is today — consistent with architecture principle 9 (thin transport enriches the view) and principle 4 (engine stays pure).

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
  Game.joinCode (persisted, set at creation — LLD 28)
    → socketHandler: game:state emit spreads { ...view, turnDeadline, joinCode: game.joinCode ?? null }
    → serializer: serializeGameForPlayer adds joinCode: game.joinCode
  InternalGameState / getPlayerView: UNCHANGED (code never enters engine)

Client — GameView.vue owns one ref `roomCode = ref("")`:
  1. onMounted REST getGameState → roomCode.value = game.joinCode ?? ""   (seed; removes flicker)
  2. lobby:state handler (CREATED only) → roomCode.value = payload.joinCode (existing lobbyJoinCode kept)
  3. game:state arrives (via useGameState) → roomCode reconciled from gameState.joinCode
  GameView passes :room-code="roomCode" to GameBoard.

GameBoard.vue:
  prefers props.gameState.joinCode (authoritative, always fresh) else props.roomCode (seed/fallback)
    → <RoomCodeChip :code="displayCode" />
```

**Reconciliation rule (in `GameView`):** prefer the live socket value when present. Concretely, derive the code passed down as `gameState.value?.joinCode ?? roomCode.value`. This means: REST seed shows immediately; once `game:state` lands its `joinCode` wins; on reconnect `game:state` always carries it.

**Persistence:** `joinCode` is already persisted on the `games` row (LLD 28). No new persistence, no new DB column, no migration. All new client state is in-memory UI state that resets on reload.

## Frontend Design

**Chosen direction: Option C** — a stacked "ROOM CODE" label over the code, anchored to the **far-left of the opponents bar** (`game-board__opponents`), mirroring the lobby chip styling at miniature scale. Approved from the mockup on branch `lld-47` (`docs/mockups/in-game-room-code-display.html`, Option C).

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
5. **`SHOW_FINAL_PLAY` overlay:** `GameBoard` still renders underneath the overlay; the chip remains in the opponents bar. The final-play overlay (`z-index: 100`) covers the board including the chip — acceptable, it is a brief transient state.
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
  - `src/backend/websocket/socketHandler.ts` — include `joinCode` in the two `game:state` emits (join-time + `broadcastGameState`).
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

- On joining/`broadcastGameState` for an `IN_PROGRESS` game, the emitted `game:state` payload includes the game's `joinCode` (assert on the payload, alongside existing `turnDeadline`).
- A game with `joinCode === null` emits `joinCode: null` (no throw, no `undefined` shape drift).
- **Information-hiding regression:** the existing `getPlayerView` leakage assertions still hold — adding `joinCode` at the transport layer does not introduce any opponent-hand data into the per-player payload.

### Manual / Visual (exception per testing-principles §5 — layout/responsiveness)

- Desktop: room-code chip visible far-left of the opponents bar, does not overlap opponent pills, timer, play area, or hand. Click copies; toast shows.
- Mobile (375px): chip visible far-left, collapses label to "ROOM", does **not** overlap the `.log-toggle` stack icon (top-right) or the open log drawer.
- Refresh an `IN_PROGRESS` game in the browser → chip still shows the correct code (the core bug).
