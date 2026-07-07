# LLD 160: Background "Your Turn" Alert — Tab-Title Flash, Favicon Badge, Optional Chime, Opt-in Web Notification

## Scope

**In scope (pure client-side):**
- A new composable `useTurnAlert.ts` that, when it becomes the local player's turn **and** the tab is hidden, drives four background attention effects: (1) flash `document.title`, (2) swap in a badged favicon, (3) play one optional chime, (4) fire one opt-in Web Notification.
- Immediate teardown of every effect on `visibilitychange` back to visible (and on window `focus`).
- One persisted `localStorage` setting ("Turn sound") governing the chime, default **on**, plus a minimal toggle control folded into an existing in-game surface.
- Opt-in Notification permission: `Notification.requestPermission()` is called **only** in direct response to an explicit user action, never on page load.
- Audio unlock on the first in-game user gesture (card tap / Play / Discard / Draw) to satisfy browser autoplay policy.
- Wiring into both `GameBoard.vue` (Big2) and `TonkBoard.vue` (Tonk) via their existing `isMyTurn` computed.
- Feature-detection of each primitive (`Audio`, `Notification`, favicon swap, `document.hidden`) so any one being unavailable degrades cleanly.

**Explicitly NOT in scope:**
- Any backend, schema, socket-event, or infra change. This LLD introduces none.
- Alerts for **spectators** — this is a player-turn affordance only (CEO decision 3).
- On-screen turn indication or the visible per-player countdown (backlog #27, LLD 7a / `TurnTimer.vue`) — those already exist and are unchanged.
- Push notifications / service workers / mobile background wake — this only fires while the page is alive but the tab is hidden.
- Vibration (`navigator.vibrate`), sound on every turn while focused, or per-opponent alerts.
- Changing the favicon assets referenced from `index.html` (served from the `danbing.app` CDN); the badged favicon is generated client-side (see Approach).

## Approach

### Single composable, injected browser deps
Follow the established composable pattern (`useTurnCountdown`, `useFeedbackAttachments`): a `useTurnAlert(...)` factory that owns lifecycle via `onScopeDispose`. Because project frontend tests run in the **node** environment with no jsdom (see `tests/frontend/*`), all browser primitives are accessed through an injectable `deps` object with real-browser defaults. Tests pass fakes; production passes nothing and gets the real `window`/`document`/`Notification`/`Audio`.

### Trigger condition
The alert **arms and fires** only when all of the following hold on a transition:
1. `isMyTurn` transitions `false → true` (watch the boolean; do not re-fire while it stays true).
2. `document.hidden === true` at the moment of the transition (CEO decision 5: if the tab is already focused at turn start, fire nothing).
3. The local viewer is a **player**, not a spectator (CEO decision 3). Note that `GameBoard`/`TonkBoard` **do** render for spectators (with `myPlayerIndex === -1` — see `TonkBoard.vue` lines 206–210 and `GameView.vue` line 299), so the composable **is** instantiated for a spectator. The primary protection is that `isMyTurn` (`currentPlayerIndex === myPlayerIndex`) can never be `true` when `myPlayerIndex === -1`, so the `false → true` edge never occurs and `arm()` never fires for a spectator. As explicit defense in depth the composable also accepts an `enabled` ref, which the boards bind to a "is a seated player" computed (`myPlayerIndex >= 0`); `arm()` bails when `enabled` is false.

If the turn flips while hidden and the user later returns, effects clear. If `isMyTurn` becomes true while **visible**, we record no armed state and fire nothing.

### The four effects
1. **Title flash** — save the original `document.title` once, then `setInterval` (gentle cadence, **1200 ms** toggle) alternating between the original and `● Your turn — <GameLabel>` (e.g. `● Your turn — Big2`). Cleared by restoring the saved title and clearing the interval. When `prefers-reduced-motion: reduce` is set, do not flash/animate — instead set the attention title **once, statically** (still informative, no motion). The preference is read **live at each `arm()`** via `window.matchMedia("(prefers-reduced-motion: reduce)").matches` (not cached at init), so an OS setting change mid-session is honored on the next armed turn.
2. **Favicon badge** — canvas-generated to avoid shipping/committing new binary assets and to sidestep cross-origin canvas taint from the CDN favicon. On arm: create (or reuse) a `<link rel="icon">` element, draw a 32×32 canvas (solid rounded-rect background in the app gold `#c9a84c` + a contrasting dot), and set the link `href` to the canvas `toDataURL()`. On clear: restore the original favicon by removing the injected link (or resetting its href to the saved original). Feature-detect `canvas.getContext("2d")`; if unavailable, skip silently.
3. **Chime** — a single short soft tone. Generated at runtime via `AudioContext` (oscillator + short gain envelope, ~150 ms) rather than shipping an audio file — no new asset to commit, no decode/network dependency, and it respects the unlock gesture cleanly. Gated by the persisted `turnSound` setting (default on) AND `document.hidden`. Played exactly once per arm. Feature-detect `AudioContext`/`webkitAudioContext`; absent → skip.
4. **Web Notification** — only if `Notification` exists and `Notification.permission === "granted"`. Construct `new Notification("Your turn — <GameLabel>", { tag: "turn-alert", ... })`. Store the handle so it can be `.close()`d on clear. Never call `requestPermission()` here — permission is requested only from the explicit user toggle (see Frontend Design). If permission is `default` or `denied`, silently skip; never throw.

### Autoplay unlock
Browsers block `AudioContext` until a user gesture. The composable exposes `unlockAudio()`, which the boards call on the first in-game pointer/click gesture (card tap, Play, Pass, Discard, Draw). `unlockAudio()` lazily creates the `AudioContext` and, if its state is `suspended`, calls `resume()`. It is idempotent. If the first turn arrives before any gesture (rare: you tabbed away instantly in the lobby), the chime silently no-ops for that one turn — title/favicon/notification still fire.

### Clear-on-focus
A single `visibilitychange` listener (plus `focus` as a belt-and-suspenders for browsers that fire focus without a hidden→visible transition) calls `clear()` whenever `document.hidden` becomes false. `clear()` restores the title, restores the favicon, closes any live Notification, and disarms. Chime does not need clearing (it is a one-shot). This is the mechanism behind the "resets immediately on return" acceptance criterion.

### Why generate assets at runtime (favicon + chime)
Aligns with "deploy cheap" and avoids committing binaries: the favicon CDN is cross-origin (drawing it to canvas would taint it), and an audio file adds a network/asset dependency and licensing concern. A canvas badge and a WebAudio tone are a few lines each, fully feature-detected, and independently degradable.

## Frontend Design

**Approved direction: Option A — fold a minimal control into an existing in-game surface; chime default ON; Notification permission requested only on explicit user action.**

### Toggle placement (Option A)
There is no dedicated settings panel in-game today; the only in-game overlay surface is `DevOverlay.vue` (debug-only). Rather than invent a heavyweight settings panel, add a single lightweight control to an existing always-present in-game affordance. The chosen host is the top-of-board control cluster that already carries `RoomCodeChip` (rendered in both `GameBoard.vue` and `TonkBoard.vue`) — a small icon-button "sound" toggle placed adjacent to the room-code chip. This keeps it discoverable, on both boards, and requires no new panel.

The control is a single switch labeled **"Turn sound"**:
- **On (default):** filled speaker icon, gold accent (`--gold-accent`). Tooltip/`aria-label`: "Turn sound on".
- **Off:** muted speaker icon, muted color. `aria-label`: "Turn sound off".
- Tapping toggles the persisted `turnSound` boolean immediately; no confirmation.

This feature adds **two** visible in-game controls (the "Turn sound" toggle and the conditional "Enable turn notifications" button), both new to the board header cluster. Per CLAUDE.md — "for any LLD that changes visual UI, the `frontend-architect` must produce HTML mockups (served on port 8090) for user review **before** the LLD is finalized" — this is **not** downgradable to an at-implementation option. A `frontend-architect` mockup of the header cluster (Turn sound toggle in its on/off states plus the conditional notification opt-in button) **must** be produced and approved before this LLD is treated as final and handed to the implementer. The placement described here (adjacent to `RoomCodeChip`) is the proposed direction the mockup should render for approval, not a substitute for it.

### Chime default: ON (CEO decision 1)
`turnSound` defaults to **true** — the whole point is to catch a player who has tabbed away. The mute choice persists in `localStorage` under key `cgs.turnSound` (`"true"`/`"false"`); an absent/invalid value reads as `true`. Honored on the next game/reload.

### Notification permission: opt-in on action (CEO decision 2)
- **Never** call `Notification.requestPermission()` on page load or on mount.
- The notification opt-in is a **single, dedicated, keyboard-activatable `<button>`** — an inline "Enable turn notifications" button — rendered adjacent to the "Turn sound" toggle **only** when `Notification.permission === "default"` (i.e. never asked yet). Clicking (or activating via keyboard) it calls `requestNotificationPermission()`, which is a direct response to that gesture. There is **no** long-press and **no** context menu — those are not keyboard-accessible and are poorly discoverable, contradicting the Accessibility section; they are explicitly dropped.
- Once permission is decided (`granted` or `denied`), the opt-in button is no longer rendered (`v-if="notificationPermission === 'default'"`), so the player is never re-prompted and there is no dangling control.
- If the user grants: subsequent background turns fire a Web Notification. If denied or dismissed: we never ask again automatically and never throw; title/favicon/chime still work.
- We store no permission state ourselves — `Notification.permission` is the single source of truth, read live at fire time.

### Accessibility
- Title flash cadence is gentle (1200 ms). Under `prefers-reduced-motion: reduce`, the title is set **once, statically** (no interval), the favicon badge is still swapped (a static state change, not motion), and no CSS animation is added to the toggle.
- The toggle is a real `<button>` with `aria-pressed` reflecting on/off and an `aria-label`; keyboard-activatable.
- Each primitive degrades independently: missing `Audio` → no chime but title/favicon/notification still fire; missing `Notification` → no desktop alert but the rest fire; missing canvas → no favicon badge but title/chime/notification still fire.

## Interfaces / Types

### `useTurnAlert.ts`

```ts
import type { Ref } from "vue";

export interface TurnAlertDeps {
  /** Defaults to real browser globals; overridden in tests. */
  getDocument?: () => Document;
  getWindow?: () => Window;
  /** () => Notification constructor or undefined if unsupported. */
  getNotification?: () => typeof Notification | undefined;
  /** Factory for an AudioContext, or undefined if unsupported. */
  createAudioContext?: () => AudioContext | undefined;
  /** localStorage-like store; defaults to window.localStorage. */
  storage?: Pick<Storage, "getItem" | "setItem">;
}

export interface UseTurnAlertOptions {
  /** True on the local player's turn (existing board computed). */
  isMyTurn: Ref<boolean>;
  /** Human label for the running game, e.g. "Big2" / "Tonk". */
  gameLabel: Ref<string> | string;
  /**
   * Gate: only players get alerts. Boards pass a ref that is false for
   * spectator/non-interactive contexts. Defaults to true.
   */
  enabled?: Ref<boolean>;
  deps?: TurnAlertDeps;
}

export interface UseTurnAlertReturn {
  /** Persisted chime setting; default true. Writing it updates localStorage. */
  turnSoundEnabled: Ref<boolean>;
  /** Live view of Notification.permission ("default" | "granted" | "denied" | "unsupported"). */
  notificationPermission: Ref<NotificationPermission | "unsupported">;
  /** Toggle the chime setting (persists). */
  toggleTurnSound(): void;
  /**
   * Request Notification permission. MUST be called only from a direct user
   * gesture. Resolves to the resulting permission; never throws. No-op if
   * unsupported or already decided.
   */
  requestNotificationPermission(): Promise<NotificationPermission | "unsupported">;
  /** Unlock/resume the AudioContext. Call from the first in-game gesture. Idempotent. */
  unlockAudio(): void;
}

export const TURN_SOUND_STORAGE_KEY = "cgs.turnSound";
export const TITLE_FLASH_INTERVAL_MS = 1200;

export function useTurnAlert(opts: UseTurnAlertOptions): UseTurnAlertReturn;
```

### Internal helpers (not exported, but specified for implementation)
- `arm()` — precondition-checked entry point run when `isMyTurn` goes true. Returns early unless `enabled && document.hidden`. Fires the four effects (each individually feature-gated).
- `clear()` — restore title, restore favicon, `close()` any live notification, clear the flash interval, reset `armed = false`.
- `flashTitle(label)` / `restoreTitle()`.
- `showFaviconBadge()` / `restoreFavicon()`.
- `playChime()` — no-op unless `turnSoundEnabled && document.hidden && audioUnlocked`.
- `fireNotification(label)` — no-op unless supported and permission `granted`.

### Board wiring (both `GameBoard.vue` and `TonkBoard.vue`)
Both boards already expose `const isMyTurn = computed(...)` and know their game type. In `<script setup>`:

```ts
// `enabled` is the seated-player gate (spectators have myPlayerIndex === -1).
const isSeatedPlayer = computed(() => myPlayerIndex.value >= 0);

const { turnSoundEnabled, notificationPermission, toggleTurnSound,
        requestNotificationPermission, unlockAudio } = useTurnAlert({
  isMyTurn,
  enabled: isSeatedPlayer,
  gameLabel: props.gameState.gameType === "tonk" ? "Tonk" : "Big2",
});
```

**`unlockAudio()` call sites (concrete handlers):**
- `GameBoard.vue` — call `unlockAudio()` at the top of `toggleCard(index)` (line 177), `onPlay()` (line 181), and `onPass()` (line 185). These are the only user-initiated in-game gestures on the Big2 board; `toggleCard` fires on the very first card tap, which is the earliest reliable unlock point.
- `TonkBoard.vue` — the board delegates actions to child components via emits. Attach `unlockAudio()` in the existing emit forwarders: the `@toggle` handler (`(index) => { unlockAudio(); emit('toggleCard', index); }`, line 60), and the `@discard` (line 113) and `@draw` (line 114) handlers. `@toggle` (card tap in `TonkHand`) is the earliest unlock point.

The "Turn sound" toggle button lives in the same header cluster as `RoomCodeChip` and binds `aria-pressed="turnSoundEnabled"`, `@click="toggleTurnSound"`. The notification opt-in button (rendered only when `notificationPermission === 'default'`, `v-if`) calls `requestNotificationPermission()` on `@click`.

## State Model

All state is **client-side and ephemeral** except the one persisted setting. No server round-trips, no reactive game-state mutation.

**Persisted (`localStorage`):**
- `cgs.turnSound` → `"true"` | `"false"`. Read on composable init (default `true` if absent/invalid). Written on every `toggleTurnSound()`.

**In-memory (per composable instance, non-reactive unless noted):**
- `armed: boolean` — whether alert effects are currently active (title flashing / favicon badged / notification open). Prevents double-arming and drives `clear()`.
- `savedTitle: string | null` — the original `document.title`, captured once at first arm, restored on clear.
- `flashIntervalId` — handle for the title-flash interval; cleared on `clear()` and on scope dispose.
- `injectedFaviconLink` / `savedFaviconHref` — references used to restore the favicon.
- `audioCtx: AudioContext | null` + `audioUnlocked: boolean` — lazily created on `unlockAudio()`.
- `activeNotification: Notification | null` — closed on clear.

**Reactive (exposed refs):**
- `turnSoundEnabled: Ref<boolean>` — mirrors the persisted setting.
- `notificationPermission` — initialized from `Notification.permission` (or `"unsupported"`), refreshed after `requestNotificationPermission()`.

**Flow:**
1. Init: read `turnSound` from storage; snapshot notification permission; attach `visibilitychange` + `focus` listeners.
2. `watch(isMyTurn)`: on `false → true`, call `arm()`; `arm()` bails unless `enabled.value && document.hidden`.
3. `arm()` (when hidden): set `armed = true`; start title flash; swap favicon; `playChime()` (if enabled + unlocked); `fireNotification()` (if granted).
4. Tab returns → `visibilitychange`/`focus` handler sees `!document.hidden` → `clear()`.
5. `onScopeDispose`: `clear()` and remove listeners.

Note: if `isMyTurn` is still `true` when the tab regains focus and then the tab is hidden again *without* the turn changing, no re-arm occurs (we only arm on the `false → true` edge). This is intentional — one alert per turn.

## Edge Cases

| # | Case | Handling |
|---|------|----------|
| E1 | Turn flips while tab is **focused** | `arm()` bails (`document.hidden` false). No title flash, no chime, no favicon swap, no notification. (AC.) |
| E2 | Tab regains focus mid-alert | `visibilitychange`/`focus` → `clear()` restores title + favicon, closes notification, stops interval — immediately. (AC.) |
| E3 | `isMyTurn` true → false while still hidden (e.g. auto-pass fired before return) | On the next return, `clear()` runs anyway (idempotent). Effects stop. No stale flashing after the turn passed — also add a `watch` clause: if `isMyTurn` goes `true → false` while armed, `clear()`. |
| E4 | Chime setting OFF | `playChime()` no-ops; title/favicon/notification unaffected. (AC.) |
| E5 | First background turn arrives before any user gesture (audio not unlocked) | Chime silently skipped for that turn; title/favicon/notification still fire. No error. |
| E6 | `Notification` unsupported (older browser) | `getNotification()` returns undefined; `notificationPermission = "unsupported"`; fire + request are no-ops; no throw. (AC.) |
| E7 | Notification permission `denied` or `default` | `fireNotification()` no-ops; we never auto-prompt. Only an explicit user action requests. No throw. (AC.) |
| E8 | Canvas / `getContext("2d")` unavailable | Favicon badge skipped; other effects unaffected. |
| E9 | `AudioContext` suspended after unlock (browser re-suspends backgrounded contexts) | `playChime()` attempts `resume()` best-effort; if still not running, skip without throwing. |
| E10 | Rapid turn cycling (my turn → opponent → my turn while hidden) | Each `false → true` edge re-arms cleanly: `clear()` is called at the start of `arm()` to reset any prior state, so title/favicon/notification refresh; chime plays again (one per arm). |
| E11 | `prefers-reduced-motion: reduce` | Title set once statically (no interval); favicon badge still applied (static); no animation. (AC.) |
| E12 | `localStorage` unavailable / throws (private mode, quota) | Reads default to `true`; writes wrapped in try/catch and swallowed; setting simply won't persist. No throw. |
| E13 | Component unmounts (navigate away / rematch) while armed | `onScopeDispose` → `clear()` + remove listeners; title/favicon restored so the next route starts clean. |
| E14 | Spectator context | The composable **is** mounted for spectators (boards render with `myPlayerIndex === -1`), but `isMyTurn` can never be `true` for a spectator, so the `false → true` edge never occurs and `arm()` never runs. `enabled` (bound to `myPlayerIndex >= 0`) is `false` and makes `arm()` bail as explicit defense in depth. (CEO decision 3.) |
| E15 | Multiple game tabs open | Each tab runs its own composable independently; the setting is shared via `localStorage` but effects are per-tab (only the hidden tab whose turn it is flashes). Acceptable. |
| E16 | Two boards mount briefly during transition | Only one board is rendered per phase (`GameView` v-if). If overlap ever occurred, both would restore the same `savedTitle` — idempotent restore keeps it correct. |
| E17 | Notification still open when tab refocuses | `clear()` calls `activeNotification.close()`. |

## Dependencies

**Existing code this builds on (no changes required to their contracts):**
- `src/frontend/component/game/GameBoard.vue` — exposes `isMyTurn` (computed, line ~152) and game type; hosts the toggle in its header cluster; calls `unlockAudio()` from its action handlers.
- `src/frontend/component/game/TonkBoard.vue` — exposes `isMyTurn` (computed, line ~209); same wiring.
- `src/frontend/component/game-ui/RoomCodeChip.vue` — the "Turn sound" toggle sits in the same header cluster as this chip.
- Composable/testing conventions from `useTurnCountdown.ts` (scope-disposed timers) and `useFeedbackAttachments.ts` (injected browser deps for node-env tests).

**Platform APIs (all feature-detected):** `document.hidden` / `visibilitychange`, `document.title`, `<link rel="icon">` + Canvas 2D, `AudioContext` / `webkitAudioContext`, `Notification`, `window.localStorage`, `window.matchMedia("(prefers-reduced-motion: reduce)")`.

**No dependency on:** any backend endpoint, socket event, migration, or new npm package. Vitest 4 + Vue reactivity (already present).

**Must exist before implementation:** nothing new — all prerequisites are in the current tree.

## Test Requirements

All tests are **unit tests** for `useTurnAlert.ts`, in `tests/frontend/useTurnAlert.test.ts`, run in the node environment with injected fakes (matching `useFeedbackAttachments.test.ts` style). Wrap composable creation in `effectScope()` (per `useTurnCountdown.test.ts`) and stop it per test. Use `vi.useFakeTimers()` for the title-flash interval. No backend or integration tests (per selection).

Provide a `makeDeps()` helper returning fakes: a fake `document` (`{ hidden, title, querySelector, createElement, addEventListener, removeEventListener }`), a fake `window`, a fake `Notification` constructor (with settable static `permission` and a spy `requestPermission`), a fake `createAudioContext` returning an object with `state`, `resume`, `createOscillator`, `createGain`, `destination`, and an in-memory `storage`.

**Arming / trigger:**
- Title flips to the attention string when `isMyTurn` goes true **and** `document.hidden` is true. Advancing fake timers by `TITLE_FLASH_INTERVAL_MS` alternates title back to the original.
- No-op when `isMyTurn` goes true while `document.hidden` is false: title unchanged, no favicon link injected, chime factory not invoked, Notification constructor not called.
- No arm when `enabled` ref is false (spectator defense) even if hidden.
- Arms only on the `false → true` edge (staying true does not re-fire; going false-then-true re-fires).

**Clear / reset:**
- On `visibilitychange` with `document.hidden` false, title is restored to the original, the injected favicon link href is restored/removed, the interval is cleared, and a live notification's `close()` is called.
- `true → false` on `isMyTurn` while armed and still hidden triggers `clear()` (E3).
- `onScopeDispose` restores title/favicon and removes listeners (assert `removeEventListener` called).

**Chime setting:**
- Default `turnSoundEnabled` is `true` when storage is empty; `false`/`true` string honored when present.
- `toggleTurnSound()` flips the ref and writes the new value to storage.
- With setting enabled + hidden + audio unlocked, `arm()` invokes the oscillator path once; with setting disabled, it does not; with setting enabled but audio **not** unlocked, chime skipped but title still flashes (E5).
- `localStorage.setItem` throwing does not propagate (E12).

**Notification:**
- With `Notification.permission === "granted"` and hidden turn, the constructor is called once with a title containing the game label; `requestPermission` is **not** called during `arm()`.
- With permission `default` or `denied`, constructor not called, no throw (E7).
- When `getNotification()` returns undefined, `notificationPermission` is `"unsupported"`, and `arm()` + `requestNotificationPermission()` are no-ops that do not throw (E6).
- `requestNotificationPermission()` calls the fake `requestPermission` exactly once and updates `notificationPermission` from its resolved value; never called on init/mount.

**Accessibility / degradation:**
- With `prefers-reduced-motion` matching, the title is set once and **no** interval is started (assert no timer scheduled); favicon still swapped.
- With canvas `getContext` returning null, no favicon href is set but title/chime/notification paths still run (E8).

**Manual QA (visual only, not automatable here):** favicon actually renders a visible badge in a real browser tab strip; the chime is audibly soft; desktop notification appears with correct copy. These are the only manual checks; everything logic-level is covered by the unit tests above.
