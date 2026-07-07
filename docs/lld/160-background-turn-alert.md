# LLD 160: Background "Your Turn" Alert — Tab-Title Flash, Favicon Badge, Optional Chime, Opt-in Web Notification

## Scope

**Covers:** A pure client-side alert that fires when it becomes the local player's turn **while the browser tab is hidden**. Four effects:

1. **Tab-title flash** — `document.title` alternates between the captured normal title and `● Your turn — <Game>` on a gentle interval.
2. **Favicon badge** — a badged favicon data-URI replaces the current one.
3. **Optional chime** — one short Web Audio tone, gated behind a `localStorage` toggle (default **on**), only when the tab is hidden, only if the `AudioContext` has been unlocked by a prior in-game gesture.
4. **Web Notification** — fired only if the user has already **granted** permission. Permission is requested **only** on an explicit user action (the "Enable" button in the settings popover) — never on page load or game start.

A new composable `useTurnAlert.ts` owns all of this, driven off the board's existing `isMyTurn` + `document.hidden`/`visibilitychange`. A new `TurnAlertMenu.vue` (Direction A: gear popover in the board's top rail) hosts the sound toggle and the notification opt-in. Both `GameBoard.vue` (Big2) and `TonkBoard.vue` wire it in.

**Does NOT cover:** Any backend, schema, socket-event, or infra change (none introduced). Server-side push/web-push. `navigator.vibrate`. Spectator alerts (players only). Mobile-specific alert behavior beyond graceful degradation. New timer logic — this reads the existing `isMyTurn`/`turnDeadline` the board already holds. Changing the on-screen turn indicator (LLD 7a / backlog #27 remain the on-screen path).

## Approach

**Single derived trigger.** The whole feature reduces to one boolean:
`shouldAlert = isPlayer && isMyTurn && document.hidden`.
Watch it and act on its edges:

- **rising edge (false→true)** → `armAlert()` (start flash, badge favicon, chime if enabled+unlocked, notification if granted).
- **falling edge (true→false)** → `clearAlert()` (stop flash, restore title + favicon, close pending notification).

This single-signal model cleanly satisfies every acceptance case without special-casing:

- Turn arrives while hidden → rising edge → fires.
- Tab is hidden while it is already my turn → rising edge → fires (covers "left again while still my turn").
- Tab regains focus → falling edge → clears immediately (`visibilitychange` flips `document.hidden`).
- Turn passes away while I'm still hidden (e.g. server auto-pass at deadline) → falling edge → clears.
- Turn becomes mine while the tab is **focused** → `document.hidden` is false → signal never rises → **nothing fires**.
- Spectator → `isPlayer` false → signal never rises.

**Why a composable, not inline board code.** Both boards need identical behavior; a composable keeps the boards thin and makes the logic unit-testable in isolation (project convention — see `useTurnCountdown.ts`). It cleans up via `onScopeDispose`.

**Favicon strategy — pre-baked SVG data-URI pair (recommended).** A pure helper `buildFaviconDataUri(badged: boolean)` returns an inline SVG (green rounded rect + gold `♠` glyph, matching the approved mockup; badged variant adds a gold dot top-right). The composable manages a single `<link rel="icon">`: it captures the current href on arm and restores it on clear.
- _Alternative — canvas-generate a badge over the live favicon._ Rejected as the default: the production favicons are cross-origin raster PNGs on `danbing.app`; drawing them to a canvas taints it and `toDataURL()` throws. The pre-baked SVG pair has no CORS dependency, is deterministic, and is trivially testable. If exact-icon fidelity is later required, swap the helper's SVG for a same-origin asset — no other change.

**Chime — Web Audio, unlocked on first in-game gesture.** Browsers block audio until a user gesture. The composable exposes `unlockAudio()`, which lazily creates and `resume()`s a shared `AudioContext`. Boards call it from the first in-game interaction (card tap / Play / Pass / Discard / Draw / Call Tonk), so a later backgrounded chime can actually sound. `playChime()` plays two soft sine notes (~880Hz then ~1175Hz, short exponential decay — mockup values). All audio calls are wrapped so an unavailable/suspended context degrades silently.

**Notification — granted-only, opt-in request.** The composable never calls `Notification.requestPermission()` implicitly. `requestNotificationPermission()` is invoked only by the "Enable" button. `armAlert()` fires a `new Notification(...)` **only** when `Notification.permission === "granted"`, with a fixed `tag` so repeated arms coalesce; clicking it focuses the window; the reference is kept so focus-clear can `.close()` it. Absent/denied permission is a silent no-op.

**Reduced motion.** When `matchMedia('(prefers-reduced-motion: reduce)').matches`, the title does **not** flip on an interval; it is set once to the alert string (static), favicon badge + chime + notification still apply. The base 1s cadence is already gentle for users without the preference.

**Persistence.** Sound preference in `localStorage` key `turnAlert.sound` (`"on"`/`"off"`; absent ⇒ default on). Notification state is **not** persisted by us — it is read live from `Notification.permission` (the browser owns it).

## Interfaces / Types

New file `src/frontend/composables/useTurnAlert.ts`:

```ts
import type { Ref } from "vue";
import type { GameType } from "@shared/engine-types";

export type NotifState = "unsupported" | "default" | "granted" | "denied";

export interface UseTurnAlertOptions {
  /** True only for a seated player (myPlayerIndex >= 0). Spectators pass false. */
  isPlayer: Ref<boolean>;
  /** From the board's existing isMyTurn computed. */
  isMyTurn: Ref<boolean>;
  /** From the board's gameState.gameType — drives the alert title label. */
  gameType: Ref<GameType>;
}

export interface UseTurnAlertReturn {
  /** Persisted chime toggle (localStorage). Default true. */
  soundEnabled: Ref<boolean>;
  setSoundEnabled(value: boolean): void;
  /** Live browser permission state ("unsupported" if Notification API absent). */
  notifState: Ref<NotifState>;
  /** Explicit opt-in only. Requests permission, updates notifState. No-op if unsupported/denied. */
  requestNotificationPermission(): Promise<void>;
  /** Idempotent; call from the first in-game user gesture to satisfy autoplay policy. */
  unlockAudio(): void;
}

export function useTurnAlert(opts: UseTurnAlertOptions): UseTurnAlertReturn;
```

Exported pure helpers (in the same module, tested directly):

```ts
/** "● Your turn — Big2" / "● Your turn — Tonk". */
export function buildAlertTitle(gameType: GameType): string;
/** Inline SVG data-URI; badged adds the gold dot. */
export function buildFaviconDataUri(badged: boolean): string;
```

New component `src/frontend/component/game-ui/TurnAlertMenu.vue`:

```ts
defineProps<{
  soundEnabled: boolean;
  notifState: NotifState;      // hide the whole notif row when "unsupported"
}>();
defineEmits<{
  "update:soundEnabled": [value: boolean];
  "request-notifications": [];
}>();
```

Board integration (both `GameBoard.vue` and `TonkBoard.vue`):

```ts
const isPlayer = computed(() => myPlayerIndex.value >= 0);
const gameType = computed(() => props.gameState.gameType);
const {
  soundEnabled, setSoundEnabled,
  notifState, requestNotificationPermission, unlockAudio,
} = useTurnAlert({ isPlayer, isMyTurn, gameType });
```

`TurnAlertMenu` is rendered inside the existing opponents rail (`.game-board__opponents` / `.tonk-board__opponents`, already `position: relative`), wired to the composable. `unlockAudio()` is invoked at the top of each existing gesture handler (`toggleCard`, `onPlay`, `onPass` for Big2; `toggleCard`, `discard`, `draw`, `callTonk` for Tonk).

## State Model

**In-memory (per composable instance, not reactive unless noted):**
- `flashTimer: number | null` — `setInterval` handle for the title flip.
- `originalTitle: string` — captured `document.title` at arm time; restored on clear.
- `originalFaviconHref: string | null` — captured from the managed `<link rel="icon">`; restored on clear.
- `pendingNotification: Notification | null` — closed on clear.
- `audioCtx: AudioContext | null` — created lazily by `unlockAudio()`, reused for chimes.
- `soundEnabled` (reactive `Ref<boolean>`) — mirror of `localStorage["turnAlert.sound"]`.
- `notifState` (reactive `Ref<NotifState>`) — seeded from `Notification.permission` on mount, updated after `requestNotificationPermission()`.

**Persisted (localStorage):** `turnAlert.sound` only. Read on mount; written by `setSoundEnabled`.

**Browser-owned (read, never persisted by us):** `Notification.permission`, `document.hidden`, `document.title`, the favicon `<link>`, `AudioContext` unlock state.

**Lifecycle:** On mount — capture `originalTitle`, resolve/create the managed favicon link, hydrate `soundEnabled`, seed `notifState`, attach the `visibilitychange` listener, start the `shouldAlert` watcher. On `onScopeDispose` — `clearAlert()`, remove the listener, close `audioCtx` if open. This guarantees title/favicon are restored on unmount (navigation, rematch, game over).

## Edge Cases

1. **Turn becomes mine while focused** → `document.hidden` false → `shouldAlert` never rises → no flash, no chime, no notification.
2. **Turn becomes mine while hidden** → rising edge → all enabled effects fire.
3. **Tab hidden while it is already my turn** → rising edge → fires (re-arms if the player leaves again mid-turn).
4. **Focus returns mid-alert** → `visibilitychange` → `document.hidden` false → falling edge → title, favicon, pending notification cleared immediately.
5. **Turn passes away while still hidden** (server auto-pass at `turnDeadline`) → `isMyTurn` false → falling edge → effects cleared even though the tab stays hidden.
6. **Chime disabled** → rising edge still flashes + badges + notifies, but no tone.
7. **Chime enabled but AudioContext never unlocked** (player never interacted, e.g. joined and immediately tabbed away) → no tone, no throw; other effects proceed. First gesture unlocks it for subsequent turns.
8. **AudioContext unavailable / suspended / throws** → caught, silent; feature degrades to title+favicon(+notification).
9. **Notification permission not granted / denied / dismissed** → no notification, no throw; never auto-prompts.
10. **Notification API unsupported** → `notifState = "unsupported"`; menu hides the desktop-alerts row; arm skips notification.
11. **`document.hidden` / Visibility API unavailable** → treated as visible (falsy) → alert never arms (safe degrade).
12. **Favicon `<link>` element missing** → helper injects one; if `document`/`head` unavailable, favicon swap is skipped, no throw.
13. **Reduced motion** → title set once to the alert string (no interval flipping); favicon + chime + notification unchanged.
14. **Spectator** (`myPlayerIndex < 0`) → `isPlayer` false → never arms; `TurnAlertMenu` still renders harmlessly but no alert can fire (recommend hiding it via `v-if="isPlayer"`).
15. **Rapid repeated arms** (toggle tabs quickly) → `flashTimer` guard prevents stacked intervals; notification `tag` coalesces; chime replays per rising edge (acceptable).
16. **Sound toggled off during an active flash** → the one already-played chime cannot be unplayed; toggle affects only future arms. Title/favicon flash is unaffected by the sound toggle.
17. **Unmount / rematch / navigate away mid-alert** → `onScopeDispose` restores title + favicon and closes the notification.
18. **`localStorage` unavailable / throws** (private mode edge) → reads/writes wrapped; `soundEnabled` falls back to in-memory default (on).

## Dependencies

- **Existing, no change:** `GameBoard.vue`, `TonkBoard.vue` already expose `isMyTurn`, `myPlayerIndex`, and `gameState.gameType`. `EnrichedPlayerView` (`@shared/socket-events`) already carries `turnDeadline` and `gameType`. No new props from `GameView.vue`.
- **New files:** `src/frontend/composables/useTurnAlert.ts`, `src/frontend/component/game-ui/TurnAlertMenu.vue`.
- **Design input:** Approved mockup `background-turn-alert.html` (Direction A) — favicon SVGs, chime frequencies, title strings, and popover layout are taken from it.
- **No dependency on:** backend, socket events, DB, `useTurnCountdown` (independent). No new npm packages (Web Audio, Notification, Visibility APIs are native).

## Frontend Design

**Approved direction: Option A + chime on by default + notification opt-in on explicit action** (human comment 2026-07-07). Matches `background-turn-alert.html` Direction A; no new mockup loop.

**Settings surface — gear popover (`TurnAlertMenu.vue`).** A `⚙` icon button pinned to the top-right of the board's opponents rail (absolute within `.game-board__opponents` / `.tonk-board__opponents`, z-index above the rail, below the wood-rim overlay). Clicking toggles a popover (`role="dialog"`, closes on outside click / Escape) containing two rows, styled with the existing game tokens (`--panel-bg`, `--gold-accent`, `--text-muted`, `--font-ui`):

- **Turn sound** — label + hint ("Soft chime when it's your turn & tab is hidden") + a switch bound to `soundEnabled` (default checked). Emits `update:soundEnabled`; the board calls `setSoundEnabled` (persists to `localStorage`).
- **Desktop alerts** — label + hint. When `notifState === "default"`: an **Enable** button emitting `request-notifications` (the board calls `requestNotificationPermission()` — the **only** place permission is requested). When `"granted"`: a static "On" chip, button hidden. When `"denied"`: a "Blocked" chip (button hidden). When `"unsupported"`: the row is not rendered.

**Alert visuals (browser chrome, no in-app layout change):**
- Title flips between the captured normal title and `● Your turn — Big2` / `● Your turn — Tonk` every ~1000ms.
- Favicon shows a gold badge dot (badged SVG data-URI); reverts on focus.
- Desktop notification title `Your turn — Big2` / `Your turn — Tonk`, body "Tap to return to your game", app icon = normal favicon; clicking focuses the tab.

**Accessibility:** switch is a real `<input type="checkbox">` with visible focus ring; gear has `aria-label="Alert settings"`; popover is keyboard-dismissible. Reduced-motion path uses a static (non-flipping) alert title. All three chrome primitives degrade independently and silently.

## Test Requirements

Frontend unit tests only (per acceptance — no backend/integration tests). Location `tests/frontend/useTurnAlert.test.ts` (plus pure-helper cases). The project runs Vitest in a **node** environment with no jsdom, so tests stub the browser globals they exercise (`document`, `window`, `Notification`, `AudioContext`, `localStorage`, `matchMedia`) with `vi`, mirroring existing patterns (`gameBoardMobile.test.ts`, `roomCodeChip.test.ts`). Use `effectScope` + `onScopeDispose` and fake timers as in `useTurnCountdown.test.ts`.

**Pure helpers:**
- `buildAlertTitle("big2")` → `"● Your turn — Big2"`; `"tonk"` → `"● Your turn — Tonk"`.
- `buildFaviconDataUri(false)` vs `(true)` differ and both are valid `data:image/svg+xml` strings (badged contains the extra dot circle).

**Arming / trigger logic:**
- Rising edge fires when `isPlayer && isMyTurn && hidden` — asserts `document.title` becomes the alert string and the managed favicon link href becomes the badged URI.
- **No-op when focused:** `isMyTurn` true but `document.hidden` false → title/favicon unchanged, chime not called.
- **No-op for spectator:** `isPlayer` false → never arms even when hidden + "my turn".
- **Tab hidden while already my turn** (visibility flips hidden with `isMyTurn` already true) → arms.

**Clean reset:**
- `visibilitychange` → visible → title restored to captured original, favicon restored, `flashTimer` cleared, pending notification `.close()` called.
- `isMyTurn` → false while still hidden → clears.
- Scope disposal restores title + favicon and removes the `visibilitychange` listener.

**Chime setting honored:**
- With `soundEnabled` true + audio unlocked → arm calls the chime path (spy on the oscillator/`AudioContext` factory).
- With `soundEnabled` false → arm does **not** call the chime path (title/favicon still applied).
- Chime not attempted before `unlockAudio()` (or if `AudioContext` is missing) → no throw.
- `setSoundEnabled` persists to `localStorage["turnAlert.sound"]`; a fresh composable hydrates from it; absent key defaults to on.

**Notification behavior:**
- Permission `granted` → arm constructs a `Notification` with the expected title (spy on a `Notification` stub); tag reused across arms.
- Permission `default`/`denied` → arm constructs **no** `Notification`, throws nothing, and no permission prompt occurs unless `requestNotificationPermission()` is explicitly called.
- `requestNotificationPermission()` calls `Notification.requestPermission()` exactly once and updates `notifState`; unsupported → `notifState === "unsupported"` and request is a no-op.
- **Regression guard:** merely mounting the composable / arming an alert never calls `Notification.requestPermission()`.

**Degradation:**
- Missing favicon `<link>` → arm injects/uses one without throwing; missing `document` guards skip cleanly.
- `prefers-reduced-motion` matches → title is set once (assert `setInterval` for the flip is not started), badge + chime paths still run.

**Manual (not automated — genuinely visual/environmental):** verify a real desktop notification appears after granting permission and tabbing away in both Big2 and Tonk; verify the actual browser tab title + favicon flash and reset on focus. Everything else above is automated.
