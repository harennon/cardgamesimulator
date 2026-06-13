# LLD 6: Frontend Game UI

Build the full playable Big2 frontend. After this LLD, players can join a game lobby, start a game, see their cards, select and play combinations, pass, and see game over results — all driven by Socket.IO events from the server. The visual direction follows "The Club" felt-table aesthetic from `design-mockups/direction-a-revised.html`.

---

## 1. Scope

### In scope

- Game state composable (`useGameState.ts` — reactive state from `game:state` events)
- Game actions composable (`useGameActions.ts` — emit actions via WebSocket)
- Card selection composable (`useCardSelection.ts` — multi-select, valid combo detection for UX feedback)
- Card component (`GameCard.vue` — CSS-only card rendering, face/back, selected state)
- Hand component (`PlayerHand.vue` — fan layout, click to select)
- Opponent component (`OpponentRow.vue` — card-back fan, card count, active turn indicator)
- Game board layout (`GameBoard.vue` — opponents top, center play area, player hand bottom, game log sidebar)
- Center play area (`PlayArea.vue` — last play display, turn indicator)
- Action panel (`ActionPanel.vue` — Play/Pass buttons, enabled/disabled based on `validActions`)
- Game log (`GameLog.vue` — scrollable history entries)
- Game lobby rewrite (`GameLobbyView.vue` — WebSocket-based player list, start button wired to `game:start`)
- Game over screen (`GameOverView.vue` — scores table, rematch, guest sign-up nudge)
- Route flow: `GameView.vue` renders lobby/board/game-over based on `status` field from game state
- CSS variable system matching the design mockup palette and typography

### Out of scope

- Mobile layout (Phase 5 polish)
- Card deal/play animations beyond CSS transitions (Phase 5 polish)
- Turn timer display and countdown (LLD 7)
- Spectator view (LLD 8)
- Rematch backend logic (the UI will emit a rematch event, but the server handler is out of scope — show as a disabled placeholder)
- Sound effects (Phase 5 polish)
- Toast notifications for connect/disconnect (Phase 5 polish)

---

## 2. Approach

### Key decisions

1. **Composables as the reactive layer, components as pure renderers.**

   Three composables own the reactive state: `useGameState` holds the `PlayerView`, `useGameActions` provides action methods, and `useCardSelection` manages multi-select logic. Components receive data via props and emit user interactions up. This keeps game logic testable outside the DOM.

   *Rationale:* Aligns with Architecture Principle 1 (Server-Authoritative State) — the frontend never computes game logic. Composables map server events to reactive refs; components render them.

2. **Single socket connection per game session.**

   `useSocket` (already exists) provides the Socket.IO connection. The `GameView` component calls `connect()` once on mount, then calls `bind(socket)` on both `useGameState` and `useGameActions` after `game:join` succeeds. The socket lifetime is tied to the `GameView` component — disconnects on unmount.

   *Rationale:* A game session is a single page. No need for a global persistent socket. The existing `useSocket` composable already handles reconnection with exponential backoff.

3. **No client-side validation of card combinations.**

   The "Play" button is enabled whenever (a) it is the player's turn, (b) at least one card is selected, and (c) `validActions` includes `"playCards"`. The client does NOT check whether the selected cards form a valid combo that beats the current play. If the server rejects the action, the client shows a brief error and keeps the selection.

   *Rationale:* Architecture Principle 1 says "Never compute game rules in frontend code." The `validActions` array tells us the action TYPE is available, not which specific combinations are legal. Adding client-side combo validation would duplicate engine logic (hand detection, comparison) in the frontend, creating a maintenance burden and potential desync. The only UX cost is a rejected play on invalid combos — acceptable for v1. The error response from the server ack is shown inline.

   *Alternative considered:* Sending all valid combos from server in `validActions`. Rejected because for 13 cards the number of valid 5-card combos can be large, and it would require a different `ValidAction` shape. This optimization can be revisited in Phase 5 if UX testing shows it is needed.

4. **CSS-only cards using the mockup's design system.**

   Cards are rendered with HTML/CSS (rank text + suit unicode symbol), not images or SVGs. Suit colors (`--red-suit`, `--black-suit`) and typography (`Libre Baskerville` for ranks, `DM Sans` for UI) come from CSS custom properties. This matches the mockup exactly and keeps the bundle size minimal.

