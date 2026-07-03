# LLD 126: Bug report / feedback button missing on the in-game screen

Restores the bug-report / feedback trigger on the **mobile game board**
(`/game/:gameId`, ≤767px), which LLD 117 intentionally collapsed away. On a
narrow board today the `HelpCluster` shows only the how-to-play `?` FAB and hides
the bug icon (`data-testid="feedback-trigger"`) — the sole feedback entrypoint in
the app — so a mobile player in a game cannot report a bug.

**Approved direction: Option B (owner override 2026-07-03).** Keep **both** FABs
on the mobile board by reversing the LLD 117 collapse, but **shrink the bug icon**
and **tighten the cluster gap** so the second FAB fits without re-crowding the
hand or overlapping the Play/Pass action row. This supersedes the
frontend-architect's Option A (board overflow menu) recommendation. Do **not**
implement a board menu, and do **not** re-litigate the direction.

Reference mockup: `docs/mockups/mobile-board-feedback-affordance.html` (Option B),
on branch `lld-124-mobile-board-feedback-affordance`.

---

## 1. Scope

### In scope

- **Un-collapse the bug icon on the mobile board.** On `/game/:gameId` at ≤767px,
  the `HelpCluster` shows both the `?` FAB and the bug icon (the feedback
  trigger), matching desktop-board behaviour.
- **Compact mobile-board layout.** So the second FAB does not re-introduce the
  crowding LLD 117 removed: shrink the bug FAB (46/40px → smaller token per the
  mockup) and tighten the cluster gap on the mobile board, while keeping the
  cluster lifted above the action row (the existing `.help-cluster--board-mobile`
  offset is retained).
- **Keep the placement helper pure.** `clusterPlacement.ts` stays live-state-free
  and guarded by the walkthrough source-scan test (LLD 111 decision 7). The
  `collapseBug` decision is retired (always `false`) or repurposed — see §2.2.
- **Preserve game-context metadata.** Opening feedback from the mobile board still
  populates `route`, `gameId`, `gamePhase` via `FeedbackWidget.buildMetadata()` —
  no change to the metadata path (LLD 91).
- **Update the tests that assert the old collapse:** `walkthroughs.test.ts`
  (`clusterPlacement` narrow-board case) and the `howto-walkthrough.spec.ts`
  mobile-board e2e that asserts the bug icon is hidden.

### Explicitly NOT in scope

- **Any Option A / Option C UI** (board overflow menu; "Report a bug" link folded
  into the walkthrough footer). Both were considered in the mockup and rejected by
  the owner in favour of Option B. Do not build them.
- **The desktop board and all non-board surfaces** (home, lobby, create-game,
  stats, game-over) — their cluster is unchanged; no regression permitted.
- **The `FeedbackWidget` modal, its submit flow, `buildMetadata()`, or the
  `useFeedbackContext` phase signal** — reused verbatim (LLD 91 / LLD 117). The
  metadata path is not touched.
- **The game-start toast** (LLD 117 §2.4) — unchanged and unrelated.
- **The walkthrough content / modal / step nav** (`WalkthroughModal.vue`,
  `walkthroughs.ts`, `stepNav.ts`, etc.) — untouched.
- Any backend, engine, transport, migration, or shared-model change. This is a
  frontend presentation change (CSS + one `v-if`/helper edit) plus test updates.

---

## 2. Approach

### 2.1 The defect and the fix in one sentence

The suppression lives at `clusterPlacement.ts:28`
(`collapseBug = onBoard && isNarrow`), consumed by `HelpCluster.vue:112`
(`v-if="!collapseBug"` on the bug button). Removing the suppression brings the
bug icon back on the mobile board; the *real work* is the sizing/spacing so the
second FAB fits above the action row without touching the hand — verified, not
assumed (see §2.3, the core tension).

### 2.2 What happens to `collapseBug` (keep the helper's purity contract)

`clusterPlacement.ts` is a pure module guarded by the source-scan test's
`MODULE_FILES` list (LLD 111 decision 7; LLD 117 §2.3). Its purity contract must
stay intact — it imports nothing from live state.

**Decision: retire `collapseBug` by making it always `false`, and remove the
`isNarrow` parameter** from `clusterPlacement`. Rationale: after Option B the bug
icon shows on the board at every width, so the narrow-board special case no longer
exists. `onBoard` is still needed (it drives the board offset classes), but
`isNarrow` is now consumed **only** for the compact-layout CSS class, not for
show/hide logic. Keeping a dead `collapseBug` field would be a speculative
abstraction (CLAUDE.md §2).

Two valid shapes, with the recommendation:

