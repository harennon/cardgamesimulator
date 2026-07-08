# LLD 162: Non-destructive "Reconnecting…" state for the local player's own connection

## Scope

**Covers (client-only):**
- `useSocket.ts`: replace the single `error` string with a reconnection-aware **tri-state** (`connected` / `reconnecting` / `terminal`) driven off the Socket.IO Manager events (`reconnect_attempt`, `reconnect`, `reconnect_failed`) plus the socket's own `connect` / `disconnect` / `connect_error`. `SERVER_FULL` and other terminal handshake errors stay on a separate terminal-join-failure path.
- `GameView.vue`: stop routing connection errors into `joinError`. Reserve `joinError` strictly for terminal join failures (game not found, not authorized, server full, couldn't connect at all). Consume the new connection state and render a **non-destructive banner over the still-rendered board**, clearing automatically on reconnect.
- `ActionPanel.vue` / `TonkActionPanel.vue`: add a connection-aware disabled state with a hover reason, threaded from `GameView` → `GameBoard` / `TonkBoard` → panel.
- `useGameActions.ts`: add an ~8s timeout to every ack await so an offline action rejects with a clear message instead of hanging; `actionPending` always resets.
- Applies to **Big2 and Tonk** active boards and to **spectators** (same banner, no action buttons to lock).

**Explicitly does NOT cover:**
- Any backend, schema, migration, or socket-event contract change. The server still validates and applies every action; no game logic moves to the client.
- The lobby (`CREATED`) banner — deferred as an optional follow-up (see Edge Cases E9).
- Opponent-disconnect UX (`OpponentRow` "disconnected" badge) — already shipped; unchanged.
- AI-opponent connection issues (backlog #139/#140) — out of scope.
- `navigator.onLine` branching — deliberately not done; one neutral message.
- Server-side "pause game on disconnect / auto-pass" behavior (CX doc line 218) — a separate concern; this LLD is only the local player's own client feedback.

## Approach

### The bug, precisely
1. `useSocket.ts:49-57` sets `error` on **any** non-`SERVER_FULL` `connect_error`. Socket.IO fires `connect_error` on every failed reconnection attempt during automatic reconnection, so a transient blip populates `error`.
2. `GameView.vue:201-203` does `watch(socketError, (err) => { if (err) joinError.value = err; })`. `joinError` is the **first** `v-if` in the template (line 2) and renders a full-screen "Back to Home" screen, destroying the live board (which is a later `v-else-if`).
3. `joinError` is never reset to `null`, so the ejection is permanent even after the socket reconnects underneath.
4. `GameView` destructures only `{ socket, error, connect, disconnect }` — it never reads `connected`, so a plain `disconnect` gives zero feedback.
5. `useGameActions.ts` awaits an ack `Promise` with no timeout — offline, it never resolves and `actionPending` stays `true` forever.

### Design decisions
- **Tri-state in `useSocket`, driven by Manager events.** The Socket.IO **Manager** (`socket.io`) emits `reconnect_attempt(attempt)`, `reconnect(attempt)`, and `reconnect_failed`. These give a clean "reconnecting (attempt N/10)" vs "gave up" distinction that a lone `connected=false` cannot. We expose a single `connectionState` computed plus a raw `connected` boolean and a `reconnectAttempt` counter. Rationale (answers open question 1): using Manager events keeps the terminal-vs-reconnecting distinction authoritative rather than inferred from timers.
- **Separate transient errors from terminal errors.** `connect_error` no longer writes a generic `error` string. Instead: `SERVER_FULL` (and any future terminal handshake error) sets a dedicated `terminalError` ref and disconnects; all other `connect_error`s are treated as transient (they are part of the reconnection cycle) and only affect `connected`/`reconnecting`. This is the core fix for bug #1.
- **`joinError` is reserved for board-less failures.** `GameView` stops watching `socketError`→`joinError`. `joinError` is set only by: REST 401 / not-found, the `game:join` ack failing, `connect()` failing to produce a socket, or `useSocket.terminalError` (SERVER_FULL). These are all cases where there is no board to preserve.
- **Non-destructive banner, board stays mounted.** The banner is an absolutely-positioned overlay inside `game-view__board-container`, rendered while a board is live (`displayPhase` is IN_PROGRESS / SHOW_FINAL_PLAY / SHOW_TRICK_RESULT). The board dims slightly but stays rendered and in place. On `reconnect`, `connectionState` returns to `connected`, the banner disappears, and the server re-emits `game:state` so the view re-syncs — no navigation, no manual reload.
- **Terminal recovery = "Reload to rejoin".** After `reconnect_failed` (all 10 attempts exhausted), the banner escalates to a red terminal state with a **"Reload to rejoin"** button that calls `window.location.reload()` (answers open question 2). Reload re-runs the full mount/join flow, which is the most robust recovery given the socket manager has given up. We deliberately do not offer a bare `connect()` retry: the composable's `connect()` guards against re-entry when `socket.value` is already set, and re-running the mount flow is what actually re-establishes REST seed + join.
- **Action-ack timeout = 8s, no auto-retry.** Each ack await races against an 8s timer (answers open question 3). On timeout the promise resolves to `{ success: false, error: "Couldn't reach the server — reconnecting…" }`, `actionError` is set (surfaced in the existing action-panel error line), and `actionPending` resets via the existing `finally`. No auto-retry — the player re-submits on reconnect. The server is authoritative per turn, so a re-submit of a stale action is simply rejected; a duplicate of a still-valid action is the player's explicit choice.
- **Buttons locked with a reason.** Panels receive a `disabledReason: string | null` prop. When non-null it forces `disabled` on all action buttons and sets a `title` (hover tooltip) + `aria` affordance so the control does not look clickable. `GameView` passes `"Reconnecting…"` while reconnecting and `"Disconnected — reload to rejoin"` when terminal.
- **One neutral message; no `navigator.onLine`** (answers open question 5) — keeps copy simple and avoids a second failure mode to reason about.

### Data flow
```
useSocket (Manager events) → connectionState/connected/reconnectAttempt/terminalError
        │
        ├─ GameView: connectionState → banner overlay + disabledReason
        │             terminalError  → joinError (SERVER_FULL only)
        │
        └─ GameView → GameBoard/TonkBoard (disabledReason prop)
                          → ActionPanel/TonkActionPanel (disabledReason)

useGameActions: ack await races 8s timeout → {success:false,error} ; actionPending always resets
```

## Frontend Design

Frontend architecture decision: **approve leans** (owner-approved). The following visual behavior is authoritative for implementation.

### Connection banner (`ConnectionBanner.vue`, new)
A small presentational component rendered as an overlay inside `game-view__board-container`. Absolutely positioned, top-center, above the board content but below full-screen reveal layers (z-index between board content `z-index:1` and reveal `z-index:101` — use `z-index: 90`).

- **Reconnecting state** (`connectionState === 'reconnecting'`): amber **pulsing pill** — `Connection lost — reconnecting…`, with an optional `attempt N/10` suffix when `reconnectAttempt > 0`. Uses the existing `pulse` keyframe pattern (see `OpponentRow.vue`); respects `@media (prefers-reduced-motion: reduce)` (no pulse).
- **Terminal state** (`connectionState === 'terminal'`): red banner — `Connection lost` with a concrete **"Reload to rejoin"** button (`@click="reload"` → `window.location.reload()`). No pulse.
- **Connected state**: banner not rendered (`v-if`), clears automatically.
- The board stays rendered underneath in **all** states, **slightly dimmed** while not connected — apply `filter: brightness(0.7)` + `pointer-events: none` on the board container via a `--disconnected` modifier class bound to `connectionState !== 'connected'`. (Do not reuse the `--revealing` blur; dim only, so the player can still read their hand.)
- Copy is one neutral message regardless of client-offline vs server-down.
- Colors: amber = `var(--gold-accent)`; red terminal = the existing error red used elsewhere (`#e05555` / `var(--error-text)`). Font `var(--font-ui)`. `data-testid="connection-banner"`, with `data-state` = the connection state for tests.

### Locked action buttons
- `ActionPanel` and `TonkActionPanel` gain a `disabledReason?: string | null` prop.
- When `disabledReason` is non-null: every action button's `:disabled` is forced true (OR-ed with existing conditions) and each button gets `:title="disabledReason"` so hovering explains why. Buttons keep the existing `:disabled` opacity/`cursor:not-allowed` styling — no new visual state needed, they simply read as non-clickable.
- The reason string is authored by `GameView`: `"Reconnecting…"` (reconnecting) or `"Disconnected — reload to rejoin"` (terminal); `null` when connected.
- Spectators have no action panel rendered (Big2: no local hand path; Tonk: `hasHand === false`), so there is nothing to lock — they still see the banner. No extra guard needed beyond passing the prop through.

### Spectator parity
The banner lives at the `GameView`/board-container level, not inside the action panel, so spectators (no `you` seat) get the identical banner. Verified: `GameView` renders `TonkBoard`/`GameBoard` for spectators too; only the hand/action zones differ.

### Placement note
Because Big2's `.game-board` and Tonk's `.tonk-board` are `position: fixed`/full-bleed, the banner must be a sibling overlay in `game-view__board-container` (which is `position: relative`) rather than a child of the board, matching how `.game-view__reveal` is layered today.

## Interfaces / Types

### `useSocket.ts` (revised return surface)
```ts
export type ConnectionState = "connected" | "reconnecting" | "terminal";

export function useSocket(): {
  socket: ShallowRef<TypedClientSocket | null>;
  connected: Readonly<Ref<boolean>>;
  /** tri-state derived from Manager reconnect events + connect/disconnect */
  connectionState: Readonly<Ref<ConnectionState>>;
  /** current reconnection attempt number (0 when connected/idle), for "N/10" copy */
  reconnectAttempt: Readonly<Ref<number>>;
  /** total configured attempts, exposed for "N/M" copy (10) */
  maxReconnectAttempts: number;
  /** terminal HANDSHAKE failures only (SERVER_FULL, auth). Feeds joinError. */
  terminalError: Readonly<Ref<string | null>>;
  connect(): Promise<void>;
  disconnect(): void;
};
```
Event wiring inside `connect()`:
- `s.on("connect")` → `connected=true`, `connectionState="connected"`, `reconnectAttempt=0`, clear transient state.
- `s.on("disconnect")` → `connected=false`. Set `connectionState="reconnecting"` **only if** the disconnect reason is one the manager will retry (i.e. not a client-initiated `io client disconnect`); otherwise leave it. (Simplest correct rule: set `reconnecting` on disconnect; `connect`/`reconnect_failed` will correct it.)
- `s.on("connect_error", err)` → if `err.message === "SERVER_FULL"` set `terminalError` and `s.disconnect()`; **else do nothing** (transient — part of reconnection).
- `s.io.on("reconnect_attempt", (n) => { connectionState="reconnecting"; reconnectAttempt=n; })`
- `s.io.on("reconnect", () => { /* 'connect' will also fire */ })`
- `s.io.on("reconnect_failed", () => { connectionState="terminal"; })`
- `disconnect()` (manual) must set `connectionState="connected"`-neutral or leave as-is on unmount; ensure it does not leave a stale `terminal`/`reconnecting` for the next `connect()`. Reset refs at the top of `connect()`.

> Note: `connect_error` also fires on the **initial** connection attempt (before any board exists). During mount, `GameView` awaits `connect()` and then checks `socket.value`; a first-attempt failure is handled by the existing `joinError = "Could not connect to server."` path, not the banner. The banner only appears once a board is live.

### Connection-state mapping helper (pure, exported for unit test)
Extract the reducer logic so it is testable without a socket:
```ts
// src/frontend/composables/connectionState.ts
export interface ConnInputs {
  connected: boolean;
  reconnectFailed: boolean;
}
export function deriveConnectionState(i: ConnInputs): ConnectionState {
  if (i.reconnectFailed) return "terminal";
  return i.connected ? "connected" : "reconnecting";
}
```
`useSocket` composes its refs through this function so the mapping is unit-testable in the node env (no DOM, no real socket), matching the project's pure-function test pattern.

### `useGameActions.ts` (ack timeout)
Introduce one private helper used by every emitting method:
```ts
const ACTION_ACK_TIMEOUT_MS = 8000;

function emitWithTimeout<R extends { success: boolean; error?: string }>(
  emitFn: (resolve: (r: R) => void) => void,
  onTimeout: () => R,
): Promise<R> {
  return new Promise<R>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onTimeout());
    }, ACTION_ACK_TIMEOUT_MS);
    emitFn((r) => {
      if (settled) return;      // ack arrived after timeout → ignore
      settled = true;
      clearTimeout(timer);
      resolve(r);
    });
  });
}
```
Each method (`playCards`, `pass`, `discard`, `drawCard`, `callTonk`, `startGame`, `rematch`) wraps its `socket.emit(...)` in `emitWithTimeout`. On timeout, `onTimeout` returns `{ success: false, error: "Couldn't reach the server — reconnecting…" }` and the method sets `actionError.value` to that message. `actionPending` continues to reset in the existing `finally` block — so it can never stick. No auto-retry.

### Panel prop additions
`ActionPanel.vue` and `TonkActionPanel.vue`:
```ts
disabledReason?: string | null;   // non-null ⇒ all action buttons disabled + title=reason
```
Threaded through `GameBoard.vue` and `TonkBoard.vue` as a pass-through prop of the same name.

## State Model

All state is **in-memory / ephemeral client state**. Nothing is persisted; no new server state. The server remains the single source of truth for game state, which is re-delivered via `game:state` on reconnect.

| State | Owner | Lifetime | Notes |
|---|---|---|---|
| `connected` | `useSocket` | per socket | true only between `connect` and `disconnect` |
| `connectionState` | `useSocket` | per socket | `connected` → `reconnecting` (on drop / `reconnect_attempt`) → `connected` (on `reconnect`) or `terminal` (on `reconnect_failed`) |
| `reconnectAttempt` | `useSocket` | per reconnection cycle | 0 when connected; N during attempt N; reset on `connect` |
| `terminalError` | `useSocket` | per socket | set once for SERVER_FULL/auth; drives `joinError` |
| `joinError` | `GameView` | per view | set once for board-less failures; **still never cleared** — but now only set for genuinely terminal cases, so that's correct |
| `disabledReason` | `GameView` (computed) | derived | `null` when connected, else the reason string |
| `actionPending` / `actionError` | `useGameActions` | per action | `actionPending` always resets in `finally`; `actionError` shows the timeout message |

**Transitions on the happy reconnect path:** live board → WiFi drop → `disconnect` fires → `connectionState="reconnecting"` → banner shows, buttons lock → manager retries (`reconnect_attempt` bumps counter) → `reconnect` + `connect` fire → `connectionState="connected"`, `reconnectAttempt=0` → banner clears, buttons unlock → server re-emits `game:state` → board re-syncs. **No `joinError` was ever touched; no navigation occurred.**

**Terminal path:** …reconnecting… → 10 attempts fail → `reconnect_failed` → `connectionState="terminal"` → red banner + "Reload to rejoin". `joinError` still untouched (board stays behind the banner); only a user-initiated reload leaves the view.

## Edge Cases

- **E1 — Transient blip mid-game.** `connect_error` during reconnection no longer sets any error. Board stays; banner shows reconnecting. **(Primary acceptance criterion.)**
- **E2 — Successful reconnect.** `connect`/`reconnect` clears `connectionState` to `connected`, banner disappears, buttons re-enable, `game:state` re-syncs. No manual reload. **(Guards against the old "permanently stranded" bug — verify `joinError` was never set.)**
- **E3 — Reconnect exhausted (10 attempts).** `reconnect_failed` → terminal banner + "Reload to rejoin". Only case approaching the old full-screen severity, but board is still behind it.
- **E4 — Action attempted while offline.** Button is already locked (disabledReason). If somehow triggered, the emit's ack never returns; the 8s timeout resolves `{success:false}`, `actionError` shows "Couldn't reach the server — reconnecting…", `actionPending` resets. No infinite spinner.
- **E5 — Action in flight when the drop happens.** Same as E4: the pending ack times out at 8s and surfaces the message; player re-submits after reconnect. No auto-retry.
- **E6 — Ack arrives after timeout.** `settled` guard in `emitWithTimeout` ignores the late ack; no double-resolve, no state flap.
- **E7 — SERVER_FULL / auth handshake failure.** Routed to `terminalError` → `joinError` → full-screen error, unchanged behavior. Distinct from transient `connect_error`.
- **E8 — Initial connect fails at mount (no board yet).** Handled by existing `joinError = "Could not connect to server."` in `onMounted`; banner not involved (no board to preserve).
- **E9 — Drop while in lobby (`CREATED`).** Out of scope for this LLD; lobby keeps current behavior (no banner). The banner renders only for live-board phases. Documented as an optional follow-up.
- **E10 — Spectator drops.** Banner shows identically; there are no action buttons to lock. Board stays rendered.
- **E11 — Drop during a Tonk trick reveal / Big2 final-play overlay.** Banner z-index (90) sits below the reveal layer (101) so the reveal stays legible; the reveal's own timers are unaffected (client-local). Reconnect proceeds underneath.
- **E12 — Manual disconnect on unmount.** `onUnmounted` → `disconnect()` sets `connected=false` but the view is tearing down; ensure `connect()` resets `connectionState`/`reconnectAttempt`/`terminalError` at its top so a later mount starts clean (no stale terminal).
- **E13 — Reduced motion.** Banner pulse animation is disabled under `prefers-reduced-motion: reduce`; banner still renders (color-only).
- **E14 — Rapid flap (drop→reconnect→drop).** State follows the latest event; `reconnectAttempt` resets on each `connect`. Banner toggles accordingly; buttons follow `disabledReason`. No accumulation because refs are absolute values, not increments beyond the manager's own counter.

## Dependencies
## Dependencies

**Must exist (all already present):**
- `useSocket.ts` (`socket.io-client` Manager exposes `socket.io.on(...)` — the reconnection events used here are standard socket.io-client v4 API; no new dependency).
- `useGameActions.ts`, `GameView.vue`, `GameBoard.vue`, `TonkBoard.vue`, `ActionPanel.vue`, `TonkActionPanel.vue` — all edited in place.
- Server continues to emit `game:state` on (re)join — already the case (`GameView.onMounted` binds state before `game:join`, and the server re-emits state for IN_PROGRESS games).
- Existing `--error-text` / `--gold-accent` CSS variables in `game-variables.css`.

**New file:** `src/frontend/component/game-ui/ConnectionBanner.vue` (presentational), and `src/frontend/composables/connectionState.ts` (pure mapping helper).

**No dependency on:** backend, schema/migrations, socket-event contract, or LLD #139/#140.

**Blocking:** none. This LLD can be implemented independently.

## Test Requirements

Follow the project's frontend test convention: **node environment, no DOM mount**, transcribe load-bearing logic as pure functions/refs and test directly (as in `disconnectedLabel.test.ts`, `tonkTrickReveal.test.ts`, `gameBoardMobile.test.ts`). Place tests under `tests/frontend/`.

### Unit — connection-state mapping (`tests/frontend/connectionState.test.ts`)
- `deriveConnectionState({connected:true, reconnectFailed:false})` → `"connected"`.
- `{connected:false, reconnectFailed:false}` → `"reconnecting"`.
- `{connected:false, reconnectFailed:true}` → `"terminal"`.
- `reconnectFailed:true` dominates even if `connected` momentarily true (terminal is sticky until reset).
- Simulate the event sequence (connect → disconnect → reconnect_attempt(3) → reconnect → connect) against ref-mirrored reducer logic and assert `connectionState` and `reconnectAttempt` values at each step, including reset to 0 on `connect`.

### Unit — "connection error does NOT set joinError while a board is live" (`tests/frontend/connectionBannerJoinError.test.ts`)
- Transcribe the new `GameView` rule: a transient `connect_error` / `disconnect` while `displayPhase` is a live-board phase must **not** mutate `joinError` (assert `joinError` stays `null`) and must set `connectionState="reconnecting"`.
- `SERVER_FULL` (via `terminalError`) **does** set `joinError` (board-less terminal path).
- **Recovery assertion (regression guard for the old permanent-stranding bug):** after reconnecting-then-connected, `joinError` is still `null` and `disabledReason` returns to `null` — proving controls re-enable without a manual reload.

### Unit — action-ack timeout (`tests/frontend/actionAckTimeout.test.ts`)
- With `vi.useFakeTimers()`, an emit whose ack never fires resolves to `{success:false, error:"Couldn't reach the server — reconnecting…"}` after 8s, and `actionPending` is `false` afterward.
- An ack that arrives before 8s resolves normally and the timer is cleared (no late double-resolve — assert the late ignored path via E6).
- A late ack after timeout is ignored (no throw, no second resolve).

### Component/logic — banner + button locking
Following the repo pattern (ref-driven, no full mount where avoidable; a light mount is acceptable for `ConnectionBanner.vue` render assertions using the transcription style):
- `connection-banner` is absent when `connectionState==="connected"`, shows the amber reconnecting pill when `"reconnecting"` (with `attempt N/10` when `reconnectAttempt>0`), and shows the red terminal banner + "Reload to rejoin" when `"terminal"`. Assert via `data-state` / text.
- Banner **appears then clears** as `connectionState` toggles `connected → reconnecting → connected` (drives the "clears automatically" acceptance criterion).
- `disabledReason` computed: `null` when connected, `"Reconnecting…"` when reconnecting, `"Disconnected — reload to rejoin"` when terminal.
- `ActionPanel` / `TonkActionPanel`: when `disabledReason` is non-null, Play/Pass and discard/draw/callTonk buttons are `disabled` regardless of `isMyTurn`, and carry `title === disabledReason`.
- Spectator: banner logic is independent of a `you` seat (assert the banner predicate does not reference the local seat).

### Not tested (per testing-principles §"Don't test framework behavior")
- That socket.io actually emits `reconnect_attempt`/`reconnect_failed` — that's library behavior. We test our **mapping** of those events, not the events themselves.
- Visual pulse animation / exact CSS — covered by manual QA against the CX doc if needed.