5. **GameView as the orchestrator with status-based rendering.**

   `GameView.vue` is the single route component for `/game/:gameId`. It connects the socket, joins the room, and conditionally renders `GameLobbyView`, `GameBoard`, or `GameOverView` based on the `status` field from the game state (`"CREATED"`, `"IN_PROGRESS"`, `"COMPLETED"`). Transitions between states happen reactively when the server broadcasts a new status.

6. **Game lobby uses WebSocket events for real-time player list.**

   The current lobby fetches player list via REST on mount. This LLD replaces that with WebSocket-based updates: `lobby:playerJoined` and `lobby:playerLeft` events update a reactive player list. The initial player list comes from the REST `getGameState` call on mount (needed for the case where some players joined before this client connected).

7. **Game log displays `playHistory` from `Big2PublicState`.**

   The `gameSpecificPublicState.playHistory` array from `PlayerView` is the source for the game log. Each entry contains `displayName`, `action` ("play"/"pass"), optional `cards`, and optional `handType`. The log auto-scrolls to the latest entry.

8. **Type narrowing for `gameSpecificPublicState`.**

   `PlayerView.gameSpecificPublicState` is typed as `unknown` in `engine-types.ts` (game-engine-agnostic). Components that need Big2-specific data use a narrowing computed:

   ```typescript
   // In GameBoard.vue setup or a shared utility
   import type { Big2PublicState } from "@shared/big2-types";

   const big2State = computed<Big2PublicState | null>(() => {
     if (gameState.value?.gameType === "big2" && gameState.value.gameSpecificPublicState) {
       return gameState.value.gameSpecificPublicState as Big2PublicState;
     }
     return null;
   });
   ```

   This keeps the assertion in one place per component rather than scattered across template expressions. The guard on `gameType` makes it safe if additional game types are added later.

---

## 3. Interfaces / Types

### Composable: `useGameState`

```typescript
// src/frontend/composables/useGameState.ts
import type { ShallowRef, Ref, DeepReadonly } from "vue";
import type { PlayerView, GameStatus } from "@shared/engine-types";
import type { TypedClientSocket } from "./useSocket";

interface UseGameStateReturn {
  /** Current player view from the server. Null until first game:state received.
   *  Implemented as a shallowRef — entire object is replaced on each game:state event,
   *  so deep reactivity is unnecessary and wasteful. */
  gameState: DeepReadonly<ShallowRef<PlayerView | null>>;
  /** Convenience: extracted status for template v-if branching. */
  status: Ref<GameStatus | null>;
  /** True once the first game:state event has been received. */
  initialized: Ref<boolean>;
  /** Bind listeners. Call once after socket connects and game:join succeeds. */
  bind(socket: TypedClientSocket): void;
  /** Unbind listeners. Call on component unmount. */
  unbind(): void;
}

export function useGameState(): UseGameStateReturn;
```

**Note:** `src/frontend/composables/useSocket.ts` currently defines `TypedClientSocket` as a file-local type alias. The implementer must add an explicit `export` to that type so that `useGameState` and `useGameActions` can import it:

```typescript
// In useSocket.ts — change from:
type TypedClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
// To:
export type TypedClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
```

### Composable: `useGameActions`

```typescript
// src/frontend/composables/useGameActions.ts
import type { Ref } from "vue";
import type { Card } from "@shared/engine-types";
import type { TypedClientSocket } from "./useSocket";

interface UseGameActionsReturn {
  /** Emit game:start to the server. Resolves with success/error. */
  startGame(gameId: string): Promise<{ success: boolean; error?: string }>;
  /** Emit game:action with type "playCards". */
  playCards(gameId: string, cards: readonly Card[]): Promise<{ success: boolean; error?: string }>;
  /** Emit game:action with type "pass". */
  pass(gameId: string): Promise<{ success: boolean; error?: string }>;
  /** Last error message from a failed action (clears on next attempt). */
  actionError: Ref<string | null>;
  /** True while an action is in flight. */
  actionPending: Ref<boolean>;
  /** Bind to a socket instance. Call once after socket connects and game:join succeeds.
   *  Same pattern as useGameState.bind(). */
  bind(socket: TypedClientSocket): void;
  /** Unbind from socket. Call on component unmount. */
  unbind(): void;
}

export function useGameActions(): UseGameActionsReturn;
```

