# LLD 111: How-to-play walkthrough — content-rendering shell + Big2 content + persistent (?) FAB entrypoint

Parent: #95 (order 1 of 3). Foundation slice: a reusable declarative walkthrough
shell, the first game's content (Big2), and a single persistent (?) entrypoint —
enough to ship a working, testable walkthrough end to end. #123 (Tonk content) and
#124 (surface hardening + more entrypoints) are pure follow-ups built on this.

The visual direction is already approved (mockup gate SATISFIED — do NOT re-run it):
`docs/mockups/howto-walkthrough-shell-big2-create-game-entrypoint.html` on branch
`lld-110-howto-walkthrough-shell-big2-create-game-entrypoint`. This LLD follows
**Direction A (modal/lightbox)** and the **persistent bottom-right (?) + bug
cluster** shown there.

---

## 1. Scope

### In scope

- A declarative, `gameType`-keyed content model: `WALKTHROUGHS[gameType] = Step[]`.
  Each step is `{ scene, title, caption }`. Adding a future game is a pure data
  entry — no rendering-code change.
- A modal/lightbox **walkthrough shell** component that renders an ordered
  sequence of steps with dot indicator + "Step X of N" + Back/Next, and closes
  via X / scrim / Esc. Overlays the current view; **no route change, no URL change.**
- Full **Big2 walkthrough content** (~6 steps), rendered end to end.
- A **persistent bottom-right (?) FAB**, mounted in the app shell (App.vue,
  alongside the existing FeedbackWidget), that opens the walkthrough for the
  **current `gameType`**.
- **FeedbackWidget consolidation**: the existing bottom-right feedback control is
  reconciled into a single bottom-right cluster — the (?) help FAB plus the feedback
  control rendered as a bug icon beside it. All existing feedback functionality is
  preserved (placement/affordance change only).
- Scenes rendered from **real card/board components** (`GameCard.vue`) with static
  hard-coded fixture props (anti-rot Option 1). No committed PNGs, no capture step,
  no CI job.
- Mobile-viewport support for the modal, the (?) FAB, and the bug icon
  (single-column, full-height modal, ~44px tap targets).

### Explicitly NOT in scope

