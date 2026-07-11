# LLD 165: "Server not reachable" warning shown while game is still playable

## Scope

**Covers (client-only, surgical follow-up to LLD 162):**
- `useSocket.ts`: add a **grace/debounce window (~1.75s)** before the `reconnecting` state is surfaced to the UI on a `retry`-class disconnect or `reconnect_attempt`. A fast recovery (`connect` fires within the window) cancels the pending transition so the banner never renders for a transient blip.
- `useSocket.ts`: add `"polling"` as a transport fallback (`transports: ["websocket", "polling"]`) so a brief WebSocket interruption behind an idle-timeout proxy does not immediately register as a hard disconnect.

**Explicitly does NOT cover:**
- The `connectionState.ts` state machine or the `classifyDisconnect` / `deriveConnectionState` mapping — **unchanged**. The classification of a disconnect reason is correct; this LLD changes only *when* the UI reflects an entry into `reconnecting`, not *how* the reason is classified.
- The **recovery** (`connect`) path — recovery must always clear the banner **immediately**; only the *entry* into `reconnecting` is debounced.
- The **terminal** path (`reconnect_failed`, `"io server disconnect"` → "Reload to rejoin") — **not** subject to the grace window; terminal must still escalate promptly.
- `GameView.vue`, `ConnectionBanner.vue`, `ActionPanel`/`TonkActionPanel`, `useGameActions.ts` — all consume `connectionState` unchanged. No prop, template, or CSS changes. The board-dimming + `pointer-events:none` + `disabledReason` behavior for a genuine drop is preserved exactly as today.
- Any backend, schema, migration, or socket-event contract change. No game logic moves to the client.
- The reconnect re-join logic (`game:join` re-emit) from LLD 162 — unchanged and unaffected.

## Approach

### The bug, precisely
LLD 162 shipped a correct tri-state connection model, but it surfaces `reconnecting` **synchronously** on the first sign of trouble:
- `useSocket.ts:104` sets `connectionState = "reconnecting"` the instant a `retry`-class `disconnect` fires.
- `useSocket.ts:122-125` (`reconnect_attempt`) also sets `connectionState = "reconnecting"` immediately.

Socket.IO auto-reconnects (`reconnection: true`, `reconnectionDelay: 1000`) and `GameView` re-emits `game:join` on reconnect, so a dropped/delayed WebSocket ping-pong or a proxy idle timeout typically recovers within ~1s. The banner therefore **flashes** for a transient blip even though connectivity is effectively fine — the false alarm the user reported ("shows server not reachable but I can still play"). Compounding it, `transports: ["websocket"]` (line 74) has no polling fallback, so a single WebSocket hiccup becomes a full `transport close` / `ping timeout` disconnect.