**Note:** Both `useGameState` and `useGameActions` use the same access pattern: instantiate the composable (no arguments), then call `bind(socket)` after the socket connects and `game:join` succeeds. This keeps both composables consistent and avoids the need to pass a `Ref<TypedClientSocket | null>` at construction time. Internally, `useGameActions` stores the bound socket reference and uses it when emitting events; methods throw if called before `bind()`.

### Composable: `useCardSelection`

```typescript
// src/frontend/composables/useCardSelection.ts
import type { Ref, ComputedRef } from "vue";
import type { Card } from "@shared/engine-types";

interface UseCardSelectionReturn {
  /** Currently selected cards (by index in hand). */
  selectedIndices: Ref<Set<number>>;
  /** The actual Card objects for the selected indices. */
  selectedCards: ComputedRef<readonly Card[]>;
  /** Toggle a card's selection by its index in the hand array. */
  toggleCard(index: number): void;
  /** Clear all selections. Call after a successful play or on new turn. */
  clearSelection(): void;
  /** Number of cards currently selected. */
  selectionCount: ComputedRef<number>;
}

export function useCardSelection(hand: Ref<readonly Card[]>): UseCardSelectionReturn;
```

### Component Props

```typescript
// GameCard.vue props
interface GameCardProps {
  card: Card;
  selected?: boolean;
  faceDown?: boolean;
  size?: "small" | "medium" | "large"; // small=opponent backs, medium=center play, large=player hand
}

// PlayerHand.vue props
interface PlayerHandProps {
  cards: readonly Card[];
  selectedIndices: Set<number>;
  interactive: boolean; // false when not your turn
}
// emits: { "toggle-card": [index: number] }

// OpponentRow.vue props
interface OpponentRowProps {
  players: readonly PlayerPublicInfo[];
  currentPlayerIndex: number;
  myPlayerIndex: number; // to exclude self from opponent display
}

// PlayArea.vue props
interface PlayAreaProps {
  lastPlay: Big2PublicState["lastPlay"] | null;
  isMyTurn: boolean;
  currentPlayerName: string;
}

// ActionPanel.vue props
interface ActionPanelProps {
  validActions: readonly ValidAction[];
  selectedCardCount: number;
  isMyTurn: boolean;
}
// emits: { "play": [], "pass": [] }

// GameLog.vue props
interface GameLogProps {
  entries: readonly Big2HistoryEntry[];
}

// GameOverView.vue props
interface GameOverViewProps {
  scores: readonly PlayerScore[];
  winner: string; // display name
  players: readonly PlayerPublicInfo[];
  isGuest: boolean;
  gameId: string;
}
```

### Shared Type (add to `src/shared/engine-types.ts` or import from big2-types)

The frontend needs the `Big2PublicState` and `Big2HistoryEntry` types. Since these are currently in `src/backend/engine/big2/big2-types.ts` (backend-only), they must be moved or re-exported from a shared location.

**Action:** Create `src/shared/big2-types.ts` containing `Big2PublicState`, `Big2HistoryEntry`, `Big2Play`, and `HandType` (the subset of Big2 types that appear in `PlayerView.gameSpecificPublicState`). The backend `src/backend/engine/big2/hand-types.ts` then re-exports `HandType` from the shared file instead of defining its own.

```typescript
// src/shared/big2-types.ts
import type { Card, PlayerId } from "./engine-types.js";

/**
 * Discriminated union of valid Big2 hand types.
 * This MUST match the backend definition in src/backend/engine/big2/hand-types.ts exactly.
 * The backend file should be refactored to re-export this type from @shared/big2-types.
 */
export type HandType =
  | { kind: "single"; card: Card }
  | { kind: "pair"; rank: string; highCard: Card }
  | { kind: "straight"; highCard: Card }
  | { kind: "fullHouse"; tripleRank: string; highCard: Card }
  | { kind: "fourOfAKind"; quadRank: string; highCard: Card }
  | { kind: "straightFlush"; highCard: Card };

/** Convenience union of the kind literals for display purposes. */
export type HandTypeKind = HandType["kind"];

export interface Big2Play {
  readonly cards: readonly Card[];
  readonly handType: HandType;
  readonly playerId: PlayerId;
}

export interface Big2HistoryEntry {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly action: "play" | "pass";
  readonly cards?: readonly Card[];
  readonly handType?: HandTypeKind;
}

export interface Big2PublicState {
  readonly lastPlay: Big2Play | null;
  readonly consecutivePasses: number;
  readonly isFreePlay: boolean;
  readonly isFirstPlayOfGame: boolean;
  readonly playHistory: readonly Big2HistoryEntry[];
  readonly finishedPlayerIndices: readonly number[];
}
```