- Live guided overlay on a running game (highlighting real board elements).
- Video, animation, or localization of walkthrough content.
- Auto-launch for first-time players (no persisted "seen" flag).
- **Tonk content** (#123) — this LLD ships only the Big2 entry in `WALKTHROUGHS`.
- **FAB open/close edge-case hardening across surfaces** (#124): behavior when a
  game starts while the modal is open, state preservation across route changes,
  lobby-vs-mid-game entrypoint nuance. This slice ships the single persistent FAB;
  robustness of that FAB across every surface transition is deferred.
- A CreateGameView game-type-selector entrypoint (owner explicitly rejected it;
  the persistent FAB is the ONLY entrypoint in this slice).
- Any backend, engine, or persistence change. This is a frontend-only feature.

---

## 2. Approach

### Key technical decisions

1. **Declarative content, keyed by `gameType`.** A single module
   `src/frontend/component/howto/walkthroughs.ts` exports
   `WALKTHROUGHS: Record<GameType, Step[]>`. The shell reads
   `WALKTHROUGHS[gameType]` and renders it generically. This mirrors GameView's
   `gameState.gameType === 'tonk' ? TonkBoard : GameBoard` dispatch: the game is a
   data key, not a code branch inside the shell. #123 adds `WALKTHROUGHS.tonk`
   with zero shell edits. (Architecture principle: information hiding / thin
   client — the shell is a dumb renderer of static data.)

2. **Scenes are render functions over real components, not screenshots.** A step's
   `scene` is a small declarative descriptor (a discriminated union) that the shell
   maps to real presentational components — primarily `GameCard.vue` — plus a short
   caption. The mockup's "screenshot slot" placeholders are replaced by live
   `GameCard` rows driven by **hard-coded fixture `Card[]`**. Rationale: Option 1
   anti-rot — the illustration uses the same card renderer as the real game, so a
   card visual-style change can't leave the walkthrough stale, and there are no
   binaries to maintain. Scene descriptors are plain data so they live inside the
   declarative content model (decision 1) and stay testable as pure values.

3. **Direction A: modal over the current view; no routing.** The shell renders as a
   fixed-position overlay (scrim + centered panel), exactly like FeedbackWidget's
   modal. It does not push a route or mutate the URL, so it composes over any screen
   (home, create-game, lobby, board) without touching the router. Precedent:
   `FeedbackWidget.vue` overlay + `@click.self` scrim close.

4. **The (?) FAB and the walkthrough shell are separate components.** `HelpCluster.vue`
   owns the bottom-right cluster (the (?) FAB + the bug icon) and the open/close
   state; `WalkthroughModal.vue` owns the modal chrome and step navigation.
   `HelpCluster` renders `WalkthroughModal` conditionally (`v-if="open"`), matching
   the FeedbackWidget trigger→modal pattern. This keeps the shell reusable and the
   entrypoint replaceable in later slices.

5. **FeedbackWidget consolidation via slot/refactor, not duplication.** There must be
   exactly one floating cluster bottom-right. The current `FeedbackWidget.feedback-widget__trigger`
   (the "Feedback" pill) is replaced by a **bug-icon button rendered inside the
   cluster** owned by `HelpCluster`. The feedback **modal + submit + toast logic is
   preserved unchanged** (metadata capture, `POST /api/feedback`, `useFeedbackContext`,
   guest/registered detection, `data-testid="feedback-*"`). Implementation: extract
   the feedback modal/logic so the trigger button can live in `HelpCluster` while the
   feedback modal still renders and behaves as before. `App.vue` mounts **`HelpCluster`
   in place of the current standalone `FeedbackWidget`** — one cluster, two buttons.
   See §3.4 for the two acceptable refactor shapes; recommendation is Option A.

6. **Current `gameType` comes from a tiny shared composable, defaulting to `big2`.**
   There is no global game store today (GameView holds `gameType` locally). The FAB
   needs "the current game's type" while being mounted globally in App.vue. Introduce
   `useCurrentGameType()` — a module-level `ref<GameType>` (same singleton-composable
   pattern as `useFeedbackContext`). GameView sets it from the REST `getGameState`
   response and clears it on unmount; CreateGameView may set it from the selected
   type. When unset (home, stats, etc.) it defaults to `"big2"`. The FAB reads this
   ref to pick which `WALKTHROUGHS[...]` to show. Rationale: minimal, mirrors the
   existing feedback-context singleton, and avoids leaking any live game state (it
   carries only the enum, never hands/board data — see decision 7).

7. **The walkthrough NEVER reads live server-authoritative state.** Because the FAB
   persists onto the live board, this is a hard constraint. `WalkthroughModal` and
   every scene component receive ONLY: (a) the static `Step[]` from `WALKTHROUGHS`,
   and (b) the `gameType` enum from `useCurrentGameType()`. They must not import,
   prop-drill, or otherwise touch `gameState`, `EnrichedPlayerView`, `you.hand`,
   opponent data, `useGameState`, or the socket. Fixture cards are hard-coded literals
   in `walkthroughs.ts`. This is enforceable by construction: the shell's only inputs
   are the static content module and an enum. (Architecture principles 1 & 2:
   server-authoritative; information hiding — no hidden data can leak because none is
   passed in.)

8. **No persisted "seen" state, no auto-open.** The modal opens only on explicit FAB
   tap. Open/close is component-local `ref`; nothing is written to storage or the
   backend. Keeps the slice small and defers first-run UX to a later item.

---

## 3. Interfaces / Types

### 3.1 Content model (`src/frontend/component/howto/walkthroughTypes.ts`)

```typescript
import type { Card } from "@shared/engine-types";

// A scene is a declarative descriptor the shell maps to real components.
// Discriminated union so adding a future scene kind is additive and type-checked.
export type WalkthroughScene =
  // A row of real GameCards rendered from hard-coded fixture props.
  | {
      kind: "cards";
      cards: readonly Card[];
      // Indices (into `cards`) to render as selected/lifted (mirrors card selection).
      selectedIndices?: readonly number[];
      // Indices to highlight (e.g. dashed outline on the "lowest card").
      highlightIndices?: readonly number[];
    }
  // A simple icon + label callout (e.g. the placement-scoring / trophy step),
  // rendered with static markup — no live data.
  | {
      kind: "callout";
      icon: string; // an emoji/char, e.g. the trophy glyph
      lines: readonly string[]; // static text lines, e.g. "1st = 5 pts · 2nd = 3 · …"
    };

export interface WalkthroughStep {
  // Short eyebrow tag shown above the scene (mockup `.wt-illus .tag`), e.g. "Rank order".
  readonly tag: string;
  readonly scene: WalkthroughScene;
  // Caption HTML-free text with <strong> emphasis expressed as segments to avoid
  // v-html. See note below.
  readonly caption: readonly CaptionSegment[];
}

// Caption is a list of segments so we can bold key phrases WITHOUT v-html
// (XSS-safe, static). Rendered as <span> / <strong> spans.
export type CaptionSegment =
  | { text: string }
  | { strong: string };

export type Walkthrough = readonly WalkthroughStep[];
```

Note on captions: the mockup uses inline `<strong>`. To avoid `v-html` and keep the
content a pure data value, captions are modeled as ordered segments; the shell renders
plain segments in `<span>` and `strong` segments in `<strong>`. (An implementer may
instead ship captions as plain strings if the design reviewer accepts dropping inline
bolding; recommendation is to keep segments — the emphasis is load-bearing for
readability and it stays XSS-safe.)

### 3.2 Content registry (`src/frontend/component/howto/walkthroughs.ts`)

```typescript
import type { GameType } from "@shared/engine-types";
import type { Walkthrough } from "./walkthroughTypes";
import { BIG2_WALKTHROUGH } from "./big2Walkthrough";

// gameType-keyed. #123 adds `tonk: TONK_WALKTHROUGH` here with no shell change.
export const WALKTHROUGHS: Record<GameType, Walkthrough> = {
  big2: BIG2_WALKTHROUGH,
  // tonk: TONK_WALKTHROUGH,  // #123
} as unknown as Record<GameType, Walkthrough>;
```

Because `WALKTHROUGHS` must satisfy `Record<GameType, …>` but `tonk` is out of scope
here, the registry either (a) uses a partial map + a lookup helper that falls back
gracefully, or (b) ships a minimal placeholder. **Recommendation:** type it as
`Partial<Record<GameType, Walkthrough>>` and expose a helper:

```typescript
export function getWalkthrough(gameType: GameType): Walkthrough {
  return WALKTHROUGHS[gameType] ?? WALKTHROUGHS.big2 ?? [];
}
```

This keeps `tonk` a pure future data entry AND guarantees the FAB never renders an
empty modal before #123 lands (falls back to Big2). See E6.

### 3.3 Big2 content (`src/frontend/component/howto/big2Walkthrough.ts`)

Exports `BIG2_WALKTHROUGH: Walkthrough` — the ~6 steps below. Fixture `Card`s are
hard-coded literals (e.g. `{ rank: "3", suit: "clubs" }`). Steps, per approved mockup
and the acceptance criteria:

| # | tag | scene | caption gist |
|---|-----|-------|--------------|
| 1 | Goal & the 3♣ lead | `cards`: 3♣ 7♠ 10♥ K♦ 2♠, highlight index 0 (3♣) | Cards rank 3 (low) → 2 (high); suit breaks ties ♣<♦<♥<♠. The holder of **3♣** leads the very first trick. |
| 2 | Combinations | `cards`: a pair + a five-card hand fixture (two rows or one row is fine) | Play **singles, pairs, or five-card hands** (straight, flush, full house, four-of-a-kind, straight flush). You must match the count of the current play. |
| 3 | Lead low on a won trick | `cards`: a low fixture with lowest highlighted | When everyone else passes you **win the trick** and lead the next one — lead your **lowest** cards to save the high ones. |
| 4 | Select, then Play / Pass | `cards`: a hand with 2 selected (lifted) | Tap cards to select, then **Play** to beat the current play or **Pass** if you can't/won't. |
| 5 | Reading the table | `cards` or `callout`: the last play + whose turn | The center shows the **last play** you must beat; the log/among seats shows whose turn it is and who passed. |
| 6 | Winning & placement scoring | `callout`: trophy, lines "1st = 5 pts · 2nd = 3 · 3rd = 1 · 4th = 0" | First to empty their hand **wins the round**. Placement decides points — fewer cards left is better. |

(Exact card fixtures and caption wording are the implementer's to finalize against the
mockup; the shape and count are fixed here. Step 5 may use `callout` if a faithful
"table" scene isn't cleanly expressible from `GameCard` alone — implementer's call,
but it must not pull live state.)

### 3.4 Components

```
src/frontend/component/howto/
  walkthroughTypes.ts     -- types (§3.1)
  walkthroughs.ts         -- registry + getWalkthrough() (§3.2)
  big2Walkthrough.ts      -- BIG2_WALKTHROUGH data (§3.3)
  WalkthroughScene.vue    -- maps a WalkthroughScene → real components (GameCard rows / callout)
  WalkthroughModal.vue    -- modal chrome: header, scene, caption, dots, "Step X of N", Back/Next, close
  HelpCluster.vue         -- bottom-right cluster: (?) FAB + bug icon; owns open state; hosts feedback modal
```

**`WalkthroughModal.vue`** props/emits:

```typescript
defineProps<{
  steps: Walkthrough;   // getWalkthrough(currentGameType)
  gameLabel: string;    // e.g. "Big 2" for the header subtitle
}>();
defineEmits<{ close: [] }>();
// Local state: currentIndex = ref(0). Back disabled at 0; last step's primary
// button reads "Got it ✓" and emits close. Esc + scrim + X all emit close.
```

**`HelpCluster.vue`** — mounted once in App.vue. Owns:
- `walkthroughOpen = ref(false)`; (?) FAB toggles it open.
- `currentGameType` from `useCurrentGameType()`; passes `getWalkthrough(currentGameType)`
  and a `GAME_LABEL[currentGameType]` label into `WalkthroughModal`.
- The bug-icon button that opens the feedback modal (see consolidation below).

### 3.5 FeedbackWidget consolidation — two shapes

**Option A (recommended): keep `FeedbackWidget.vue`, expose its trigger via a slot /
control the modal externally.** Refactor `FeedbackWidget` so its floating "Feedback"
pill is removed and instead it exposes an imperative open (e.g. `defineExpose({ open })`)
or an `open` prop; `HelpCluster` renders the bug-icon button and calls
`FeedbackWidget.open()`. `HelpCluster` renders both `<WalkthroughModal>` and
`<FeedbackWidget>`. All feedback logic (`buildMetadata`, submit, toast, testids)
stays inside `FeedbackWidget` untouched. Smallest diff to the proven feedback code.

**Option B: fold the bug icon into a shared cluster and pass the feedback modal a
`v-model:open`.** Similar, but `HelpCluster` owns feedback `open` state and
`FeedbackWidget` becomes controlled. Slightly larger change to FeedbackWidget's API.

Recommendation: **Option A** — minimal change to the feedback feature, preserves its
self-contained modal, satisfies "one cluster, two buttons." Either way, `App.vue`
imports and mounts `HelpCluster` (not `FeedbackWidget` directly), and the standalone
`.feedback-widget__trigger` pill is removed.

### 3.6 Current-game-type composable (`src/frontend/composables/useCurrentGameType.ts`)

```typescript
import { ref, readonly } from "vue";
import type { GameType } from "@shared/engine-types";

const currentGameType = ref<GameType>("big2"); // default when not in a game

export function useCurrentGameType() {
  return {
    currentGameType: readonly(currentGameType),
    setCurrentGameType: (t: GameType) => { currentGameType.value = t; },
    resetCurrentGameType: () => { currentGameType.value = "big2"; },
  };
}
```

Same module-singleton shape as `useFeedbackContext`. GameView calls
`setCurrentGameType(game.gameType)` after the REST `getGameState` resolves (where it
already sets `gameType.value`) and `resetCurrentGameType()` in `onUnmounted` (next to
`clearGamePhase()`).

### 3.7 `data-testid` contract (for e2e)

- `howto-fab` — the (?) help FAB button.
- `feedback-trigger` — **reused** on the bug-icon button (preserves existing
  `e2e/feedback.spec.ts` selectors; the pill becomes the bug icon but keeps the id).
- `howto-modal` — the walkthrough modal panel.
- `howto-next`, `howto-back`, `howto-close` — nav/close controls.
- `howto-step-indicator` — the "Step X of N" element.
- `howto-dots` — the dot-indicator container.

---

## 4. State Model

Everything is **in-memory, component-local, ephemeral**. Nothing is persisted or sent
to the backend.

| State | Owner | Lifetime |
|-------|-------|----------|
| `walkthroughOpen` | `HelpCluster.vue` (`ref`) | While cluster mounted (App shell → whole session) |
| `currentIndex` (which step) | `WalkthroughModal.vue` (`ref`) | Per modal open; reset to 0 on each open (fresh mount via `v-if`) |
| `currentGameType` | `useCurrentGameType` module singleton | Set by GameView on join; reset on unmount; defaults `big2` |
| Feedback modal state | `FeedbackWidget.vue` (unchanged) | As today |
| `WALKTHROUGHS` / `BIG2_WALKTHROUGH` | static module constants | Compile-time; immutable |

Data flow for opening the walkthrough:

```
GameView (REST getGameState) --setCurrentGameType(gameType)--> useCurrentGameType singleton
User taps (?) FAB --> HelpCluster.walkthroughOpen = true
HelpCluster reads useCurrentGameType --> getWalkthrough(type) --> steps: Walkthrough
<WalkthroughModal :steps :gameLabel> renders steps[currentIndex] via <WalkthroughScene>
Back/Next mutate currentIndex; X/scrim/Esc/"Got it" --> emit close --> walkthroughOpen = false
```

**No live game state ever enters this flow** — the modal's only inputs are the static
`steps` array and the `gameType` enum. (Verifiable by inspecting `WalkthroughModal`'s
and `WalkthroughScene`'s props: no `gameState`/`EnrichedPlayerView`/socket import.)

---

## 5. Edge Cases

| # | Case | Handling |
|---|------|----------|
| E1 | User opens walkthrough, navigates step-by-step to the end | Back disabled on step 0; on the last step the primary button reads "Got it ✓" and closes the modal (no Next past the end). `currentIndex` never exceeds `steps.length - 1`. |
| E2 | User closes mid-walkthrough then reopens | Modal is `v-if`-mounted, so it remounts with `currentIndex = 0`. No persisted resume in this slice. |
| E3 | Esc pressed while modal open | Closes the modal (matches feedback/log-drawer precedent). Listener added on open, removed on close; does not leak. Esc must NOT bubble to close other overlays (stop when handled). |
| E4 | Scrim (backdrop) click | `@click.self` on the scrim closes; clicks inside the panel do not. (FeedbackWidget precedent.) |
| E5 | (?) FAB tapped while feedback modal is open (or vice versa) | The two modals are independent overlays. Opening one does not close the other by design, but they should not visually stack ambiguously — acceptable for this slice to allow only one cluster action at a time is NOT required; if both open, the later one renders above (higher z-index). Full cross-modal arbitration is #124. |
| E6 | FAB opened on a screen whose `currentGameType` has no content yet (e.g. a future Tonk game before #123) | `getWalkthrough()` falls back to Big2 (never an empty modal). Once #123 lands, `tonk` resolves to real content automatically. |
| E7 | FAB opened on a non-game screen (home, stats, create-game) | `currentGameType` defaults to `big2` (or the last-selected type if CreateGameView set it); the Big2 walkthrough renders. This is intended — the (?) is always meaningful. |
| E8 | Game starts / route changes while the modal is open | Out of scope for hardening (#124). Baseline behavior: the modal is App-shell-mounted and keeps rendering over the new view; content does not live-update mid-open. Acceptable for this slice. |
| E9 | Mobile viewport (≤767px) | Modal is single-column, near-full-height with internal scroll if content overflows; nav buttons and close target ≥44px (mockup `.navbtn { min-height: 44px }`). (?) FAB (46px) and bug icon (40px) both remain tappable and are not overlapped by the mobile log-toggle (top-right) or the board's action row — verify z-index/stacking against `game-board` (rim z-index 100) and the log-toggle (z-index 200); the cluster must sit above the board content but the modal scrim above everything. |
| E10 | Fixture `Card` with a two-char rank ("10") | `GameCard.vue` already renders `displayRank` verbatim, so "10" works; no special handling. |
| E11 | Reduced motion | Any modal open/step transitions respect `prefers-reduced-motion: reduce` (disable transitions), matching existing components. |
| E12 | Feedback functionality regression risk | Consolidation must preserve `feedback-trigger`/`feedback-modal`/`feedback-submit`/`feedback-description`/`feedback-category`/`feedback-toast` testids and the `POST /api/feedback` call + metadata capture. `e2e/feedback.spec.ts` must still pass unmodified (or with only the trigger's visual change accounted for). |
| E13 | Screen reader / a11y | (?) FAB `aria-label="How to play"`; bug icon `aria-label="Report a bug"` (preserve existing "Send feedback" intent). Modal has an accessible title; close button `aria-label="Close"`. Focus behavior: nice-to-have, not blocking for this slice. |

---

## 6. Dependencies

Must exist before implementation (all already present):

- `src/frontend/component/App.vue` — mount point (currently mounts `FeedbackWidget`).
- `src/frontend/component/FeedbackWidget.vue` — to be refactored into the cluster (§3.5).
- `src/frontend/component/game-ui/GameCard.vue` — real card renderer used by scenes.
- `src/frontend/component/game/GameView.vue` — sets `currentGameType` on join / resets on unmount.
- `src/shared/engine-types.ts` — `Card`, `Suit`, `Rank`, `GameType`.
- `src/frontend/composables/useFeedbackContext.ts` — pattern reference for the new singleton composable.
- `src/frontend/styles/game-variables.css` — design tokens (`--gold-accent`, `--font-ui`, etc.).
- Approved mockup: `docs/mockups/howto-walkthrough-shell-big2-create-game-entrypoint.html`
  (branch `lld-110-...`) — the visual source of truth for cluster + modal + steps.

No backend, engine, migration, or shared-model changes.

Downstream (do not implement here, keep boundary clean): #123 adds `WALKTHROUGHS.tonk`
= `TONK_WALKTHROUGH` (data only). #124 hardens FAB behavior across surfaces and may add
more entrypoints. Keep the shell purely `(steps, gameType) → rendered modal` so both
remain pure follow-ups.

---

## 7. Test Requirements

**Testing reality (from `tests/frontend/`):** frontend unit tests run in a node
environment WITHOUT jsdom and WITHOUT `@vue/test-utils` (see
`feedbackBuildMetadata.test.ts`, `createGameView.test.ts`). The project pattern is to
extract load-bearing logic/data into plain modules and unit-test those, and to verify
rendered UI via Playwright e2e. Follow that pattern here — do not add jsdom/test-utils.

### 7.1 Unit tests (vitest, node env) — pure data & logic

Target the plain modules (`walkthroughs.ts`, `walkthroughTypes.ts`, `big2Walkthrough.ts`)
and the step-navigation logic (extract it as a pure helper mirroring the modal's
`currentIndex` reducer, per `createGameView.test.ts` precedent).

- `getWalkthrough("big2")` returns the Big2 walkthrough (non-empty).
- `getWalkthrough` for a type with no content falls back to Big2 (never empty) — E6.
- `BIG2_WALKTHROUGH` has the expected step count (~6) and every step has a non-empty
  `tag`, a valid `scene` (discriminant is `"cards"` or `"callout"`), and a non-empty
  `caption`.
- Every `cards` scene's `selectedIndices`/`highlightIndices` are within
  `[0, cards.length)` (guards against fixture typos — E10 adjacency).
- Every `cards` scene's fixture cards are valid `Card`s (rank ∈ Rank, suit ∈ Suit).
- Step-nav reducer: at index 0 Back is disabled; Next advances; at last index the
  primary action is "close" (not advance); index is clamped to `[0, n-1]` — E1.
- **Information-hiding assertion:** a static/structural test that the walkthrough
  modules import nothing from live-state sources (no import of `useGameState`,
  `socket-events`, `EnrichedPlayerView`, `@/composables/useSocket`). Implement as a
  source-scan test (read the module files, assert forbidden import substrings absent)
  — this is the automated guard for decision 7 / architecture principle 2. E2E cannot
  see network payloads for a client-only feature, so this static check is the
  security test.

### 7.2 E2E tests (Playwright) — rendered behavior & consolidation

Add `e2e/howto-walkthrough.spec.ts`:

- The (?) FAB (`howto-fab`) is visible on the home screen and on the game board
  (persistent across screens).
- Tapping `howto-fab` opens `howto-modal`; step indicator shows "Step 1 of 6";
  Back is disabled.
- Next advances through all steps; on the last step the primary button closes the
  modal ("Got it"); dot indicator + "Step X of N" update per step.
- Close via X (`howto-close`), via scrim click, and via Esc each dismiss the modal — E3/E4.
- Card scenes render real `.card` elements (assert `GameCard` DOM present in a `cards`
  step) — confirms Option 1 wiring, not a placeholder.
- Mobile viewport (reuse the project's mobile-layout viewport config): FAB, bug icon,
  and modal nav buttons are visible and tappable; buttons meet the ~44px target — E9.

Update / preserve `e2e/feedback.spec.ts`:

- The bug icon still carries `feedback-trigger` and opens `feedback-modal`; submit +
  toast still work; guest + registered paths unchanged — E12. Adjust only for the
  trigger's visual change (pill → bug icon), keeping the selector.

### 7.3 Manual verification (exception, per testing-principles §Decision Heuristics)

Visual-only checks that DOM/state assertions can't fully cover:

- The bottom-right cluster reads as a single unit (no two competing floating clusters)
  on desktop and mobile, and does not overlap the mobile log-toggle or the board
  action row — against the approved mockup.
- Modal card scenes are visually faithful to the mockup's illustrations.

---

## 8. File Organization

```
New files:
  src/frontend/component/howto/walkthroughTypes.ts     -- scene/step/caption types
  src/frontend/component/howto/walkthroughs.ts         -- WALKTHROUGHS registry + getWalkthrough()
  src/frontend/component/howto/big2Walkthrough.ts      -- BIG2_WALKTHROUGH data
  src/frontend/component/howto/WalkthroughScene.vue    -- scene → real components mapper
  src/frontend/component/howto/WalkthroughModal.vue    -- modal chrome + step nav
  src/frontend/component/howto/HelpCluster.vue         -- (?) FAB + bug icon cluster
  src/frontend/composables/useCurrentGameType.ts       -- current gameType singleton
  tests/frontend/walkthroughs.test.ts                  -- unit tests (§7.1)
  e2e/howto-walkthrough.spec.ts                         -- e2e (§7.2)

Modified files:
  src/frontend/component/App.vue                        -- mount HelpCluster in place of FeedbackWidget
  src/frontend/component/FeedbackWidget.vue             -- refactor per §3.5 (trigger → bug icon in cluster)
  src/frontend/component/game/GameView.vue              -- set/reset useCurrentGameType on join/unmount
  e2e/feedback.spec.ts                                  -- account for pill → bug-icon trigger (keep testid)
```