- **(A, recommended) Drop `collapseBug` and `isNarrow` from the helper.**
  `clusterPlacement(path): { onBoard }`. `HelpCluster.vue` keeps its own
  `isNarrow` ref (from `matchMedia`) purely to toggle the compact CSS class; the
  helper no longer decides visibility. Simplest, matches "no speculative
  fields". The bug `v-if` is removed entirely (icon always rendered in the
  cluster).
- **(B) Keep the signature, hard-code `collapseBug: false`.** Smaller diff to the
  helper, but leaves a permanently-false field and an unused branch — rejected as
  dead code.

Recommend **(A)**. Either way, the helper still imports nothing from live state,
so the source-scan test continues to pass; its `clusterPlacement` unit
expectations are updated (§7.1).

> Implementer note: the `ClusterPlacement` interface and `clusterPlacement`
> signature change (dropping `collapseBug`/`isNarrow`) is an interface edit — if
> anything beyond `HelpCluster.vue` and `walkthroughs.test.ts` imports them, stop
> and flag. A grep confirmed only those two consume it today.

### 2.3 CORE TENSION: fit the second FAB without re-crowding (must be measured)

The frontend-architect explicitly warned that Option B "reintroduces the exact
mobile crowding LLD 117 §2.2 removed." The acceptance criteria are the
non-negotiable guardrails, and the compact layout must be **measured** against the
mobile action row and hand at ≤767px, not assumed:

1. **No overlap with the Play/Pass action row.** The cluster stays bottom-anchored
   and lifted by the existing `.help-cluster--board-mobile` offset
   (`bottom: calc(var(--mobile-actions-height) + 12px + safe-area)`), which already
   clears the 56px action row. Adding a second (shorter) FAB above the `?` grows
   the cluster *upward* (it is `flex-direction: column-reverse`), away from the
   action row — so the offset that already clears Play/Pass still holds. The e2e
   overlap assertion (§7.2) proves this rather than trusting it.
2. **Do not shrink the hand.** The cluster is `position: fixed` and is **not** a
   grid cell of the board; it overlays the bottom-right corner. It never
   participates in `grid-template-rows`, so it cannot resize the `hand` row. The
   risk is *visual occlusion* of the right edge of the hand, not layout resizing.
   The mockup mitigates this by (a) shrinking the bug FAB and (b) tightening the
   gap, keeping the cluster's footprint small in the bottom-right corner where the
   hand cards fan from the left. The e2e hand-occlusion assertion (§7.2, reused
   from the existing spec) proves the FAB boxes stay disjoint from the rendered
   hand cards.

The compact sizing from the Option B mockup (authoritative):

| Element | Non-board / desktop-board (unchanged) | Mobile board (Option B, new) |
|---|---|---|
| `?` FAB | 46px | 42px |
| bug FAB | 40px | 32px |
| cluster `gap` | 10px | 9px |