---

## 4. State Model

### Data flow

```
Server (game:state event)
  │
  ▼
useGameState composable
  │  stores PlayerView in a shallowRef
  │  exposes: gameState, status, initialized
  │
  ├──► GameView.vue (reads status → decides which sub-view to render)
  │
  ├──► GameBoard.vue
  │     ├── OpponentRow (reads: gameState.players, currentPlayerIndex)
  │     ├── PlayArea (reads: gameState.gameSpecificPublicState.lastPlay)
  │     ├── PlayerHand (reads: gameState.you.hand)
  │     ├── GameLog (reads: gameState.gameSpecificPublicState.playHistory)
  │     └── ActionPanel (reads: gameState.validActions)
  │
  └──► GameOverView (reads: gameState.scores, gameState.winner)
```

### State lifecycle

1. **Mount:** `GameView` mounts → calls `useSocket().connect()` → on connect, emits `game:join` with gameId and role "player"
2. **Lobby:** If `game:join` succeeds and status is `"CREATED"`, render `GameLobbyView`. Listen for `lobby:playerJoined`/`lobby:playerLeft` to update player list in real-time.
3. **Game start:** Server emits `game:started` → followed immediately by first `game:state` event. `useGameState` updates status to `"IN_PROGRESS"`, triggering `GameBoard` render.
4. **Gameplay loop:** Each `game:state` event replaces the entire `gameState` ref. Components reactively update. On play/pass, `useGameActions` emits `game:action`, waits for ack, clears selection on success.
5. **Game over:** Server sends `game:state` with `status: "COMPLETED"`. `GameView` switches to `GameOverView`.
6. **Unmount:** `GameView` unmounts → `useSocket().disconnect()` fires → server handles via `disconnect` handler.

### What is persisted vs in-memory

| Data | Location | Lifetime |
|------|----------|----------|
| `PlayerView` | Vue reactive ref (client RAM) | Until component unmounts or replaced by next event |
| Card selection | Vue reactive ref (client RAM) | Cleared on successful play, new turn, or navigation |
| Socket connection | Browser WebSocket | Component lifetime |
| Game state (truth) | Server in-memory cache + Postgres | Until game eviction |

---

## 5. Component Structure

### File tree (new/modified files)

```
src/frontend/
  composables/
    useSocket.ts          (existing — add export for TypedClientSocket type)
    useGameState.ts       (new)
    useGameActions.ts     (new)
    useCardSelection.ts   (new)
  component/
    game/
      GameView.vue        (rewrite — orchestrator)
      GameLobbyView.vue   (rewrite — WebSocket-based)
      GameBoard.vue       (new — full game board layout)
      GameOverView.vue    (new)
    game-ui/
      GameCard.vue        (new)
      PlayerHand.vue      (new)
      OpponentRow.vue     (new)
      PlayArea.vue        (new)
      ActionPanel.vue     (new)
      GameLog.vue         (new)
  styles/
    game-variables.css    (new — CSS custom properties from mockup)
```

### CSS Architecture

All game UI components import a shared CSS custom properties file. This file defines the palette, typography, and spacing from the design mockup.

```css
/* src/frontend/styles/game-variables.css */
:root {
  --felt: #1a4a2e;
  --felt-light: #256b42;
  --table-rim: #2d1810;
  --table-rim-light: #4a2c1e;
  --card-face: #faf3e8;
  --card-shadow: rgba(0, 0, 0, 0.5);
  --gold-accent: #c9a84c;
  --gold-glow: rgba(201, 168, 76, 0.3);
  --red-suit: #8b1a1a;
  --black-suit: #1a1a1a;
  --text-primary: #e8dcc8;
  --text-muted: #8a7e6e;
  --bg-dark: #0d0d0d;
  --panel-bg: rgba(20, 12, 8, 0.85);

  --font-ui: "DM Sans", sans-serif;
  --font-card: "Libre Baskerville", serif;
}
```

Fonts are loaded via a `<link>` tag in `index.html` (Google Fonts).

### GameBoard grid layout

