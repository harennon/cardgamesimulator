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
`shouldAlert = isPlayer && isInProgress && isMyTurn && document.hidden`.
Watch it and act on its edges:

The `isInProgress` term (`gameStatus === "IN_PROGRESS"`) is load-bearing and **not** redundant with `isMyTurn`. `isMyTurn` is computed purely as `currentPlayerIndex === myPlayerIndex` (`GameBoard.vue:152-153`, `TonkBoard.vue:209-211`) with no dependency on status. For **Big2**, `GameView.vue` keeps `GameBoard.vue` mounted through the `SHOW_FINAL_PLAY` phase after `status` becomes `COMPLETED` (`GameView.vue` `displayPhase` logic, ~line 336, and template lines 27-40/55-68). If the winning player is tabbed away during that reveal and `currentPlayerIndex` still points at their seat, `isMyTurn` can remain true even though the game is over — without the status guard this would arm a spurious "Your turn" alert at game over. Gating on `IN_PROGRESS` suppresses it. (Tonk is unaffected — it unmounts `TonkBoard` to `GameOverView` on completion, triggering `onScopeDispose` cleanup — but the guard is applied uniformly to both boards for a single, obviously-correct rule.)

- **rising edge (false→true)** → `armAlert()` (start flash, badge favicon, chime if enabled+unlocked, notification if granted).
- **falling edge (true→false)** → `clearAlert()` (stop flash, restore title + favicon, close pending notification).

This single-signal model cleanly satisfies every acceptance case without special-casing:

- Turn arrives while hidden → rising edge → fires.
- Tab is hidden while it is already my turn → rising edge → fires (covers "left again while still my turn").
- Tab regains focus → falling edge → clears immediately (`visibilitychange` flips `document.hidden`).
- Turn passes away while I'm still hidden (e.g. server auto-pass at deadline) → falling edge → clears.
- Turn becomes mine while the tab is **focused** → `document.hidden` is false → signal never rises → **nothing fires**.
- Spectator → `isPlayer` false → signal never rises.
- Big2 game ends while I am the seat still marked current and I am tabbed away (`SHOW_FINAL_PLAY` after `COMPLETED`) → `isInProgress` false → signal never rises → **no spurious "Your turn" at game over**.

**Why a composable, not inline board code.** Both boards need identical behavior; a composable keeps the boards thin and makes the logic unit-testable in isolation (project convention — see `useTurnCountdown.ts`). It cleans up via `onScopeDispose`.

**Favicon strategy — pre-baked SVG data-URI, replacing ALL existing icon links.** A pure helper `buildFaviconDataUri(badged: boolean)` returns an inline SVG (green rounded rect + gold `♠` glyph, matching the approved mockup; badged variant adds a gold dot top-right).

The critical constraint: `src/frontend/index.html` declares **four** icon links — one `apple-touch-icon` plus **three** `rel="icon"` links (`favicon-32x32.png`, `favicon-16x16.png`, `favicon.ico`). Browsers choose among multiple `rel="icon"` links by size/order, so simply appending one SVG link would not reliably win, and restoring only "the managed link" would leave the PNG/ico links in place → browser-dependent badge behavior. The composable therefore **manages the full set of tab-favicon links**, not a single link:

- **On arm:** query `document.head.querySelectorAll('link[rel~="icon"]')` (this matches all three `rel="icon"` links by the `icon` rel token; it does **not** match `apple-touch-icon`, whose `rel` is `apple-touch-icon` — that link governs iOS home-screen icons, not the desktop tab strip, so we leave it untouched). Detach these matched elements from `<head>` (retaining their node references and original order in `originalIconLinks`), then inject **one** managed `<link rel="icon" type="image/svg+xml">` whose `href` is the badged SVG data-URI. With every competing `rel="icon"` link removed, the single SVG is unambiguously selected and the badge is guaranteed to show.
- **On clear:** remove the managed SVG link and re-insert the detached `originalIconLinks` back into `<head>` in their original order, restoring the exact pre-arm DOM (identical `href`/`type`/`sizes` attributes, since they are the same node objects).
- **Idempotency:** arm is a no-op if the managed link is already present (guarded by a stored reference), so repeated rising edges do not detach the originals twice or leak duplicate managed links.