These are the mockup's values; the implementer may nudge within ±2px if the e2e
overlap/occlusion checks demand it, but must not go below a ~36px effective tap
target for the `?` FAB or ~32px for the bug FAB (the mockup's floor).

### 2.4 Metadata path is preserved by construction

Opening feedback from the restored bug icon calls the same
`feedback.value?.open()` (`HelpCluster.vue:79-81`) → `FeedbackWidget.openModal()`
→ `buildMetadata()` path used on desktop. `buildMetadata()` already reads
`route.fullPath`, `route.params.gameId`, and `useFeedbackContext().gamePhase`
(LLD 91). Because the trigger and the widget are unchanged and the widget is
App-shell-mounted, the mobile-board submission carries `route`, `gameId`, and
`gamePhase` identically to today. No metadata code changes; an e2e assertion
(§7.2) confirms the modal opens from the mobile board.

### 2.5 Reuse the shipped visual language

No new colors, fonts, radii, shadows, or icons. The bug icon SVG and the
`.help-fab--bug` styling are the shipped LLD 111/117 chrome; Option B only reduces
sizes and the gap **on the mobile board**, gated behind the existing
`.help-cluster--board-mobile` modifier so desktop-board and non-board sizing are
untouched. Reduced-motion and the existing hover transitions are unchanged.

---

## 3. Frontend Design

**Option B (approved).** On the mobile game board the cluster shows both FABs:
the `?` help FAB (top) and a compact bug FAB (bottom), lifted above the action
row. Everywhere else the cluster is pixel-identical to today.

### 3.1 Cluster placement matrix (delta from LLD 117 §3.1 in **bold**)

| Surface | Width | Cluster position | Buttons shown |
|---|---|---|---|
| home / create-game / lobby / stats / game-over | any | `right:16px; bottom:16px` (unchanged) | `?` + bug |
| live board (Big2/Tonk) | desktop (>767px) | `bottom: calc(64px + 16px + safe-area)` (unchanged) | `?` + bug |
| live board (Big2/Tonk) | mobile (≤767px) | `bottom: calc(var(--mobile-actions-height) + 12px + safe-area)` (unchanged) | **`?` + bug (both shown, compact)** |

The only change is the last row: mobile board now shows **both** buttons (was
`?` only), and the mobile-board cluster uses compact sizing/gap (§2.3).

### 3.2 Compact mobile-board CSS (additions, existing tokens only)

Scoped under the existing `.help-cluster--board-mobile` modifier so it applies
only on the mobile board:

```css
/* mobile board (Option B): shrink FABs + tighten gap so the restored bug icon
   fits above the action row without crowding the hand. */
.help-cluster--board-mobile {
  gap: 9px; /* was 10px */
}
.help-cluster--board-mobile .help-fab {
  width: 42px;  /* was 46px */
  height: 42px;
}
.help-cluster--board-mobile .help-fab--bug {
  width: 32px;  /* was 40px */
  height: 32px;
}
```

The bug-icon `v-if="!collapseBug"` is removed (§2.2 option A), so the bug button
always renders inside the cluster. The compact rules do not touch the desktop or
non-board cluster (which keeps 46/40px, gap 10px).

### 3.3 Mockup gate

Satisfied. The owner approved Option B directly against
`docs/mockups/mobile-board-feedback-affordance.html` (branch
`lld-124-mobile-board-feedback-affordance`). Option B introduces **no new UI
chrome** — it restores the already-shipped bug FAB and only adjusts its
mobile-board size/gap. No new mockup round is required.

---

## 4. Interfaces / Types

### 4.1 `clusterPlacement.ts` — retire the collapse decision (recommended shape A)

```typescript
export interface ClusterPlacement {
  // Over a live board (/game/<id>) — apply the board offset classes.
  onBoard: boolean;
  // collapseBug REMOVED — the bug icon now shows on the board at every width.
}

export function clusterPlacement(path: string): ClusterPlacement {
  return { onBoard: BOARD_PATH.test(path) };
}
```

`shouldFireGameStartToast(...)` is **unchanged** (unrelated to this LLD). The
module still imports only `FeedbackGamePhase` (a type) and the `BOARD_PATH` regex
— no live-state imports, so the source-scan test (§7.1) passes.

### 4.2 `HelpCluster.vue` — deltas only

- Drop `collapseBug` from the `placement` destructuring/computed; keep `onBoard`.
- Keep the local `isNarrow` ref (from `matchMedia("(max-width: 767px)")`) — it now
  feeds **only** the compact CSS class, not visibility.
- Board-mobile class stays driven by `onBoard && isNarrow`:
  `:class="{ 'help-cluster--board': onBoard, 'help-cluster--board-mobile': onBoard && isNarrow }"`.
- Bug button: **remove** `v-if="!collapseBug"` so it always renders. All other
  bug-button attributes are unchanged, critically `data-testid="feedback-trigger"`
  and `@click="openFeedback"`.
- Add the compact CSS rules from §3.2 to the scoped `<style>`.

No prop changes. The `?` FAB, feedback wiring (`openFeedback` → `feedback.open()`),
`feedbackOpen` hide behaviour, walkthrough modal mount, and the game-start toast
are all unchanged.

### 4.3 `data-testid` contract

Unchanged. The restored bug button keeps `data-testid="feedback-trigger"`; the
modal it opens is `data-testid="feedback-modal"`. No new test ids.

---

## 5. State Model

Unchanged from LLD 117. Everything remains in-memory, component-local, and
ephemeral; nothing is persisted or sent to the backend, and the cluster/helper
never read live game state.

| State | Owner | Lifetime | Change in this LLD |
|---|---|---|---|
| `onBoard` | `HelpCluster` (computed from route via helper) | Reactive to route | Unchanged |
| `isNarrow` | `HelpCluster` (`ref` from `matchMedia`) | Reactive to viewport | Now feeds CSS class only (not visibility) |
| `collapseBug` | `clusterPlacement` (was `onBoard && isNarrow`) | — | **Removed** |
| `walkthroughOpen`, `gameStartToast`, `gamePhase` | as LLD 117 | as LLD 117 | Unchanged |
| feedback modal open/submit/metadata | `FeedbackWidget` (LLD 91) | Per open | Unchanged |

Feedback-open flow from the mobile board (all pre-existing wiring):

```
User taps bug FAB (feedback-trigger, now visible on mobile board)
  → HelpCluster.openFeedback() → FeedbackWidget.open() → openModal()
  → user submits → buildMetadata() reads route.fullPath, route.params.gameId,
    useFeedbackContext().gamePhase  [LLD 91, unchanged]
  → POST /api/feedback with full game-context metadata
```

---

## 6. Edge Cases

| # | Case | Handling |
|---|---|---|
| E1 | Restored bug FAB overlaps Play/Pass (Big2) / Discard/Draw/TONK (Tonk) on the mobile board | Cluster is `column-reverse`, bottom-anchored, lifted by `.help-cluster--board-mobile` (`bottom: calc(--mobile-actions-height + 12px + safe-area)`). The second FAB grows the stack **upward**, away from the 56px action row. **Verified** by the e2e overlap assertion (§7.2), not assumed — this is the core-tension guardrail. |
| E2 | Compact cluster occludes the player's hand on the narrowest screens | Cluster is `position: fixed`, not a grid cell — it cannot resize the `hand` row. Shrunk FABs (42/32px) + tighter gap keep the footprint in the bottom-right corner; hand cards fan from the left. **Verified** by the e2e hand-occlusion assertion (§7.2). |
| E3 | Desktop board | `.help-cluster--board-mobile` not applied (`isNarrow` false) → 46/40px, gap 10px, both FABs — identical to today. No regression. |
| E4 | Non-board surfaces (home/lobby/create-game/stats/game-over) | `onBoard` false → resting corner, both FABs, full-size — identical to today. No regression. |
| E5 | Rotate / resize across the 767px breakpoint while on the board | `isNarrow` is reactive (`matchMedia` listener); compact CSS toggles live at the same width as the board's own mobile grid switch. Bug icon stays visible either way (no more show/hide flip). |
| E6 | Feedback opened from the mobile board carries game context | `buildMetadata()` reads `route.fullPath`, `route.params.gameId`, `gamePhase` — unchanged path (LLD 91). Confirmed by e2e (§7.2). |
| E7 | Feedback modal open on the board | Existing `feedbackOpen` still hides the whole cluster while the feedback modal is up (unchanged LLD 111 behaviour). |
| E8 | Tap-target size on the shrunk 32px bug FAB | 32px is the mockup floor; the SVG + padding keep it tappable. If the e2e/manual check finds it too small, the implementer may nudge to ≤36px within §2.3 bounds — but not re-collapse it. |
| E9 | `env(safe-area-inset-bottom)` unsupported | `env(…, 0px)` fallback → offset degrades to plain action-row clearance; still clears the action row (unchanged from LLD 117). |
| E10 | SHOW_FINAL_PLAY reveal (Big2) | Cluster (z-index 1000) still above the reveal scrim; both FABs remain reachable. Placement unchanged. |

---

## 7. Test Requirements

Follow the LLD 117 pattern: **node-env vitest** for the pure helper, **Playwright
e2e** for rendered behaviour. Extend the existing
`tests/frontend/walkthroughs.test.ts` and `e2e/howto-walkthrough.spec.ts` — do not
add new harnesses.

### 7.1 Unit tests (vitest, node env) — `tests/frontend/walkthroughs.test.ts`

- **`clusterPlacement` narrow-board expectation must be updated** (currently
  `expect(clusterPlacement("/game/abc123", true)).toEqual({ onBoard: true,
  collapseBug: true })`, ~lines 258-261). After Option B:
  - If shape A (recommended, `collapseBug`/`isNarrow` dropped): assert
    `clusterPlacement("/game/abc123")` → `{ onBoard: true }`, and non-board paths →
    `{ onBoard: false }`. Remove the now-meaningless `collapseBug`/narrow cases.
  - The rematch (`/game/abc`, `/game/xyz` → `onBoard`) and nested-path
    (`/game/abc/extra` → not board) assertions are retained.
- **Source-scan (decision 7) unchanged and must still pass:** `clusterPlacement.ts`
  stays in `MODULE_FILES` and imports nothing from a live-state source. No change
  needed beyond keeping the file pure.
- **`shouldFireGameStartToast` tests unchanged** (unrelated to this LLD; must still
  pass).

### 7.2 E2E tests (Playwright) — `e2e/howto-walkthrough.spec.ts` (+ `feedback.spec.ts`)

- **INVERT the existing mobile-board collapse test** (currently
  `"mobile board: the cluster collapses to a single (?) FAB (bug icon hidden)"`,
  ~line 603, which asserts `feedback-trigger` `.not.toBeVisible()`). Rewrite it so
  on the seeded Big2 mobile board (375×667):
  - both `howto-fab` **and** `feedback-trigger` are visible (bug icon restored);
  - the `?` FAB's bounding box is **disjoint** from the `.action-panel` box (no
    Play/Pass overlap — E1);
  - the bug FAB's bounding box is **also disjoint** from the `.action-panel` box;
  - **neither** FAB box overlaps any `.player-hand__card` box (no hand occlusion —
    E2; reuse the existing card-box disjoint loop).