The mockup uses a CSS Grid layout:

```css
.game-board {
  width: 100vw;
  height: 100vh;
  display: grid;
  grid-template-rows: 80px 1fr 220px 64px;
  grid-template-columns: 1fr 280px;
  grid-template-areas:
    "opponents opponents"
    "table     log"
    "hand      log"
    "actions   actions";
}
```

This layout is fixed for desktop (1280px+). Mobile adaptation is out of scope.

---

## 6. GameView Orchestration Logic

```
GameView.vue
  onMounted:
    1. Fetch initial game info via REST (GET /api/getGameState) to get status + playerIds + playerDisplayNames
    2. Connect socket (useSocket.connect())
    3. On socket connect: emit game:join { gameId, role: "player" }
    4. On game:join ack success: bind useGameState and useGameActions listeners (both use bind(socket))
    5. If status === "CREATED": show GameLobbyView
       If status === "IN_PROGRESS" or "COMPLETED": server sends game:state immediately after join

  watch(status):
    "CREATED" → show GameLobbyView
    "IN_PROGRESS" → show GameBoard
    "COMPLETED" → show GameOverView

  Events listened on socket:
    - "game:state" → useGameState updates gameState ref
    - "game:started" → (status will change via next game:state)
    - "lobby:playerJoined" → update lobby player list
    - "lobby:playerLeft" → update lobby player list
    - "game:playerDisconnected" → (reflected in next game:state via isConnected=false)
    - "game:playerReconnected" → (reflected in next game:state via isConnected=true)
    - "error" → show error overlay
```

---

## 7. Card Rendering Spec

### Suit symbols

| Suit | Symbol | CSS class |
|------|--------|-----------|
| clubs | &clubs; | `black` |
| diamonds | &diams; | `red` |
| hearts | &hearts; | `red` |
| spades | &spades; | `black` |

### Rank display

| Rank value | Display |
|------------|---------|
| `"3"` through `"9"` | Same numeral |
| `"10"` | `10` |
| `"J"`, `"Q"`, `"K"`, `"A"` | Same letter |
| `"2"` | `2` |

### Card sizes

| Context | Width | Height | Class |
|---------|-------|--------|-------|
| Player hand | 64px | 90px | `.card--large` |
| Center play area | 64px | 90px | `.card--medium` |
| Opponent backs | 28px | 40px | `.card-back` |

### Card back design

Opponent cards are rendered as solid-color backs (deep crimson gradient `#8b1a1a` to `#5c1010`) with a subtle gold-bordered inner pattern (diagonal hatching). This matches the mockup's `.card-back` CSS exactly.

### Selection state

Selected cards translate upward by 20px and gain a gold border glow:

```css
.card--selected {
  transform: translateY(-20px);
  box-shadow: 0 8px 24px rgba(201, 168, 76, 0.3), 3px 6px 16px var(--card-shadow);
  border-color: var(--gold-accent);
}
```

### Hand fan overlap

Cards in the player's hand overlap with `margin-left: -20px` (first card gets `margin-left: 0`). Hover raises the card 8px. This produces a fan effect that matches the mockup.

---

## 8. Game Lobby Rewrite

The existing `GameLobbyView.vue` uses REST polling. This LLD rewrites it to use WebSocket events.

### Lobby player list: getting display names

The REST endpoint `GET /api/getGameState` currently returns `SerializableGame` which includes `playerIds: string[]` but not display names. The `Game` entity already stores `playerDisplayNames: Record<string, string>` (maps playerId to display name). The initial player list for the lobby needs display names.

**Required backend change:** Add `playerDisplayNames` to `SerializableGame` in `src/shared/model.ts` and include it in `serializeGameForPlayer()` (`src/backend/util/serializer.ts`):

```typescript
// Addition to SerializableGame in src/shared/model.ts
export interface SerializableGame {
  gameId: string;
  gameType: GameType;
  maxPlayers: number;
  playerIds: string[];
  playerDisplayNames: Record<string, string>; // NEW: playerId → displayName
  status: GameStatus;
  state: SerializableGameState;
}
```

The lobby constructs its initial `PlayerInfo[]` by mapping `playerIds` through `playerDisplayNames`. Subsequent updates come via `lobby:playerJoined` events (which already carry `PlayerInfo`).

### Lobby state