- _Alternative — canvas-generate a badge over the live favicon._ Rejected as the default: the production favicons are cross-origin raster PNGs on `danbing.app`; drawing them to a canvas taints it and `toDataURL()` throws. The pre-baked SVG has no CORS dependency, is deterministic, and is trivially testable. If exact-icon fidelity is later required, swap the helper's SVG for a same-origin asset — no other change.

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
  /** True only while gameState.status === "IN_PROGRESS". Suppresses a
   *  spurious alert during Big2's post-COMPLETED SHOW_FINAL_PLAY reveal. */
  isInProgress: Ref<boolean>;
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
const isInProgress = computed(() => props.gameState.status === "IN_PROGRESS");
const gameType = computed(() => props.gameState.gameType);
const {
  soundEnabled, setSoundEnabled,
  notifState, requestNotificationPermission, unlockAudio,
} = useTurnAlert({ isPlayer, isInProgress, isMyTurn, gameType });
```

`TurnAlertMenu` is rendered inside the existing opponents rail (`.game-board__opponents` / `.tonk-board__opponents`, already `position: relative`), wired to the composable.

**Gesture-handler wiring for `unlockAudio()`** differs per board because the two boards structure their emits differently — the implementer must not assume named handlers exist on both:

- **Big2 (`GameBoard.vue`)** already routes its interactions through **named functions** — `toggleCard` (line 177-179), `onPlay` (181-183), `onPass` (185-187). Add `unlockAudio()` as the first statement of each of these three functions.
- **Tonk (`TonkBoard.vue`)** does **not** have named handlers for its interactions — they are **inline arrow emits in the template** (`@toggle="(index) => emit('toggleCard', index)"` line 60, `@discard="emit('discard')"` line 113, `@draw="(source) => emit('draw', source)"` line 114, `@call-tonk="emit('callTonk')"` line 115). Do **not** reference non-existent `discard`/`draw`/`callTonk` functions. Instead, add `unlockAudio()` into each inline handler alongside the existing emit, e.g. `@toggle="(index) => { unlockAudio(); emit('toggleCard', index); }"`, `@discard="() => { unlockAudio(); emit('discard'); }"`, `@draw="(source) => { unlockAudio(); emit('draw', source); }"`, `@call-tonk="() => { unlockAudio(); emit('callTonk'); }"`. (Equivalently, introduce small named wrapper functions in `<script setup>` and bind those — implementer's choice; the requirement is that `unlockAudio()` runs on the first real Tonk interaction.)

## State Model

**In-memory (per composable instance, not reactive unless noted):**
- `flashTimer: number | null` — `setInterval` handle for the title flip.
- `originalTitle: string` — captured `document.title` at arm time; restored on clear.
- `originalIconLinks: HTMLLinkElement[]` — the `link[rel~="icon"]` nodes detached from `<head>` on arm (in original order), re-inserted on clear. `apple-touch-icon` is never touched.
- `managedIconLink: HTMLLinkElement | null` — the single SVG `<link rel="icon">` we inject on arm and remove on clear; also serves as the arm-idempotency guard.
- `pendingNotification: Notification | null` — closed on clear.
- `audioCtx: AudioContext | null` — created lazily by `unlockAudio()`, reused for chimes.
- `soundEnabled` (reactive `Ref<boolean>`) — mirror of `localStorage["turnAlert.sound"]`.
- `notifState` (reactive `Ref<NotifState>`) — seeded from `Notification.permission` on mount, updated after `requestNotificationPermission()`.

**Persisted (localStorage):** `turnAlert.sound` only. Read on mount; written by `setSoundEnabled`.

**Browser-owned (read, never persisted by us):** `Notification.permission`, `document.hidden`, `document.title`, the favicon `<link>` set in `<head>`, `AudioContext` unlock state.

**Lifecycle:** On mount — capture `originalTitle`, hydrate `soundEnabled`, seed `notifState`, attach the `visibilitychange` listener, start the `shouldAlert` watcher. The favicon links are **not** manipulated on mount; the detach/inject happens lazily inside `armAlert()` and is reversed in `clearAlert()`. On `onScopeDispose` — `clearAlert()` (restores `document.title` and re-inserts the original icon links if an alert is active), remove the listener, close `audioCtx` if open. This guarantees title/favicon are restored on unmount (navigation, rematch, game over).

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
12. **Favicon links** → on arm, all `link[rel~="icon"]` nodes are detached (originals preserved) and one managed SVG `<link rel="icon">` is injected so it is unambiguously selected; on clear the originals are re-inserted in order and the managed link removed. If **no** `rel="icon"` link exists (unexpected), the managed link is still injected and removed cleanly (`originalIconLinks` is empty). If `document`/`document.head` is unavailable, the favicon swap is skipped entirely, no throw; other effects proceed. `apple-touch-icon` is never modified.
13. **Game ends while I am still the current seat and tabbed away** (Big2 `SHOW_FINAL_PLAY` after `status === "COMPLETED"`, where `isMyTurn` can stay true) → `isInProgress` false → `shouldAlert` never rises → no spurious "Your turn" alert at game over. Tonk unmounts to `GameOverView`, disposing the composable, so it cannot arm either.
14. **Reduced motion** → title set once to the alert string (no interval flipping); favicon + chime + notification unchanged.
15. **Spectator** (`myPlayerIndex < 0`) → `isPlayer` false → never arms. **Spec decision:** the `TurnAlertMenu` gear is **not rendered** for spectators — it is bound `v-if="isPlayer"` on both boards. Both rows (sound toggle, notification opt-in) are useless to a spectator who can never be alerted, so the control is hidden rather than shown-but-inert. This is a firm requirement, not a suggestion, so implementation and QA agree.
16. **Rapid repeated arms** (toggle tabs quickly) → `flashTimer` guard prevents stacked intervals; notification `tag` coalesces; chime replays per rising edge (acceptable).
17. **Sound toggled off during an active flash** → the one already-played chime cannot be unplayed; toggle affects only future arms. Title/favicon flash is unaffected by the sound toggle.
18. **Unmount / rematch / navigate away mid-alert** → `onScopeDispose` restores title + favicon and closes the notification.
19. **`localStorage` unavailable / throws** (private mode edge) → reads/writes wrapped; `soundEnabled` falls back to in-memory default (on).

## Dependencies

- **Existing, no change:** `GameBoard.vue`, `TonkBoard.vue` already expose `isMyTurn`, `myPlayerIndex`, and `gameState.gameType`. `PlayerView`/`EnrichedPlayerView` (`@shared/engine-types`, `@shared/socket-events`) already carry `status: GameStatus` (`"CREATED" | "IN_PROGRESS" | "COMPLETED"`), `turnDeadline`, and `gameType`, so `isInProgress` is derived from `props.gameState.status` with no new prop from `GameView.vue`.
- **New files:** `src/frontend/composables/useTurnAlert.ts`, `src/frontend/component/game-ui/TurnAlertMenu.vue`.
- **Design input:** Approved mockup `background-turn-alert.html` (Direction A) — favicon SVGs, chime frequencies, title strings, and popover layout are taken from it.
- **No dependency on:** backend, socket events, DB, `useTurnCountdown` (independent). No new npm packages (Web Audio, Notification, Visibility APIs are native).

## Frontend Design

**Approved direction: Option A + chime on by default + notification opt-in on explicit action** (human comment 2026-07-07). Matches `background-turn-alert.html` Direction A; no new mockup loop.

**Settings surface — gear popover (`TurnAlertMenu.vue`).** A `⚙` icon button pinned to the top-right of the board's opponents rail (absolute within `.game-board__opponents` / `.tonk-board__opponents`, z-index above the rail, below the wood-rim overlay). It is rendered only for seated players (`v-if="isPlayer"` — spectators never see it; see Edge Case 15). Clicking toggles a popover (`role="dialog"`, closes on outside click / Escape) containing two rows, styled with the existing game tokens (`--panel-bg`, `--gold-accent`, `--text-muted`, `--font-ui`):

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
- Rising edge fires when `isPlayer && isInProgress && isMyTurn && hidden` — asserts `document.title` becomes the alert string, all pre-existing `link[rel~="icon"]` nodes are detached from `<head>`, and exactly one managed `<link rel="icon" type="image/svg+xml">` with the badged data-URI is present.
- **No-op when focused:** `isMyTurn` true but `document.hidden` false → title/favicon unchanged, chime not called.
- **No-op for spectator:** `isPlayer` false → never arms even when hidden + "my turn".
- **No-op at game over:** `isInProgress` false (e.g. Big2 `SHOW_FINAL_PLAY` after completion) with `isMyTurn` true + hidden → never arms (guards the spurious game-over alert; Edge Case 13).
- **Tab hidden while already my turn** (visibility flips hidden with `isMyTurn` already true) → arms.
- **Favicon coexistence:** seed a fake `<head>` with the four index.html links (apple-touch-icon + three `rel="icon"`); assert arm removes the three `rel="icon"` links and leaves `apple-touch-icon` untouched, and clear restores all three `rel="icon"` links in their original order with original `href`/`sizes`/`type`.
- **Arm idempotency:** two consecutive rising edges (without an intervening clear) do not detach originals twice nor inject a second managed link.

**Clean reset:**
- `visibilitychange` → visible → title restored to captured original, managed SVG link removed, original `rel="icon"` links re-inserted, `flashTimer` cleared, pending notification `.close()` called.
- `isMyTurn` → false while still hidden → clears.
- Scope disposal restores title + the original favicon link set and removes the `visibilitychange` listener.

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

**`TurnAlertMenu` component:**
- Spectator gating is a **board-level** render guard (`v-if="isPlayer"`), so it is verified on the boards (see the QA/manual note): the gear renders for a seated player and is absent for a spectator. `TurnAlertMenu.vue`'s own unit tests cover its prop-driven rows: desktop-alerts row hidden when `notifState === "unsupported"`; Enable button shown only for `"default"`; static On/Blocked chips for `"granted"`/`"denied"`; sound switch reflects `soundEnabled` and emits `update:soundEnabled`.

**Degradation:**
- No `rel="icon"` link present → arm still injects the managed SVG link (empty `originalIconLinks`) and clear removes it without throwing; missing `document`/`document.head` guards skip the favicon swap cleanly.
- `prefers-reduced-motion` matches → title is set once (assert `setInterval` for the flip is not started), badge + chime paths still run.

**Manual (not automated — genuinely visual/environmental):** verify a real desktop notification appears after granting permission and tabbing away in both Big2 and Tonk; verify the actual browser tab title + favicon flash and reset on focus. Everything else above is automated.
