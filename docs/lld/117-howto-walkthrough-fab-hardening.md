# LLD 117: How-to-play walkthrough — persistent-FAB edge-case hardening + cross-surface polish

Parent: #95 (order 3 of 3). The integration/polish slice. It **hardens** the
already-shipped persistent (?) help FAB across the surfaces it now appears on
(create-game, lobby waiting screen, and the live game board) without adding any
new content, any new entrypoint, or any new aesthetic.

**Dependencies are merged.** #122 / LLD 111 (app-shell persistent (?) FAB +
`FeedbackWidget` consolidation, PR #129) and #123 / LLD 115 (Tonk content, PR
#131) are both on this branch. The single persistent bottom-right (?) FAB is the
**sole entrypoint** and is delivered by #122 — this LLD does **not** add a
view-specific lobby entrypoint (the re-scope note on #117 supersedes the original
issue body, which predates the owner's single-FAB decision).

**Approved direction: Direction A.** On the **live board only**, lift the
`HelpCluster` above the Play/Pass action row via a board-safe bottom offset, and
on mobile collapse the cluster to a single (?) FAB so the hand keeps full width.
Keep a predictable resting corner (bottom-right, current position) on every other
surface. Docking the cluster into the top-right opponent row (Direction B) was
**rejected** — do not implement it.

---

## 1. Scope

### In scope

- **Board-safe placement of the existing `HelpCluster`.** When the current view is
  the live board (Big2 `GameBoard` or Tonk `TonkBoard`), the cluster is lifted so
  it clears the bottom action row (`Play`/`Pass` on Big2; `Discard`/`Draw`/`TONK`
  on Tonk) and never overlaps the player's own hand — at every viewport width.
- **Mobile board collapse to a single (?) FAB.** On mobile board widths
  (≤767px, matching the board's own `--mobile-*` breakpoint), the bug icon is
  hidden so only the (?) FAB shows on the board, keeping the hand row full-width.
  The bug icon remains available on non-board surfaces at all widths.
- **Surface awareness for the cluster.** `HelpCluster` learns "am I over a live
  board?" so it can apply the board offset/collapse only there, and reverts to the
  predictable resting corner on create-game, lobby, home, stats, and game-over.
- **State-preservation hardening for open/close on every surface** (verification +
  the one structural fix that makes it hold — see §2.3):
  - Opening/closing from the **lobby** does not disturb lobby state (player list,
    room code, Start button) or the socket connection.
  - Opening/closing from the **live board** does not disturb game state, turn
    timers, or the socket, and does not block board interaction.
  - Closing returns the user exactly where they were.
- **Game-starts-while-open edge case.** If the game starts (lobby → board) while
  the walkthrough modal is open, the board transitions underneath the scrim, the
  user is **not trapped**, the transition is **not blocked**, and a non-blocking
  ~3s toast tells them the game started (see §2.4, E4).
- **Consistent styling/placement/behavior** across create-game, lobby, and board,
  reusing the #122 visual language verbatim (dark felt, gold accent, `HelpCluster`
  (?)+bug styling, same z-index stack). No new aesthetic.
- Mobile-viewport correctness for all of the above.

### Explicitly NOT in scope

- **Any change to the FAB entrypoint pattern itself** (owned by #122):
  `HelpCluster`'s existence, the (?)-opens-walkthrough contract, `getWalkthrough`,
  `useCurrentGameType`, and the `FeedbackWidget` consolidation are reused
  verbatim. This LLD adds surface-aware placement and a game-start toast — it does
  not restructure the entrypoint.
- **Any content or rendering change.** `WalkthroughModal`, `WalkthroughScene`,
  `walkthroughs.ts`, `big2Walkthrough.ts`, `tonkWalkthrough.ts`, `GameCard.vue`,
  `stepNav.ts` are untouched. No new `WalkthroughScene` kind, no caption edits.
- **A second/view-specific entrypoint** on the lobby or anywhere (owner rejected;
  re-scope note).
- **Docking the cluster into the opponent row** (Direction B, rejected).
- Live guided overlay on a running game, video, animation, localization.
- Auto-launch / "seen" flag for first-time players (future follow-up).
- Any backend, engine, transport, migration, or persistence change. Frontend
  presentation + one small App-shell wiring only.

---

## 2. Approach

### 2.1 Why hardening is a placement + surface-awareness problem, not a rewrite

The #122 shell is already correct: `HelpCluster` is mounted once in `App.vue`
(after `<router-view>`), is `position: fixed` at `right:16px; bottom:16px`,
`z-index:1000`, and its only inputs are the static walkthrough content and the
`gameType` enum (LLD 111 decision 7 — it never touches live game state, the
socket, or `useGameState`). Because it is App-shell-mounted, **the walkthrough
modal already survives route/phase changes for free** — it is not a child of any
view, so a lobby→board transition does not unmount it.

The only real defects the persistent FAB introduces are **spatial**, confirmed
against the source:

1. **Board action-row overlap.** Both boards use
   `grid-template-rows: 80px 1fr 220px 64px` (desktop) / `... var(--mobile-actions-height)`
   (56px, mobile) with the bottom `actions` row holding Play/Pass (Big2) or
   Discard/Draw/TONK (Tonk). The cluster sits at `bottom:16px`, so the (?) FAB
   (46px) overlaps the bottom-right of that action row at every width. This is the
   headline acceptance failure ("must not obstruct Play/Pass").
2. **Mobile hand crowding.** On mobile the vertical two-button cluster (46px + 40px
   + gap) sits over the right edge of the hand/actions zone in the narrow
   single-column grid.
3. **Mobile log-toggle proximity.** The board's mobile log-toggle is fixed at
   `top:60px; right:8px` (z-index 200). The cluster is bottom-right, so they do
   not currently collide, but the board offset must not push the cluster up into
   it.

Everything else in the acceptance list (state preserved, socket intact, closing
returns you where you were) is a **property to verify** that already holds by
construction because the modal carries no live state and the shell is not remounted
— plus one structural guarantee in §2.3. So this slice is: (a) make the cluster
surface-aware and lift/collapse it on the board, (b) add the game-start toast, and
(c) lock the preserved-state properties with tests.

### 2.2 Direction A: board-safe offset + mobile collapse; predictable corner elsewhere

`HelpCluster` gains a single reactive boolean — `onBoard` — derived from the route
(the board is the only route matching `^/game/[^/]+$`, already used by `App.vue`'s
`showNav`). It never reads game state; the route path is sufficient and keeps
decision 7 intact.

- **Desktop board (`onBoard`, >767px):** the cluster's `bottom` is raised to clear
  the 64px action row plus breathing room — `bottom: calc(64px + 16px + env(safe-area-inset-bottom))`.
  Both buttons remain visible (the (?) above the bug icon, per the existing
  `column-reverse` stack). It sits above the felt/rim (z-index 100) but below the
  walkthrough/feedback scrims (1100+) — the existing `z-index:1000` is unchanged.
- **Mobile board (`onBoard`, ≤767px):** the cluster raises to
  `bottom: calc(var(--mobile-actions-height) + 12px + env(safe-area-inset-bottom))`
  (clears the 56px action row) **and hides the bug icon** so only the single (?)
  FAB shows, keeping the hand full-width. This matches the approved Direction A
  ("collapse the cluster to a single ? FAB so the hand keeps full width").
- **All non-board surfaces (any width):** the cluster keeps the current resting
  corner (`right:16px; bottom:16px`) and shows **both** buttons — unchanged from
  #122. Create-game, lobby, home, stats, and game-over are visually identical to
  today.

Placement is driven entirely by two classes toggled on the existing
`.help-cluster` element (`.help-cluster--board`, `.help-cluster--board-mobile`);
no new component, no teleport, no new stacking context. The breakpoint reuses the
board's own `(max-width: 767px)` media query / `matchMedia` so the collapse and the
board's mobile grid switch at exactly the same width.

**Why not Direction B (dock into the opponent row):** rejected by the owner —
docking would couple the shell to per-board layout, break the single predictable
resting corner across surfaces, and risk colliding with the room-code chip /
opponent seats. Direction A keeps the cluster a self-contained fixed overlay.

### 2.3 State preservation is structural, not incidental — and the one guarantee to add

The lobby player list, room code, Start button, socket, game state, and turn timers
all live in `GameView.vue` and its composables (`useGameState`, `useSocket`,
`useGameActions`), entirely outside `HelpCluster`. The walkthrough modal:

- imports no game state, no socket, no game composables (`useGameState`,
  `useSocket`, `useGameActions`, `socket-events`);
- toggling `walkthroughOpen` mutates only a local `ref` in `HelpCluster`;
- is App-shell-mounted, so opening it neither remounts `GameView` nor re-runs its
  join flow.

The decision-7 isolation is enforced by the existing #122 source-scan test's
forbidden-import scan. Note that test's `MODULE_FILES` list currently covers only
the leaf content/nav modules (`walkthroughs.ts`, `walkthroughTypes.ts`,
`big2Walkthrough.ts`, `tonkWalkthrough.ts`, `stepNav.ts`, `WalkthroughScene.vue`,
`WalkthroughModal.vue`) — it does **not** yet cover `HelpCluster.vue`. The new
`clusterPlacement.ts` helper this LLD extracts (§4.2, §9) is added to that
`MODULE_FILES` list (§7.1) so the placement/toast logic is held to the same
no-live-state bar; that extracted helper — not `HelpCluster.vue` itself — is what
the scan enforces.

Therefore opening/closing the modal **cannot** disturb lobby/board/socket state —
there is no wire between them. The hardening for these criteria is primarily
**verification** (§7 e2e) plus **one guarantee**: the walkthrough scrim must not
sit in a way that intercepts pointer events for the underlying view when
**closed**. Today the scrim is `v-if="walkthroughOpen"` so it is fully removed when
closed (verified in `WalkthroughModal.vue` — the scrim is inside the `v-if`), so
board interaction is not blocked when the modal is shut. The one thing to lock down:
the **board offset classes must apply to the cluster wrapper only**, never to the
modal scrim, so the scrim always covers the full viewport (`inset:0`) and closing it
frees the whole board. This LLD asserts that invariant with a test rather than
changing the scrim.

### 2.4 Game-starts-while-open: transition underneath a static scrim + a toast

Because `HelpCluster`/`WalkthroughModal` are App-shell-mounted and carry no live
state, when the game starts the lobby→board swap happens **inside `<router-view>`
underneath the still-open modal**; the modal keeps rendering its static content and
`GameView` transitions `displayPhase` CREATED→IN_PROGRESS beneath it. The user is
not trapped (X / scrim / Esc / "Got it" all still close it) and the transition is
not blocked (nothing in the modal gates `GameView`).

The one UX gap: a player reading the walkthrough in the lobby would not notice the
game started. Direction A specifies a **non-blocking ~3s toast**. The signal
`HelpCluster` reacts to is the **existing `useFeedbackContext.gamePhase` enum** —
no new phase singleton is introduced:

- `useFeedbackContext` already exposes an enum-only `gamePhase`
  (`"lobby" | "in-progress" | "game-over" | undefined`), a module singleton set by
  `GameView` from the **same** `watch(displayPhase, …)` that drives the feedback
  context (`GameView.vue` line 243/258 — `setGamePhase(toFeedbackPhase(phase))`),
  and `clearGamePhase()` on unmount. It carries **no hands/board/socket data** —
  only the coarse phase enum — so it already respects decision 7. The
  CREATED→IN_PROGRESS game start is exactly the `"lobby"` → `"in-progress"` edge on
  this ref.
- `HelpCluster` imports `useFeedbackContext`, reads its readonly `gamePhase`, and
  watches it **only while `walkthroughOpen` is true**; when the `"lobby"` →
  `"in-progress"` edge fires, it shows a small non-blocking toast ("Game started —
  close this when you're ready") for ~3s. The toast does **not** auto-close the
  modal and does **not** block the board (`pointer-events: none` on the toast). The
  player closes the modal when ready and lands on the already-transitioned board.

**Rationale — reuse the existing feedback-phase signal; do NOT add a second one.**
An earlier draft proposed adding a parallel `gamePhase` enum to `useCurrentGameType`.
That is rejected for two concrete reasons: (1) `GameView.vue` already destructures
`{ setGamePhase, clearGamePhase }` from `useFeedbackContext()` (line 243); adding a
same-named `setGamePhase` from `useCurrentGameType()` would collide in the same
file. (2) More fundamentally, `useFeedbackContext.gamePhase` is **already** an
enum-only App-shell bridge fed by the exact `watch(displayPhase)` we need and
**already** makes the CREATED→IN_PROGRESS (`"lobby"` → `"in-progress"`) distinction.
Introducing a second phase singleton fed by the same watch would create two parallel
signals for one fact — pure duplication with no benefit. Reusing the feedback enum
genuinely keeps the wire count at one and requires **no change** to
`useCurrentGameType` or `GameView` for the toast.

Alternatives considered and rejected: (a) have `HelpCluster` read `useGameState` —
violates decision 7 (live game state in the shell); (b) have `HelpCluster` read the
route alone — cannot distinguish CREATED from IN_PROGRESS (same `/game/:id` path);
(c) add a new enum to `useCurrentGameType` — duplicates the existing feedback-phase
signal and collides with GameView's existing `setGamePhase` binding (above).

### 2.5 Reuse the #122 visual language verbatim

No new colors, fonts, radii, shadows, or icons. The board offset uses existing
tokens (`--mobile-actions-height`) and `env(safe-area-inset-bottom)` (already used
by the game-over CTA in `GameView.vue`). The toast reuses the panel/gold tokens
(`--panel-bg`, `--gold-accent`, `--text-primary`) and the existing copied-toast
sizing idiom. Reduced-motion is respected (toast fade disabled), matching existing
components.

---

## 3. Frontend Design

**Direction A (approved).** The persistent bottom-right cluster is unchanged in
appearance and behavior on every non-board surface. On the board it is lifted above
the action row; on the mobile board it collapses to the single (?) FAB.

### 3.1 Cluster placement matrix

| Surface | Width | Cluster position | Buttons shown |
|---|---|---|---|
| home / create-game / lobby / stats / game-over | any | `right:16px; bottom:16px` (unchanged) | (?) + bug |
| live board (Big2/Tonk) | desktop (>767px) | `right:16px; bottom: calc(64px + 16px + safe-area)` | (?) + bug |
| live board (Big2/Tonk) | mobile (≤767px) | `right:16px; bottom: calc(var(--mobile-actions-height) + 12px + safe-area)` | (?) only (bug hidden) |

Placement per surface is driven by two modifier classes on the existing
`.help-cluster` element. The (?) FAB stays 46px and the bug icon 40px (≥44px
effective tap target with padding preserved from #122). The walkthrough/feedback
modals and their scrims are **unchanged** (full-viewport `inset:0`, z-index 1100+).

### 3.2 Game-start toast (lobby → board while open)

A small pill anchored just above the cluster (or top-center on mobile), gold-accent
border on `--panel-bg`, `pointer-events: none`, auto-dismiss ~3s, fade honoring
`prefers-reduced-motion`. Copy: "Game started — close this when you're ready."
`data-testid="howto-gamestart-toast"`. It appears only if the walkthrough is open
when the game starts; it never blocks the board or auto-closes the modal.

### 3.3 Mockup gate

No new mockup round is required. Direction A introduces **no new visual UI** — it
only repositions the already-approved #122 cluster and adds one toast reusing
existing tokens. The visual chrome (cluster buttons, modal, colors) is the shipped
#122 design; the only deltas are a CSS offset, a mobile button hide, and a
token-reuse toast. The frontend-architect confirmed Direction A against the shipped
cluster; the owner approved Direction A directly. (If the reviewer wants pixel
confirmation, a static mockup can be produced on port 8090, but it is not gating
for a repositioning-only change.)

---

## 4. Interfaces / Types

### 4.1 Game-start signal — reuse `useFeedbackContext.gamePhase` (NO composable change)

**No new phase signal and no change to `useCurrentGameType` or `GameView`.** The
game-start edge is read from the **existing** `useFeedbackContext.gamePhase`
enum, which is already a shell-level, enum-only singleton set by `GameView`:

```typescript
// src/frontend/composables/useFeedbackContext.ts  (EXISTING — reused verbatim, unchanged)
export type FeedbackGamePhase = "lobby" | "in-progress" | "game-over";
// gamePhase: DeepReadonly<Ref<FeedbackGamePhase | undefined>>
// setGamePhase(phase); clearGamePhase();
```

`GameView.vue` already drives it (unchanged): `watch(displayPhase, (phase) =>
setGamePhase(toFeedbackPhase(phase)), { immediate: true })` sets `"lobby"` for
CREATED and `"in-progress"` for IN_PROGRESS / SHOW_FINAL_PLAY, and
`clearGamePhase()` fires in `onUnmounted`. The game-started edge `HelpCluster`
reacts to is therefore `"lobby"` → `"in-progress"` on this existing ref — no new
`GameView` wiring is added by this LLD.

> Collision note (must be honored by the implementer): `GameView.vue` already
> imports `{ setGamePhase, clearGamePhase }` from `useFeedbackContext()` (line 243).
> Do **not** add a second, same-named `setGamePhase`/`gamePhase` to
> `useCurrentGameType` — it would collide with that binding in the same file and
> duplicate a signal that already exists. `HelpCluster` consumes the feedback-phase
> enum directly (§4.2); `useCurrentGameType` continues to carry only the `gameType`
> enum and is untouched.

### 4.2 `HelpCluster.vue` — surface awareness (additions only)

No prop changes; consumes the route and the media query internally.

```typescript
// Additions to <script setup> in HelpCluster.vue
import { useRoute } from "vue-router";
import { onMounted, onUnmounted, watch } from "vue";
import { useFeedbackContext } from "@/composables/useFeedbackContext";

const route = useRoute();
// The live board is the only route shaped /game/<id> (mirrors App.vue showNav).
const onBoard = computed(() => /^\/game\/[^/]+$/.test(route.path));

// Same breakpoint as the boards' own mobile grid.
const mql = window.matchMedia("(max-width: 767px)");
const isNarrow = ref(mql.matches);
const onNarrowChange = (e: MediaQueryListEvent) => { isNarrow.value = e.matches; };
onMounted(() => mql.addEventListener("change", onNarrowChange));
onUnmounted(() => mql.removeEventListener("change", onNarrowChange));

const { gamePhase } = useFeedbackContext(); // EXISTING enum-only signal (§4.1)

// Toast: fire only when the game starts WHILE the walkthrough is open, i.e. the
// lobby→board edge on the existing feedback-phase enum ("lobby" -> "in-progress").
const gameStartToast = ref(false);
let toastTimer: ReturnType<typeof setTimeout> | null = null;
watch(gamePhase, (now, prev) => {
  if (walkthroughOpen.value && prev === "lobby" && now === "in-progress") {
    gameStartToast.value = true;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { gameStartToast.value = false; }, 3000);
  }
});
```

Template deltas:
- `<div class="help-cluster" :class="{ 'help-cluster--board': onBoard, 'help-cluster--board-mobile': onBoard && isNarrow }">`
- bug-icon button gets `v-if="!(onBoard && isNarrow)"` (collapse on mobile board only).
- add the toast element (`v-if="gameStartToast"`, `data-testid="howto-gamestart-toast"`,
  `pointer-events:none`) inside the cluster wrapper.

Everything else (the (?) FAB, feedback wiring, `feedbackOpen` hide, modal mount)
is unchanged from #122.

### 4.3 CSS (additions only, existing tokens)

```css
.help-cluster--board { bottom: calc(64px + 16px + env(safe-area-inset-bottom, 0px)); }
.help-cluster--board-mobile {
  bottom: calc(var(--mobile-actions-height) + 12px + env(safe-area-inset-bottom, 0px));
}
/* toast: --panel-bg / --gold-accent / --text-primary; pointer-events:none; fade
   disabled under prefers-reduced-motion */
```

### 4.4 `data-testid` contract (additions)

Reused verbatim from #122: `howto-fab`, `feedback-trigger`, `howto-modal`,
`howto-close`, `howto-next`, `howto-back`, `howto-step-indicator`, `howto-dots`,
`howto-caption`. **New:** `howto-gamestart-toast` (the game-started pill).

---

## 5. State Model

Unchanged from #122 except the new enum-only phase signal. Everything remains
**in-memory, component-local, ephemeral**; nothing is persisted or sent to the
backend, and the walkthrough **never reads live game state** (LLD 111 decision 7 —
architecture principles 1 & 2).

| State | Owner | Lifetime |
|---|---|---|
| `walkthroughOpen` | `HelpCluster` (`ref`) | App-shell lifetime (whole session) |
| `onBoard` | `HelpCluster` (computed from route) | Reactive to route |
| `isNarrow` | `HelpCluster` (`ref` from `matchMedia`) | Reactive to viewport |
| `gameStartToast` | `HelpCluster` (`ref`, 3s timer) | Ephemeral, only while game-start fires during open |
| `gamePhase` | `useFeedbackContext` singleton (**existing, enum only**) | Set by `GameView`'s existing `watch(displayPhase)`; cleared on unmount. **Not added by this LLD** |
| `currentIndex` | `WalkthroughModal` (`ref`) | Per modal open (unchanged) |
| lobby list / room code / Start / socket / game state / turn timer | `GameView` + composables | **Untouched by this LLD** |

Game-start flow while open:

```
GameView watch(displayPhase): CREATED -> IN_PROGRESS
    ==> setGamePhase("in-progress")  [EXISTING feedback-context wiring, unchanged]
HelpCluster watch(gamePhase): (open && "lobby" -> "in-progress") ==> gameStartToast = true (3s)
Board renders under the still-open modal (router-view child swap, modal not remounted)
User closes modal (X / scrim / Esc / "Got it") ==> walkthroughOpen = false ==> full board freed
```

No live hand/board/socket data enters `HelpCluster` — only the existing
`useFeedbackContext.gamePhase` enum and the route path. The extracted
`clusterPlacement.ts` helper is held to this bar by the source-scan test (§7.1).

---

## 6. Edge Cases

| # | Case | Handling |
|---|---|---|
| E1 | (?) FAB overlaps Play/Pass (Big2) or Discard/Draw/TONK (Tonk) on the board | `.help-cluster--board` lifts `bottom` above the 64px action row (desktop) / `--mobile-actions-height` (mobile). Verified against both boards' `grid-template-rows`. Acceptance headline. |
| E2 | Cluster crowds the player's own hand on mobile board | On `onBoard && isNarrow` the bug icon is hidden (single (?) FAB) and the cluster is raised above the action row, so the hand keeps full width. |
| E3 | Cluster collides with the mobile log-toggle (`top:60px; right:8px`, z-index 200) | Cluster is bottom-anchored; the board offset raises it only to just above the action row, nowhere near `top:60px`. No collision at any width. z-index 1000 keeps it above felt/rim (100) and log-toggle (200) but below scrims (1100+). |
| E4 | Game starts (lobby→board) while the walkthrough is open | Modal is App-shell-mounted → not remounted; board swaps underneath. User not trapped (X/scrim/Esc/"Got it" all close) and transition not blocked. Non-blocking ~3s toast (`howto-gamestart-toast`, `pointer-events:none`) signals the start; it never auto-closes the modal. |
| E5 | Open/close from the lobby | `walkthroughOpen` is a local `ref`; the modal imports no game state/socket. Player list, room code, Start button, and socket are owned by `GameView` and untouched. Verified by e2e (§7.2). |
| E6 | Open/close from the live board | Same isolation as E5; additionally the closed scrim is `v-if`-removed (`inset:0` only while open), so board interaction and turn timers are never blocked when closed. Turn timer is server-authoritative (`turnDeadline` in state) — the client modal cannot affect it. |
| E7 | Closing returns the user exactly where they were | The underlying view is never unmounted (App-shell mount), so its scroll/selection/state persist; closing only removes the overlay. |
| E8 | FAB open, user rotates / resizes across the 767px board breakpoint | `isNarrow` is reactive (`matchMedia` listener); the cluster re-lays out and the bug icon appears/hides live, matching the board's own grid switch (same breakpoint). |
| E9 | Board offset accidentally applied to the modal scrim | Guarded: modifier classes apply to `.help-cluster` only; the scrim (`WalkthroughModal`) is `inset:0` and unmodified. Asserted structurally (§7.1) so a closed modal frees the whole board and an open modal always covers the full viewport. |
| E10 | Rematch navigation `/game/<old>` → `/game/<new>` while cluster mounted | `onBoard` stays true across the change (both match `/game/:id`); the old `GameView` unmounts (fires `clearGamePhase()` → `gamePhase` = `undefined`) then the new `GameView` mounts and its `immediate` `watch(displayPhase)` sets `"lobby"`. So the enum transits `"in-progress"` → `undefined` → `"lobby"`. The toast fires **only** on the `"lobby"` → `"in-progress"` edge, so no `undefined`/`"lobby"` intermediate can spuriously fire it. A toast can legitimately re-appear only if a genuine new CREATED→IN_PROGRESS start occurs while the modal is still open (e.g. rematch lands in a fresh lobby that then starts) — which is the intended behavior. Cluster placement unaffected. |
| E11 | Non-game surface (home/create/stats/game-over) | `onBoard` false → resting corner, both buttons — identical to #122. `gamePhase` is `undefined` there (no `GameView` mounted), so no `"lobby"` → `"in-progress"` edge and no toast can fire. |
| E12 | Feedback modal open on the board | Existing `feedbackOpen` hides the whole cluster while the feedback modal is open (unchanged #122 behavior); board offset is irrelevant while hidden. |
| E13 | `env(safe-area-inset-bottom)` unsupported (older browsers) | `env(…, 0px)` fallback → offset degrades to the plain action-row clearance; still clears the action row. |
| E14 | Reduced motion | Toast fade + FAB transitions disabled under `prefers-reduced-motion: reduce`, matching existing components. |
| E15 | Game-start toast timer leak on unmount / rapid re-open | `toastTimer` is cleared before re-arming and on the reduced-motion path; `HelpCluster` lives for the session so no unmount leak, but the timer is still guarded. |
| E16 | Big2 SHOW_FINAL_PLAY reveal (blurred board + reveal layer, z-index 101) | Cluster (z-index 1000) sits above the reveal scrim; acceptable — the (?) remains available. No toast fires (phase is already `"in-progress"`; SHOW_FINAL_PLAY also maps to `"in-progress"`, so no new `"lobby"` → `"in-progress"` edge). Placement unchanged (still `onBoard`). |

---

## 7. Test Requirements

Follow the #122/#123 pattern: **node-env vitest** for pure logic (no jsdom / no
`@vue/test-utils`), **Playwright e2e** for rendered behavior. Extend the existing
`tests/frontend/walkthroughs.test.ts` and `e2e/howto-walkthrough.spec.ts` rather
than adding new harnesses.

### 7.1 Unit tests (vitest, node env)

- **Surface-placement pure helper:** extract the placement decision as a pure
  function (mirroring `stepNav.ts` extraction) — e.g.
  `clusterPlacement(path: string, isNarrow: boolean): { onBoard; collapseBug }` —
  and test: board path + narrow → `onBoard && collapseBug`; board path + wide →
  `onBoard && !collapseBug`; non-board path → `!onBoard && !collapseBug`; rematch
  path `/game/abc` and `/game/xyz` both → `onBoard`.
- **Game-start toast trigger reducer:** extract the "should the toast fire?"
  predicate as a pure function of
  `(walkthroughOpen, prevPhase, nextPhase)` over the existing `FeedbackGamePhase`
  enum (`"lobby" | "in-progress" | "game-over" | undefined`), and test: fires only
  on `open && "lobby" → "in-progress"`; does not fire when closed; does **not** fire
  on `undefined → "lobby"`, `"in-progress" → undefined`, `"lobby" → undefined`, or
  `"in-progress" → "game-over"`. This directly covers the E10 rematch remount
  ordering (`"in-progress"` → `undefined` → `"lobby"` produces no fire).
- **Information-hiding source-scan (decision 7):** add the extracted
  `clusterPlacement.ts` helper to the existing #122 `MODULE_FILES` forbidden-import
  scan (which currently lists only the leaf content/nav modules, not
  `HelpCluster.vue`) and assert it imports nothing from a live-state source
  (`useGameState`, `useSocket`, `socket-events`, `EnrichedPlayerView`,
  `gameSpecificPublicState`, `useGameActions`). This is the automated security guard
  for the client-only placement/toast logic. `useFeedbackContext` is **not** in the
  forbidden list — it is itself an enum-only shell bridge, so `HelpCluster`
  consuming it does not weaken decision 7.
- **No new phase-signal composable to test:** the game-start signal reuses the
  existing `useFeedbackContext.gamePhase`, which #122 already covers. This LLD adds
  no `useCurrentGameType` phase field, so no new composable-level test is needed
  there; `useCurrentGameType` remains gameType-enum-only.

### 7.2 E2E tests (Playwright) — extend `e2e/howto-walkthrough.spec.ts`

Use the real UI/join flow and the existing seed helpers (`seedGameState`,
`buildTonkSeedState`) already imported in the spec — do **not** inject cookies
manually (per project convention).

- **Board offset (Big2 + Tonk, desktop):** on the live board, open the walkthrough;
  assert the action-row controls (`ActionPanel` Play/Pass; Tonk action buttons) and
  the (?) FAB are both visible and their bounding boxes do **not** overlap.
- **Mobile board collapse:** at the project's mobile viewport, on the board, assert
  `howto-fab` is visible and the `feedback-trigger` bug icon is **not** visible
  (single-FAB collapse); the (?) FAB does not overlap the hand row or the action
  row.
- **Non-board surfaces unchanged:** on home/lobby, both `howto-fab` and
  `feedback-trigger` are visible at all tested widths (resting corner).
- **Open/close preserves lobby state (E5):** in the lobby, open then close the
  walkthrough; assert the player list, `join-code-chip`, and `start-game-button`
  are unchanged and still present, and the socket-fed lobby count is intact.
- **Open/close preserves board state (E6):** on the board, open then close; assert
  the hand, action panel, and turn indicator are intact and interactive after close
  (e.g. a card can be selected / an action button is enabled when it is the
  player's turn).
- **Game-starts-while-open (E4):** open the walkthrough in the lobby, then start
  the game (host flow); assert (a) `howto-gamestart-toast` appears, (b) the modal
  stays open (user not trapped), (c) the board (`game-board`/`tonk-board`) is
  present underneath, and (d) after closing the modal the board is fully
  interactive.
- **Regression:** the existing #122/#123 walkthrough e2e (step nav, close via
  X/scrim/Esc, Tonk resolution + joker render) still pass unmodified.

`e2e/feedback.spec.ts` must still pass; the bug icon keeps `feedback-trigger` and is
hidden only on the mobile board (adjust that spec only if it asserts the bug icon on
a board-mobile viewport — otherwise unchanged).

### 7.3 Manual verification (exception — visual only, per testing-principles)

- On desktop and mobile, the cluster reads as a single unit, clears Play/Pass and
  the hand on both boards, and matches the #122 visual language (dark felt, gold
  accent) — against the shipped cluster.
- The game-start toast is legible, non-blocking, and auto-dismisses (~3s) on both
  boards.

---

## 8. Dependencies

All present on this branch (both dependencies merged):

- `src/frontend/component/howto/HelpCluster.vue` — surface awareness + toast added here; consumes route, `matchMedia`, and the existing `useFeedbackContext.gamePhase` (#122).
- `src/frontend/component/howto/WalkthroughModal.vue` — reused verbatim; asserted unmodified except that its scrim stays `inset:0` (#122).
- `src/frontend/composables/useFeedbackContext.ts` — **reused verbatim, not modified**; its existing enum-only `gamePhase` is the game-start signal `HelpCluster` reads.
- `src/frontend/composables/useCurrentGameType.ts` — **not modified**; continues to carry only the `gameType` enum (an earlier draft's `gamePhase` addition was rejected — see §4.1 collision note).
- `src/frontend/component/game/GameView.vue` — **not modified**; its existing `watch(displayPhase) → setGamePhase(toFeedbackPhase(phase))` and `clearGamePhase()` on unmount already drive the phase enum this LLD consumes.
- `src/frontend/component/game/GameBoard.vue`, `TonkBoard.vue` — read-only context for the action-row height / breakpoint the offset targets; **not modified**.
- `src/frontend/component/App.vue` — already mounts `HelpCluster` once after `<router-view>`; **not modified**.
- `src/frontend/styles/game-variables.css` — `--mobile-actions-height`, `--panel-bg`, `--gold-accent` (reused, not changed).
- `docs/lld/111-howto-walkthrough-shell-big2.md`, `docs/lld/115-howto-walkthrough-tonk-content-entry.md` — upstream contracts (shell, entrypoint, content).

No backend, engine, transport, migration, shared-model, or content change.

NOT modified (reused verbatim — modifying any of these signals a mis-scoped slice):
`WalkthroughScene.vue`, `walkthroughs.ts`, `big2Walkthrough.ts`, `tonkWalkthrough.ts`,
`walkthroughTypes.ts`, `stepNav.ts`, `GameCard.vue`, `FeedbackWidget.vue`.

---

## 9. File Organization

```
Modified files:
  src/frontend/component/howto/HelpCluster.vue      -- onBoard/isNarrow placement classes, mobile bug-icon collapse, game-start toast (reads existing useFeedbackContext.gamePhase)
  tests/frontend/walkthroughs.test.ts               -- placement helper, toast-trigger reducer, extended source-scan (add clusterPlacement.ts to MODULE_FILES)
  e2e/howto-walkthrough.spec.ts                      -- board offset, mobile collapse, state-preservation, game-start toast

New files (small extracted pure helpers, node-testable — implementer's discretion):
  src/frontend/component/howto/clusterPlacement.ts   -- pure placement + toast-trigger logic (kept live-state-free for the source-scan)

NOT modified (reused verbatim):
  src/frontend/composables/useCurrentGameType.ts     -- gameType enum only; NO gamePhase added (collision — §4.1)
  src/frontend/composables/useFeedbackContext.ts     -- existing gamePhase enum is the game-start signal
  src/frontend/component/game/GameView.vue           -- existing watch(displayPhase)+clearGamePhase already drive the enum
  src/frontend/component/howto/WalkthroughModal.vue, WalkthroughScene.vue,
  walkthroughs.ts, big2Walkthrough.ts, tonkWalkthrough.ts, walkthroughTypes.ts,
  stepNav.ts, GameCard.vue, FeedbackWidget.vue, App.vue,
  src/frontend/component/game/GameBoard.vue, TonkBoard.vue
```