```typescript
interface LobbyState {
  players: PlayerInfo[];   // built from REST playerIds + playerDisplayNames, then updated via WS events
  isHost: boolean;         // true if current user is the first player (playerIds[0])
  maxPlayers: number;      // from game config
  canStart: boolean;       // isHost && players.length >= 2
  gameId: string;
  inviteLink: string;      // window.location.origin + "/game/" + gameId + "/join"
}
```

### Start button

Enabled when `canStart` is true. Calls `useGameActions.startGame(gameId)`. On success, the server emits `game:started` followed by `game:state`, which triggers the status transition in `GameView`.

### Copy link

A "Copy Link" button copies `inviteLink` to clipboard via `navigator.clipboard.writeText()`.

---

## 9. Game Over Screen

Displays when `status === "COMPLETED"`.

### Layout

- Winner announcement: "{displayName} wins!" in gold accent text
- Scores table: columns for Player, Place, Cards Left, Points
- Place is derived from score ordering (5pts = 1st, 3pts = 2nd, etc.)
- Cards left per player: derived from `gameState.players[i].cardCount` at game end
- Action buttons:
  - "Rematch" (disabled placeholder for v1 — emits nothing, shows tooltip "Coming soon")
  - "Back to Home" (navigates to `/`)
- Guest sign-up nudge (shown only if `isGuest`): "Sign up to save your stats" with link to `/signup?redirect=/game/${gameId}`

### Score display mapping

The `PlayerScore` objects from `gameState.scores` contain `playerId` and `score`. Map `playerId` to `displayName` via `gameState.players`. Sort by score descending for placement ordering.

---

## 10. Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | Socket disconnects mid-game | Socket.IO auto-reconnects (configured in `useSocket`). On reconnect, client re-emits `game:join`. Server sends fresh `game:state`. No user action needed. |
| 2 | User refreshes page during game | `GameView` remounts, socket reconnects, `game:join` re-emits. Server recognizes reconnecting player and sends current state. `useCardSelection` resets (selection lost — acceptable). |
| 3 | Player submits invalid card combo | Server ack returns `{ success: false, error: "..." }`. `useGameActions` sets `actionError` ref. `ActionPanel` displays error text below buttons for 3 seconds, then clears. Selection is preserved so user can adjust. |
| 4 | Not your turn, user clicks cards | `PlayerHand` prop `interactive` is `false` when `currentPlayerIndex !== myPlayerIndex`. Click events are ignored (no selection toggle). Cards do not show hover effects. |
| 5 | Server emits game:state with COMPLETED during play | `status` ref changes to `"COMPLETED"`. `GameView` immediately switches to `GameOverView`. No special handling needed. |
| 6 | Game full — player tries to join via guest entry | REST `POST /api/joinGame` returns 409. `GuestEntryView` already handles this (shows "Game is full"). |
| 7 | Game not found | REST `GET /api/getGameState` returns 404. `GameView` shows error message: "Game not found." with link to home. |
| 8 | Host leaves lobby | Server emits `lobby:playerLeft`. If host was playerIds[0], hosting does not transfer (per current server behavior). Start button becomes unusable since only playerIds[0] can start. Future: host transfer. |
| 9 | Last play is null (free play / first trick) | `PlayArea` shows "New Trick — Play any combination" instead of last play cards. |
| 10 | Player has finished (no cards) but game continues | Player's `validActions` is empty (server sends `[]`). `ActionPanel` shows nothing. Hand area shows "Finished — waiting for others." |
| 11 | `game:join` ack returns error | `GameView` shows an error overlay with the message and a "Back to Home" button. Does not render lobby or board. |
| 12 | Multiple browser tabs | Each tab opens its own socket. Server's `ConnectionManager` supports multiple sockets per player. Both tabs receive `game:state`. Actions from either tab are accepted. |

---

## 11. Dependencies

| Dependency | Source | Required for |
|------------|--------|-------------|
| Socket.IO client + `useSocket.ts` | LLD 3 (implemented) | All real-time communication |
| `game:state`, `game:action`, `game:start` protocol | `src/shared/socket-events.ts` (implemented) | Event emission and handling |
| `PlayerView`, `ValidAction`, `Card` types | `src/shared/engine-types.ts` (implemented) | Type safety across composables and components |
| `Big2PublicState`, `Big2HistoryEntry` types | Must be extracted to `src/shared/big2-types.ts` (new) | Game log, play area rendering |
| REST endpoints: `GET /api/getGameState`, `POST /api/joinGame` | Existing backend (implemented — requires adding `playerDisplayNames` to `SerializableGame`) | Initial state fetch, joining games |
| Guest session service | LLD 5 (implemented) | Guest auth token for socket connection |
| `game:start` server handler | LLD 3 (implemented in `socketHandler.ts`) | Starting games from lobby |
| Big2 engine producing `PlayerView` | LLD 4 (implemented) | All gameplay data |