### Design decisions
- **Debounce the entry into `reconnecting`, not the classification.** Keep `classifyDisconnect` and `deriveConnectionState` exactly as they are. Instead of writing `connectionState.value = "reconnecting"` directly from the `disconnect` and `reconnect_attempt` handlers, schedule it behind a `setTimeout(GRACE_MS)`. If `connect` fires before the timer elapses, cancel the timer — the banner never appears. This is the smallest change that satisfies the acceptance criteria and is fully covered by the existing test harness.
- **Grace window = 1750ms.** Sits inside the acceptance-criteria band (~1.5–2s). Socket.IO's first reconnect attempt fires at `reconnectionDelay: 1000`ms; a healthy blip reconnects shortly after, so 1750ms comfortably absorbs a single-attempt recovery while still surfacing a genuine drop "promptly" (well under 2s). Defined as an exported const so tests and future tuning are trivial.
- **Recovery is never debounced.** The `connect` handler continues to set `connectionState = "connected"` **synchronously** and additionally **clears any pending grace timer**. A fast recovery thus resolves to `connected` with no intermediate `reconnecting` ever observed.
- **Terminal is never debounced.** `reconnect_failed` and the `"io server disconnect"` (`classifyDisconnect === "terminal"`) branch continue to set `connectionState = "terminal"` **synchronously**, and also clear any pending grace timer (so a queued `reconnecting` can't overwrite a terminal state a beat later). The "Reload to rejoin" affordance still appears promptly.
- **Single timer, always cleared.** Exactly one closure-scoped timer handle (`_graceTimer`) lives per `useSocket()` instance. It is cleared (and nulled) on `connect`, on `terminal`, at the top of `connect()` (fresh-connection reset), and in `disconnect()` (teardown). Every path that schedules a new grace timer first clears any existing one. This prevents leaked or duplicated timers across rapid drop→reconnect→drop flapping.
- **Idempotent scheduling.** Both the `disconnect(retry)` handler and `reconnect_attempt` want to enter `reconnecting`. A shared `_scheduleReconnecting()` helper clears any existing timer and starts one; calling it repeatedly (e.g. `disconnect` then several `reconnect_attempt`s) collapses to a single pending transition, not a pile of timers. `reconnect_attempt` still updates `reconnectAttempt` synchronously (cheap, not user-visible until the banner shows).
- **Polling fallback.** Change `transports` to `["websocket", "polling"]`. Socket.IO still prefers WebSocket and upgrades to it; polling is only used when WebSocket is unavailable/interrupted, reducing spurious `transport close` disconnects behind idle-timeout proxies. This is an independent, additive mitigation and does not change any state logic.

### Data flow
```
socket 'disconnect'(retry)   ─┐
socket.io 'reconnect_attempt' ┼─ _scheduleReconnecting() ─ GRACE_MS ─> connectionState = "reconnecting"
                              │       ▲                                   (banner shows, board dims — as today)
socket 'connect' ────────────┼───────┘ clears timer, sets connectionState = "connected" (immediate)
socket 'disconnect'(terminal) ┤         clears timer, sets connectionState = "terminal"   (immediate)
socket.io 'reconnect_failed' ─┘         clears timer, sets connectionState = "terminal"   (immediate)
```

## Frontend Design

Frontend architecture decision: **option A** — debounce in `useSocket` only; no visual/markup changes.

There are **no changes to any Vue component, template, style, or prop**. `ConnectionBanner.vue`, the `--disconnected` board-dimming modifier, `disabledReason`, and the amber/red banner copy from LLD 162 are all untouched. The only behavioral difference the user perceives is temporal: for a genuine drop the banner appears ~1.75s later than before (still prompt), and for a sub-second blip it does not appear at all. Because `ConnectionBanner.vue` is a pure `v-if` on `connectionState`, gating the *timing* of that ref in `useSocket` fully controls the banner without touching presentation.

Rationale for keeping it in the composable rather than the component: the debounce is connection semantics, not presentation. Putting it in `useSocket` keeps it unit-testable in the node env with the existing mock-socket harness (no DOM mount), matches the LLD 162 pattern of driving all connection logic from the composable, and means both Big2 and Tonk boards plus spectators inherit the fix with zero per-view wiring.

## Interfaces / Types

The public `UseSocketReturn` surface is **unchanged** — `connectionState`, `connected`, `reconnectAttempt`, `terminalError`, `connect`, `disconnect` keep their existing signatures. All changes are internal to `useSocket()`.

### New module constant (`useSocket.ts`)
```ts
/** Grace window before a transient disconnect surfaces the reconnecting banner. */
export const RECONNECTING_GRACE_MS = 1750;
```

### Internal timer + helpers (inside `useSocket()`)
```ts
// One pending grace-timer handle per useSocket() instance.
let _graceTimer: ReturnType<typeof setTimeout> | null = null;

function _clearGraceTimer(): void {
  if (_graceTimer !== null) {
    clearTimeout(_graceTimer);
    _graceTimer = null;
  }
}

// Debounced entry into "reconnecting". Collapses repeated calls into one
// pending transition. Does nothing if the timer is already pending.
function _scheduleReconnecting(): void {
  if (_graceTimer !== null) return; // already pending — don't restart the clock
  _graceTimer = setTimeout(() => {
    _graceTimer = null;
    // Guard: only surface reconnecting if we are still disconnected and not terminal.
    if (!connected.value && !_reconnectFailed) {
      connectionState.value = "reconnecting";
    }
  }, RECONNECTING_GRACE_MS);
}
```
> Note the `_scheduleReconnecting` early-return: unlike a "restart on every call" debounce, we deliberately keep the **first** scheduled deadline. Otherwise each `reconnect_attempt` (fired repeatedly during a long outage) would keep pushing the deadline out and the banner would never appear for a genuine multi-attempt drop. The timer-fire guard re-checks live state so a `connect`/`terminal` that raced the callback still wins.

### Revised event wiring (only the changed handlers shown)
```ts
s.on("connect", () => {
  connected.value = true;
  _reconnectFailed = false;
  reconnectAttempt.value = 0;
  _clearGraceTimer();          // NEW: cancel any pending "reconnecting"
  _updateConnectionState();    // → "connected", immediate (never debounced)
});

s.on("disconnect", (reason) => {
  connected.value = false;
  const cls = classifyDisconnect(reason as string);
  if (cls === "ignore") return;              // teardown — leave state, no timer
  if (cls === "terminal") {
    _clearGraceTimer();                       // NEW: terminal is immediate
    _reconnectFailed = false;
    connectionState.value = "terminal";
    return;
  }
  _scheduleReconnecting();                     // CHANGED: was immediate assignment
});

s.io.on("reconnect_attempt", (attempt: number) => {
  reconnectAttempt.value = attempt;           // synchronous (not yet visible)
  _scheduleReconnecting();                     // CHANGED: was immediate assignment
});

s.io.on("reconnect_failed", () => {
  _clearGraceTimer();                          // NEW: terminal is immediate
  _reconnectFailed = true;
  connectionState.value = "terminal";
});
```

### `connect()` reset + `disconnect()` teardown
```ts
async function connect(): Promise<void> {
  if (socket.value) return;
  _clearGraceTimer();          // NEW: no stale pending transition from a prior socket
  // ... existing ref resets ...
}

function disconnect(): void {
  _clearGraceTimer();          // NEW: don't fire after teardown
  socket.value?.disconnect();
  socket.value = null;
  connected.value = false;
}
```

### Transport config change
```ts
const s = io(import.meta.env.VITE_API_BASE_URL || "", {
  auth: { token },
  transports: ["websocket", "polling"],   // CHANGED: added polling fallback
  reconnection: true,
  reconnectionAttempts: MAX_RECONNECT_ATTEMPTS,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});
```

## State Model

All state remains **in-memory / ephemeral client state**. No new persisted state, no new server state, no change to the tri-state model itself. The only new state is one closure-scoped timer handle.

| State | Owner | Lifetime | Notes |
|---|---|---|---|
| `_graceTimer` | `useSocket` (closure) | per pending transition | Non-null only while a `reconnecting` transition is pending; cleared on connect, terminal, `connect()` reset, and `disconnect()`. At most one live at a time. |
| `connectionState` | `useSocket` | per socket | Same tri-state as LLD 162. Difference: the `connected → reconnecting` edge is now delayed by `RECONNECTING_GRACE_MS`; the `→ connected` and `→ terminal` edges remain immediate. |
| `reconnectAttempt` | `useSocket` | per reconnection cycle | Updated synchronously on `reconnect_attempt` (unchanged); simply not visible until the banner surfaces. |
| `connected`, `terminalError`, `_reconnectFailed` | `useSocket` | per socket | Unchanged from LLD 162. |

**Transition timelines:**

- **Transient blip (<1.75s) — the fix.** live board → `disconnect("transport close")` → `_scheduleReconnecting()` arms the timer, `connectionState` stays `"connected"` → (optionally `reconnect_attempt` bumps `reconnectAttempt`, timer already pending, no restart) → `connect` fires at ~1s → `_clearGraceTimer()` + `connectionState = "connected"`. **The timer never fired; the banner never rendered; the board was never dimmed.** Gameplay uninterrupted.
- **Genuine drop (>1.75s).** live board → `disconnect` → timer armed → 1.75s elapses with no `connect` → callback sets `connectionState = "reconnecting"` → banner shows, board dims, buttons lock (exactly as LLD 162) → eventual `connect` → banner clears; or `reconnect_failed`/`io server disconnect` → `terminal`.
- **Terminal (immediate).** `reconnect_failed` or `"io server disconnect"` → `_clearGraceTimer()` + `connectionState = "terminal"` synchronously, regardless of any pending grace timer. Red "Reload to rejoin" appears promptly.

## Edge Cases

- **E1 — Transient blip that recovers within the grace window.** `disconnect(retry)` arms the timer; `connect` fires before `RECONNECTING_GRACE_MS`; `_clearGraceTimer()` cancels the pending transition. No banner, no dim. **(Primary acceptance criterion.)**
- **E2 — Genuine drop exceeding the grace window.** No `connect` within 1.75s; the timer callback surfaces `reconnecting`; banner + board-dim + `disabledReason` behave exactly as LLD 162. **(Preserves current behavior for real drops.)**
- **E3 — Rapid flap (drop → reconnect → drop → reconnect).** Each `disconnect(retry)` may arm a timer; each `connect` clears it. Because `_scheduleReconnecting` no-ops when a timer is already pending, and `connect`/terminal always clear, **at most one timer is ever live** — no leaks, no duplicate transitions, no double-fire.
- **E4 — `reconnect_attempt` storm during a long outage.** First `disconnect`/`reconnect_attempt` arms the timer; subsequent `reconnect_attempt`s no-op on scheduling (deadline preserved) but keep updating `reconnectAttempt`. After 1.75s the banner shows with the current attempt count. The deadline is never pushed out, so a multi-attempt genuine drop still surfaces promptly.
- **E5 — Terminal arrives while a grace timer is pending.** `reconnect_failed` or `"io server disconnect"` clears the pending timer and sets `terminal` immediately, so a queued `reconnecting` can never overwrite `terminal` a beat later. **(Guards a flap-to-terminal race.)**
- **E6 — Grace timer fires after a `connect` already landed (callback race).** The timer callback re-checks `!connected.value && !_reconnectFailed` before writing `reconnecting`, so a callback already queued when `connect` cleared the flag is a no-op. (Belt-and-braces; `_clearGraceTimer` on `connect` normally prevents the callback from being reached at all.)
- **E7 — Unmount / manual disconnect with a pending timer.** `disconnect()` calls `_clearGraceTimer()` so no `reconnecting` fires after teardown; `onUnmounted → disconnect()` is safe. A subsequent `connect()` also clears at the top, guaranteeing a clean start.
- **E8 — `"io client disconnect"` (our own teardown mid-session).** `classifyDisconnect` returns `ignore`; handler returns early without arming a timer — unchanged.
- **E9 — Polling fallback engaged.** If WebSocket is unavailable, Socket.IO uses polling and continues to emit the same `connect`/`disconnect`/reconnect events, so the debounce logic is transport-agnostic. Fewer spurious `transport close` events reach the debounce in the first place.
- **E10 — Reduced motion / spectators / Tonk vs Big2.** No change from LLD 162; the banner and dimming are gated purely on `connectionState`, whose *values* are unchanged.

## Dependencies

**Must exist (all already present, shipped in LLD 162):**
- `useSocket.ts` — the only file edited. `socket.io-client` v4 Manager events and `transports` option are standard API; no new dependency.
- `connectionState.ts` (`classifyDisconnect`, `deriveConnectionState`) — consumed unchanged.
- `ConnectionBanner.vue`, `GameView.vue` (`--disconnected` modifier, `disabledReason`) — consumed unchanged; no edits.
- The existing test harness: `tests/frontend/useSocket.test.ts` (mock socket with `__emit`/`__emitIo`) and `tests/frontend/connectionState.test.ts`.

**No dependency on:** backend, schema/migrations, socket-event contract, or any other LLD. Fully independent, frontend-only.

**Blocking:** none.

## Test Requirements

Extend the existing `tests/frontend/useSocket.test.ts` (and the ref-mirrored simulation in `connectionState.test.ts` if convenient) using **Vitest fake timers** (`vi.useFakeTimers()` / `vi.advanceTimersByTime()`). Node env, no DOM mount — matching the current pattern.

### Unit — grace-window debounce (extend `useSocket.test.ts`)
- **No banner for a sub-window blip (primary AC):** `connect` → `disconnect("transport close")` → advance timers by <1750ms → `connect` again → assert `connectionState` was **never** `"reconnecting"` (observe via a `watch`/collected array) and ends `"connected"`.
- **Genuine drop surfaces after the window:** `connect` → `disconnect("transport close")` → `vi.advanceTimersByTime(1750)` → assert `connectionState === "reconnecting"`.
- **Recovery is immediate, not debounced:** once `reconnecting` is showing, a `connect` sets `"connected"` synchronously (no timer advance needed).
- **`reconnect_attempt` before the window also debounces:** `disconnect` → `reconnect_attempt(1)` (advance <1750ms total) → `connect` → assert never `"reconnecting"`; `reconnectAttempt` still updated to 1 during the gap.
- **Deadline not pushed out by repeated attempts (E4):** `disconnect` then several `reconnect_attempt`s spread over >1750ms total → assert banner surfaces at ~1750ms from the first event, not reset by later attempts.

### Unit — terminal & teardown are not debounced
- **`reconnect_failed` is immediate (E5):** `disconnect("transport close")` (timer armed) → `reconnect_failed` before 1750ms → assert `connectionState === "terminal"` synchronously and that advancing timers past 1750ms does **not** flip it to `"reconnecting"`.
- **`"io server disconnect"` is immediate:** assert `terminal` synchronously with no timer advance.
- **Callback race guard (E6):** arm the timer, fire `connect` (clears it), advance timers → assert stays `"connected"` (no late `reconnecting`).
- **Teardown clears the timer (E7):** `disconnect("transport close")` → call `disconnect()` (manual) → advance timers → assert no `"reconnecting"` was surfaced.
- **`connect()` reset clears a stale timer:** arm timer, then a fresh `connect()`/disconnect cycle starts clean.

### Regression (must still pass, unchanged from LLD 162)
- `SERVER_FULL` → `terminalError` + `disconnect()`.
- Transient `connect_error` does not set `terminalError`.
- `classifyDisconnect` / `deriveConnectionState` mapping tests in `connectionState.test.ts`.
- Note: the existing `useSocket.test.ts` assertions that expect `"reconnecting"` **synchronously** after a `disconnect` must be updated to advance fake timers by `RECONNECTING_GRACE_MS` first — this is the intended behavior change.

### Not tested (per testing-principles §"Don't test framework behavior")
- That Socket.IO actually falls back to polling or emits reconnect events — library behavior. We test our debounce mapping of those events.
- Exact banner CSS / pulse animation — unchanged from LLD 162.

### Manual verification (acceptance criterion)
- Simulate a brief network blip (e.g. DevTools offline toggle or kill the WebSocket for <1s) during an active game and confirm **no banner appears** and gameplay is uninterrupted; then a >2s outage confirms the banner still appears promptly and the board disables.