- **Add a "feedback opens from the mobile board" assertion** (E6): tap
  `feedback-trigger` on the mobile board and assert `data-testid="feedback-modal"`
  becomes visible. (Metadata population itself is covered by LLD 91 unit tests;
  this proves reachability from the mobile board.)
- **Desktop board unchanged:** the existing desktop board-offset tests (both FABs
  visible, no overlap) still pass unmodified.
- **Non-board surfaces unchanged:** the existing "non-board surfaces show both …"
  and "keep both buttons at mobile width" tests still pass unmodified.
- **`e2e/feedback.spec.ts`:** must still pass. It exercises `feedback-trigger` on
  non-board surfaces; unaffected. If any assertion there depends on the
  board-mobile bug icon being hidden, update it to reflect Option B (a grep shows
  it does not today).

### 7.3 Manual verification (exception — visual only, per testing-principles §Decision Heuristics)

- On a real/emulated mobile board (≤767px), the compact two-FAB cluster reads as a
  single unit, both FABs are comfortably tappable, and neither obscures the hand or
  the Play/Pass row on Big2 and the Discard/Draw/TONK row on Tonk.
- The compact cluster matches the shipped visual language (dark felt, gold accent,
  bug SVG) — only smaller.

---

## 8. Dependencies

All present on this branch:

- `src/frontend/component/howto/clusterPlacement.ts` — `collapseBug` retired here;
  kept pure (source-scan).
- `src/frontend/component/howto/HelpCluster.vue` — bug-icon `v-if` removed; compact
  mobile-board CSS added here.
- `src/frontend/component/FeedbackWidget.vue` — **not modified**; its `open()` and
  `buildMetadata()` (route/gameId/gamePhase) are reused verbatim.
- `src/frontend/composables/useFeedbackContext.ts` — **not modified**; supplies
  `gamePhase` to `buildMetadata()`.
- `src/frontend/styles/game-variables.css` — `--mobile-actions-height` reused; not
  changed.
- `tests/frontend/walkthroughs.test.ts` — `clusterPlacement` narrow-board case
  updated.
- `e2e/howto-walkthrough.spec.ts` — mobile-board collapse test inverted + feedback-
  open assertion added.
- Upstream contracts (read-only): `docs/lld/117-howto-walkthrough-fab-hardening.md`
  (the collapse this reverses), `docs/lld/91-feedback-rendered-view-context-metadata.md`
  (the metadata path preserved).

NOT modified (reused verbatim — modifying any signals a mis-scoped slice):
`WalkthroughModal.vue`, `WalkthroughScene.vue`, `walkthroughs.ts`,
`big2Walkthrough.ts`, `tonkWalkthrough.ts`, `stepNav.ts`, `GameView.vue`,
`GameBoard.vue`, `TonkBoard.vue`, `App.vue`, `useCurrentGameType.ts`.

No backend, engine, transport, migration, shared-model, or content change.

---

## 9. File Organization

```
Modified files:
  src/frontend/component/howto/clusterPlacement.ts  -- retire collapseBug (+ isNarrow param); keep pure
  src/frontend/component/howto/HelpCluster.vue       -- remove bug-icon v-if; add compact .help-cluster--board-mobile FAB/gap CSS
  tests/frontend/walkthroughs.test.ts                -- update clusterPlacement narrow-board expectation
  e2e/howto-walkthrough.spec.ts                       -- invert mobile-board collapse test; assert both FABs, no overlap/occlusion, feedback-modal opens

NOT modified (reused verbatim):
  src/frontend/component/FeedbackWidget.vue          -- open() + buildMetadata() metadata path unchanged
  src/frontend/composables/useFeedbackContext.ts     -- gamePhase signal unchanged
  src/frontend/component/game/GameView.vue, GameBoard.vue, TonkBoard.vue, App.vue
  src/frontend/component/howto/WalkthroughModal.vue, WalkthroughScene.vue,
  walkthroughs.ts, big2Walkthrough.ts, tonkWalkthrough.ts, stepNav.ts
```