### Font dependency

Add to `src/frontend/index.html`:
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Libre+Baskerville:wght@400;700&display=swap" rel="stylesheet">
```

---

## 12. Test Requirements

### Unit tests (composables)

| Test | Assertion |
|------|-----------|
| `useCardSelection` — toggle selects/deselects | `toggleCard(2)` twice returns to empty set |
| `useCardSelection` — clearSelection resets | After selecting 3 cards, `clearSelection()` results in empty set |
| `useCardSelection` — selectedCards maps indices to Card objects | Given hand `[A, B, C]` and selected indices `{0, 2}`, `selectedCards` returns `[A, C]` |
| `useGameState` — bind updates gameState on event | Emit mock `game:state` event → ref updates to the emitted view |
| `useGameState` — status derived from gameState | After receiving view with `status: "IN_PROGRESS"`, `status.value` equals `"IN_PROGRESS"` |
| `useGameActions` — playCards emits correct payload | After `bind(mockSocket)`, call `playCards(gameId, cards)` → socket.emit called with `{ gameId, action: { type: "playCards", cards, playerId: "" } }` |
| `useGameActions` — sets actionError on failure ack | Mock ack with `{ success: false, error: "Invalid" }` → `actionError.value` equals `"Invalid"` |
| `useGameActions` — actionPending true during flight | After calling `pass()`, `actionPending` is true until ack resolves |

### Integration tests (component behavior)

| Test | Assertion |
|------|-----------|
| `GameView` — renders lobby when status is CREATED | Mount with mock REST returning `{ status: "CREATED" }` → `GameLobbyView` is rendered |
| `GameView` — transitions to GameBoard on game:started | After mock socket emits `game:state` with `status: "IN_PROGRESS"` → `GameBoard` is rendered |
| `GameView` — transitions to GameOverView on COMPLETED | After mock socket emits `game:state` with `status: "COMPLETED"` → `GameOverView` is rendered |
| `PlayerHand` — click toggles selection | Click card at index 3 → emits `toggle-card` with value `3` |
| `PlayerHand` — non-interactive does not emit | With `interactive: false`, click does not emit |
| `ActionPanel` — Play button disabled when no cards selected | With `selectedCardCount: 0` → Play button has `disabled` attribute |
| `ActionPanel` — Play button enabled when cards selected and playCards in validActions | With `selectedCardCount: 2` and validActions includes `{ type: "playCards" }` → Play button enabled |
| `ActionPanel` — Pass button visible only when "pass" in validActions | With `validActions: [{ type: "playCards" }]` → Pass button not rendered |
| `GameLobbyView` — start button disabled when < 2 players | With 1 player in list → Start button disabled |
| `GameLobbyView` — player list updates on lobby:playerJoined | Emit mock event → new player appears in list |

### Visual/structural tests

| Test | Assertion |
|------|-----------|
| `GameCard` — renders correct suit symbol | Card with `suit: "hearts"` renders the hearts unicode symbol |
| `GameCard` — applies red class for hearts/diamonds | Card with `suit: "diamonds"` has CSS class `red` |
| `GameCard` — faceDown shows card-back styling | With `faceDown: true`, card does not display rank/suit |
| `OpponentRow` — active player has gold indicator | Player at `currentPlayerIndex` has `.opponent--active` class |
| `GameLog` — renders all history entries | Given 5 entries, renders 5 `.log-entry` elements |
| `GameOverView` — shows guest signup nudge when isGuest | With `isGuest: true`, signup link is visible |
| `GameOverView` — hides guest signup nudge for registered users | With `isGuest: false`, signup link is not rendered |

### What NOT to test

- Socket.IO connection/reconnection behavior (library responsibility)
- Server-side event emission (covered by backend tests in LLD 3)
- Card combination validity logic (backend responsibility per Architecture Principle 1)
- CSS visual rendering accuracy (verified manually against mockup)
