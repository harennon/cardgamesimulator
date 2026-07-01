# LLD 115: How-to-play walkthrough — add Tonk content entry (declarative, no new UI)

Parent: #95 (order 2 of 3). Depends on **#122 / LLD 111** (walkthrough shell +
Big2 content + persistent (?) FAB), which is **already merged** onto this branch
(commit `2e1245d`, PR #129).

This slice is the **design test of epic #95**: adding a game's walkthrough must be a
**declarative content change, not new UI**. The deliverable is a `TONK_WALKTHROUGH`
content array + one registry line + one content-layer type widening — and **zero new
rendering components**. If implementation needs a new `WalkthroughScene` branch, a
modal change, or any new renderer, the #122 shell is wrong: **stop and flag it**
rather than forking the renderer (see §2 constraint).

Frontend decision: **Option B** (joker fixture card) — selected by the user. The
Jokers step renders a real `GameCard` joker face via a one-union widening of the
`cards` scene fixture type. See §Frontend Design.

---

## 1. Scope

### In scope

- A new content module `src/frontend/component/howto/tonkWalkthrough.ts` exporting
  `TONK_WALKTHROUGH: Walkthrough` — an ordered 6-step array covering what makes Tonk
  play differently from Big2: **discard-first/draw flow, jokers, the TONK declaration,
  and loss-centric scoring** (per LLD 65).
- One registry line in `walkthroughs.ts`: replace the commented
  `// tonk: TONK_WALKTHROUGH, // #123` with the live entry.
- **One content-layer type widening** (Option B): widen the `cards` scene's fixture
  type in `walkthroughTypes.ts` from `readonly Card[]` to
  `readonly (Card | TonkCard)[]` so a joker fixture can render through the existing
  `GameCard` (which already accepts `Card | TonkCard` and already renders a joker face
  via `isJoker()` — LLD 88). This is the **only** type change.
- Scenes rendered per the **live-component-thumbnail** approach from #122 (real
  `GameCard` components + hard-coded static fixtures; no committed PNGs, no capture
  step).
- Correct rendering on mobile viewport widths (reuses the shell's existing responsive
  modal — no new CSS).

### Explicitly NOT in scope

- **Any new rendering component or new `WalkthroughScene` kind.** The two existing
  kinds (`cards`, `callout`) cover all six Tonk steps. Adding a kind or renderer would
  mean the foundation shell is wrong — flag it (§2), do not build it.
- **Any change to the shell's structure** — `WalkthroughModal.vue`,
  `WalkthroughScene.vue`, `stepNav.ts`, `GameCard.vue` are reused verbatim (aside from
  the single fixture-type widening in `walkthroughTypes.ts`, which is content-layer,
  not renderer).
- **Any change to the (?) FAB / entrypoint** (owned by #122). `HelpCluster.vue`,
  `getWalkthrough()`, and `useCurrentGameType` are untouched. Registering
  `WALKTHROUGHS.tonk` is sufficient for the FAB to auto-open the Tonk walkthrough
  whenever the current `gameType` is `"tonk"`.
- Live guided overlay, video, animation, localization, auto-launch, first-run "seen"
  flag.
- Any backend, engine, transport, or persistence change. Frontend content only.

---

## 2. Approach

### 2.1 The constraint is the design (declarative, zero new renderers)

The #122 shell was built so a game is a **data key**, not a code branch:
`getWalkthrough(gameType)` reads `WALKTHROUGHS[gameType]` and the modal renders the
returned `WalkthroughStep[]` generically. Adding Tonk therefore reduces to authoring a
static array. The **acceptance test** of this LLD is that the ship is:

1. `tonkWalkthrough.ts` — new content array (data only).
2. one registry line in `walkthroughs.ts` (uncomment/replace the `// #123` line).
3. one union widening in `walkthroughTypes.ts` (`Card` → `Card | TonkCard` on the
   `cards` scene fixture) so Option B's joker fixture renders.

Nothing else. **If an implementer finds they must add a `WalkthroughScene` branch, edit
`WalkthroughModal.vue`/`WalkthroughScene.vue`, or otherwise write renderer code, that is
a signal the #122 shell is insufficient — halt and escalate the shell-is-wrong finding
rather than forking the renderer.** (Verified against source: `WalkthroughScene.vue`
already `v-for`s `scene.cards` into `<GameCard :card="c">`, and `GameCard.vue` already
branches on `isJoker(props.card)` to render the joker face — so a `TonkCard` joker
passes end-to-end with no renderer edit. The widening is purely so TypeScript accepts a
joker in the fixture array.)

### 2.2 Why Option B (joker fixture card) over Option A (joker in caption text)

Both options need **zero new rendering components**; they differ only in the Jokers step:

- **Option A** — jokers described in caption + a `callout` scene. Zero code edits.
- **Option B (selected)** — the Jokers step shows a real `GameCard` joker face (the ★
  glyph, already shipped for the Tonk board in LLD 88). Requires the single one-union
  widening in §2.1(3). This is a **richer, truer illustration** (the walkthrough shows
  the same joker card the player will see on the real board) and is still not a new
  renderer — `GameCard` and `WalkthroughScene` already handle it.

The user selected Option B. The widening is content-layer only and does not touch the
modal or the scene mapper.

### 2.3 Content authored against the Tonk rules of record (LLD 65)

Wording and scoring must match the signed-off Tonk variant (LLD 65, signed off
2026-06-28):

- **Card values:** A=1, 2–10 = face value, J/Q/K = 10, **Joker = 0** (§3.2). Hand value
  = sum; lower is better.
- **Turn = discard-first, THEN draw** (§3.3). Discard one card, or multiples of the
  **same rank**; then draw exactly **one** from the stock **or** the drawable face-up
  discard (the immediately-preceding player's top card / trick-start card) — never draw
  back your own just-discarded card.
- **TONK** is declared at the **start** of your turn, before discarding, and only after
  every player has had a turn (§3.4). A **successful** call (caller strictly lowest):
  the caller adds 0, everyone else adds their hand value. A **failed/tied** call: the
  caller adds **30** (§5.1 Cases A/B).
- **Loss-centric scoring** (§5.2/§6.3): tallies **add up** each trick (lower is better);
  when any player's tally reaches **150** the match ends with **exactly ONE true loser**
  (resolved by the joker draw when multiple crossed 150) and **everyone else wins**.

These are the exact facts the captions must convey. The step captions below are
authored to be faithful to LLD 65; the implementer must not invent mechanics that do
not exist in this variant (no melds/spreads/hitting/knock; hands never empty).

### 2.4 The FAB is untouched and auto-resolves Tonk

`HelpCluster.vue` already computes `steps = getWalkthrough(currentGameType.value)` and
`gameLabel = GAME_LABEL[currentGameType.value]` (both verified in source). `GAME_LABEL`
already contains `tonk: "Tonk"`. `useCurrentGameType` is set by `GameView` from the REST
`getGameState` response. Therefore, once `WALKTHROUGHS.tonk = TONK_WALKTHROUGH` exists,
the persistent (?) FAB opens the **Tonk** walkthrough automatically whenever the current
game type is `"tonk"` — with no FAB/entrypoint code change. Before this slice,
`getWalkthrough("tonk")` fell back to Big2 (LLD 111 E6); after it, `tonk` resolves to
real content. No change to `getWalkthrough()` is needed — the fallback simply stops
being hit for Tonk.

---

## 3. Frontend Design

The Tonk walkthrough is a **declarative content entry** rendered through the **exact
same shell** the Big2 walkthrough already ships (`WalkthroughModal.vue` +
`WalkthroughScene.vue` + `GameCard.vue`, from #122 / LLD 111). It proves the core
promise of #95: **adding Tonk is content, not new UI.**

### Proposed 6-step Tonk content (covers all acceptance criteria)

| # | tag | scene | caption gist (bold = `strong` segment) |
|---|-----|-------|----------------------------------------|
| 1 | Aim of the game | `cards`: a 5-card fixture hand (e.g. A♠ 4♥ 7♣ 10♦ K♠), highlight the lowest-value cards | Keep a **5-card hand** — it's never emptied. Race for the **lowest hand value**: **A = 1, 2–10 = face value, J/Q/K = 10**. |
| 2 | Discard first | `cards`: e.g. Q♣ Q♥ Q♦ 5♠ 8♥ with `selectedIndices` on the three Queens | Every turn you **discard first** — one card, or **several of the same rank** (three Queens shown). |
| 3 | …then draw one | `cards`: a small pile fixture with one drawable card `highlightIndices` (the face-up discard) alongside a face-down stock representation | Then **draw exactly one** — from the **stock** or the highlighted **face-up discard**. You can **never draw back your own discard**. |
| 4 | Jokers are gold | `cards`: a single **joker** `TonkCard` fixture (★ face) | A **Joker is worth 0** — the best card you can hold. Keep it to crush your hand value. |
| 5 | Call TONK | `callout`: icon + lines (e.g. "Beat everyone → you add 0" / "Get caught → +30") | Declare **TONK** at the **start of your turn**. Beat everyone and you add **0** while they take their hand value — but a **failed call costs 30**. |
| 6 | Scoring — low is safe | `callout`: icon + lines (e.g. "Points add up each trick" / "Hit 150 → game ends") | Points **add up** each trick — **low is safe**. When someone hits **150** the game ends with exactly **one true loser**; everyone else **wins**. |

Exact fixture cards, `callout` icon glyphs, and caption wording are the implementer's to
finalize, but the **shape (6 steps), the scene kinds, and the four required topics
(discard/draw, jokers, TONK, loss-centric scoring)** are fixed here. Step 4 MUST use a
real joker `GameCard` fixture (Option B). Steps 5–6 use `callout` (static icon + lines),
mirroring Big2's step-6 trophy callout. Steps 1–3 use `cards`.

### The one decision (resolved): how the Jokers step renders — Option B

Option B: the Jokers step (step 4) shows a real `GameCard` joker face (★, shipped for
the Tonk board in LLD 88). To pass a joker through a `cards` scene, widen the scene
fixture type in `walkthroughTypes.ts` from `readonly Card[]` to
`readonly (Card | TonkCard)[]` (`TonkCard = Card | TonkJoker` from `@shared/tonk-types`).
`GameCard` already accepts `Card | TonkCard` and `WalkthroughScene` already forwards it,
so this is **still not a new renderer** — just a one-union content-layer type edit for a
richer visual.

**Constraint check.** Neither option needs a new `WalkthroughScene` branch or any modal
change. If either had, the foundation shell would be wrong — it isn't. The (?) FAB is
untouched: `HelpCluster.vue` already resolves `getWalkthrough(currentGameType)`, so
registering `WALKTHROUGHS.tonk` makes the FAB open the Tonk walkthrough automatically
whenever the current game type is Tonk. Renders identically on desktop and 360px mobile
(the shell's existing responsive modal — no new CSS).

### Mockup note

Because the scenes are built entirely from existing components (`GameCard`, the callout
markup) driven by static fixtures — i.e. **no net-new visual UI** — a full new mockup
round is not required. The visual chrome is the already-approved #122 shell; the only
new pixels are real `GameCard`s (including the already-shipped LLD-88 joker face) in the
same scene slots Big2 uses. The frontend-architect confirmed the scene sequence and
fixtures against the shipped shell before implementation. A prior mockup embedding the
production shell markup driven by a `TONK_WALKTHROUGH` step array was produced on branch
`lld-112-howto-walkthrough-tonk-content-entry`
(`docs/mockups/howto-walkthrough-tonk-content-entry.html`).

---

## 4. Interfaces / Types

### 4.1 Content-layer type widening (`walkthroughTypes.ts`) — the ONLY type change

```typescript
import type { Card } from "@shared/engine-types";
import type { TonkCard } from "@shared/tonk-types"; // NEW import (Card | TonkJoker)

export type WalkthroughScene =
  | {
      kind: "cards";
      // WAS: readonly Card[]. Widened so a joker fixture (Option B) type-checks.
      // GameCard already accepts Card | TonkCard and renders jokers via isJoker().
      cards: readonly (Card | TonkCard)[];
      selectedIndices?: readonly number[];
      highlightIndices?: readonly number[];
    }
  | {
      kind: "callout";
      icon: string;
      lines: readonly string[];
    };

// CaptionSegment, WalkthroughStep, Walkthrough — UNCHANGED.
```

Note: `TonkCard = Card | TonkJoker`, so `Card | TonkCard` simplifies to `TonkCard`; the
implementer may write either. The intent is "a card fixture may be a standard card or a
Tonk joker." No other field of `WalkthroughScene`/`WalkthroughStep` changes.

`WalkthroughScene.vue` needs **no change**: it already binds `:card="c"` where `c`
iterates `scene.cards`, and `GameCard`'s `card` prop is already `Card | TonkCard`. The
`:key` template expression `` `${c.rank}-${c.suit}-${i}` `` reads `c.rank`/`c.suit`; for a
joker those are `undefined`, yielding a key like `undefined-undefined-3` — still unique
per index via the trailing `i`, so it remains a valid, stable key. **No edit required**,
but if the design reviewer prefers a cleaner key the implementer may switch it to a
plain index `:key="i"` (a one-token, renderer-neutral change) — this is optional and not
a new component.

### 4.2 New content module (`src/frontend/component/howto/tonkWalkthrough.ts`)

Mirrors `big2Walkthrough.ts` exactly in shape (a terse `card()` constructor + an
exported `Walkthrough` literal), adding a joker fixture for step 4:

```typescript
import type { Card } from "@shared/engine-types";
import type { TonkJoker } from "@shared/tonk-types";
import type { Walkthrough } from "./walkthroughTypes";

const card = (rank: Card["rank"], suit: Card["suit"]): Card => ({ rank, suit });
const joker = (id: number): TonkJoker => ({ joker: true, id });

export const TONK_WALKTHROUGH: Walkthrough = [
  /* 6 steps per §3 table: discard/draw, jokers (joker(0) fixture), TONK, scoring */
];
```

`TonkJoker` requires `{ joker: true; id: number }` (verified in `tonk-types.ts`); any
stable `id` (e.g. `0`) is fine for a static fixture.

### 4.3 Registry line (`src/frontend/component/howto/walkthroughs.ts`)

Replace the placeholder comment with the live entry:

```typescript
import { BIG2_WALKTHROUGH } from "./big2Walkthrough";
import { TONK_WALKTHROUGH } from "./tonkWalkthrough"; // NEW

export const WALKTHROUGHS: Partial<Record<GameType, Walkthrough>> = {
  big2: BIG2_WALKTHROUGH,
  tonk: TONK_WALKTHROUGH, // was: // tonk: TONK_WALKTHROUGH,  // #123
};
```

`getWalkthrough()` and `GAME_LABEL` are **unchanged** (`GAME_LABEL.tonk` already
`"Tonk"`). No other export in this module changes.

---

## 5. State Model

Unchanged from LLD 111. Everything remains **in-memory, component-local, ephemeral**;
nothing is persisted or sent to the backend, and the walkthrough **never reads live
game state** (LLD 111 decision 7 — architecture principles 1 & 2). `TONK_WALKTHROUGH`
is a static module constant of hard-coded fixtures (standard cards + one joker literal),
exactly like `BIG2_WALKTHROUGH`.

Data flow (identical to Big2, only the resolved content differs):

```
GameView (REST getGameState) --setCurrentGameType("tonk")--> useCurrentGameType singleton
User taps (?) FAB --> HelpCluster.walkthroughOpen = true
HelpCluster --> getWalkthrough("tonk") --> TONK_WALKTHROUGH
<WalkthroughModal :steps=TONK_WALKTHROUGH :gameLabel="Tonk"> renders each step via <WalkthroughScene>
```

No live hand/board/socket data enters this flow — verifiable by inspecting the module's
imports (only `@shared/engine-types`, `@shared/tonk-types` types, and
`./walkthroughTypes`).

---

## 6. Edge Cases

| # | Case | Handling |
|---|------|----------|
| E1 | Joker fixture in a `cards` scene | `GameCard` renders the ★ joker face via `isJoker()` (LLD 88); no rank/suit shown. The widened `cards` fixture type accepts it. Verified: `GameCard.vue` `v-else-if="joker"` branch + `card--joker` styling already exist. |
| E2 | `:key` for a joker in `WalkthroughScene`'s `v-for` | Current key `` `${c.rank}-${c.suit}-${i}` `` yields `undefined-undefined-<i>` for a joker — still unique via `i`. Acceptable; optional cleanup to `:key="i"` if the reviewer prefers (renderer-neutral). |
| E3 | `selectedIndices` on the multi-discard step | Reuses Big2's selected-lift styling (`card--selected`) unchanged; indices must be within `[0, cards.length)` (guarded by unit test, mirrors LLD 111). |
| E4 | FAB opened while `currentGameType === "tonk"` | Opens the Tonk walkthrough (this slice's point). No FAB change. |
| E5 | FAB opened on a non-Tonk / non-game screen | `currentGameType` resolves to whatever `GameView`/default set (`big2` default); Big2 walkthrough renders — unchanged from #122. Tonk content shows only when the current type is Tonk. |
| E6 | Fallback still intact | `getWalkthrough` fallback to Big2 (LLD 111 E6) is unchanged; it simply stops being hit for `tonk` now that a real entry exists. A future third game with no entry still falls back. |
| E7 | Mobile viewport (≤767px, incl. 360px) | Renders through the shell's existing responsive modal (single-column, ~44px nav targets, internal scroll). The joker `GameCard` uses `size="small"` (30×42px) like every walkthrough card. No new CSS. |
| E8 | Step count / nav | 6 steps drive the existing dot indicator + "Step X of 6" + Back/Next + "Got it ✓" via `stepNav.ts` unchanged; Back disabled on step 1, primary closes on step 6. |
| E9 | Caption emphasis without `v-html` | Captions use the existing `CaptionSegment[]` (`{text}` / `{strong}`) model — XSS-safe, no `v-html`, identical to Big2. |
| E10 | Content-accuracy risk (rules drift) | Captions must match LLD 65 exactly (A=1/face/10, Joker=0, discard-first-then-draw, TONK at turn start, successful vs failed call scoring, 150 → one true loser). Guarded by content-shape unit tests + human review against LLD 65. |
| E11 | Constraint violation (implementer needs new renderer) | STOP: this means the #122 shell is insufficient. Escalate the shell-is-wrong finding; do NOT add a scene kind, edit the modal, or fork the renderer within this slice. |

---

## 7. Dependencies

All present on this branch (LLD 111 / #122 merged as PR #129, commit `2e1245d`):

- `src/frontend/component/howto/walkthroughTypes.ts` — the `cards` fixture type widened here.
- `src/frontend/component/howto/walkthroughs.ts` — the registry line added here.
- `src/frontend/component/howto/big2Walkthrough.ts` — shape template for the new content module.
- `src/frontend/component/howto/WalkthroughScene.vue` — reused verbatim (already forwards `Card | TonkCard` to `GameCard`).
- `src/frontend/component/howto/WalkthroughModal.vue`, `stepNav.ts`, `HelpCluster.vue` — reused verbatim; **not modified**.
- `src/frontend/component/game-ui/GameCard.vue` — already renders jokers via `isJoker()` (LLD 88); reused verbatim.
- `src/shared/tonk-types.ts` — `TonkCard`, `TonkJoker`, `isJoker` (verified exports).
- `src/shared/engine-types.ts` — `Card`, `GameType` (`"tonk"` present).
- `docs/lld/65-tonk-rules-spec.md` — authoritative source for all caption content.

No backend, engine, migration, transport, or shared-model change. No dependency on any
unshipped work — Tonk board (LLD 88) and Tonk actions UI (LLD 99) have shipped, so Tonk
is representable and this is unblocked.

---

## 8. Test Requirements

Follow the LLD 111 pattern exactly: **node-env vitest unit tests over the plain content
modules** (no jsdom / no `@vue/test-utils`), plus a small e2e addition. Extend the
existing `tests/frontend/walkthroughs.test.ts` rather than duplicating its harness.

### 8.1 Unit tests (vitest, node env) — pure data & registry

- `getWalkthrough("tonk")` returns `TONK_WALKTHROUGH` (and `WALKTHROUGHS.tonk` is now
  defined — **update** the existing LLD-111 test that asserted `WALKTHROUGHS.tonk` is
  `undefined` and falls back to Big2; that fallback assertion for `tonk` no longer holds
  and must be revised to assert the real Tonk entry). `getWalkthrough` fallback for a
  still-unregistered type continues to return Big2.
- `TONK_WALKTHROUGH` has the expected step count (6); every step has a non-empty `tag`,
  a valid scene discriminant (`"cards"` or `"callout"`), and a non-empty `caption`.
- **Every `cards` scene holds only valid fixtures:** each entry is either a valid `Card`
  (rank ∈ Rank, suit ∈ Suit) **or** a `TonkJoker` (`isJoker(c) === true`). Extend the
  existing `isValidCard` helper to accept jokers (mirror the LLD-111 validity test).
- **At least one step renders a joker** (Option B guard): assert some `cards` scene
  contains a fixture for which `isJoker(c)` is true — proves the joker-fixture path is
  exercised, not silently dropped to caption text.
- Every `cards` scene's `selectedIndices`/`highlightIndices` are within
  `[0, cards.length)` (fixture-typo guard).
- Every `callout` scene has a non-empty `icon` and ≥1 line.
- At least one caption uses a `{strong}` emphasis segment (readability guard).
- **Information-hiding source-scan (decision 7):** add
  `src/frontend/component/howto/tonkWalkthrough.ts` to the existing `MODULE_FILES`
  forbidden-import scan, asserting it imports nothing from a live-state source
  (`useGameState`, `useSocket`, `socket-events`, `EnrichedPlayerView`,
  `gameSpecificPublicState`, `useGameActions`). This is the automated security guard for
  a client-only feature.

### 8.2 E2E (Playwright) — Tonk resolution + joker render

Extend `e2e/howto-walkthrough.spec.ts` (or add a Tonk block):

- With the current game type Tonk (join/observe a Tonk game via the real UI flow — do
  NOT inject cookies/state manually), tapping `howto-fab` opens `howto-modal` with the
  header subtitle **"Tonk"** and step indicator "Step 1 of 6".
- The joker step renders a real joker card: assert the shipped
  `[data-testid="joker-card"]` element (from `GameCard`, LLD 88) is present within
  `howto-scene` on the Jokers step — confirms Option B wiring (a live component, not a
  placeholder or caption-only).
- Next advances through all 6 steps; the last step's primary button closes the modal.
- Mobile viewport (reuse the project's mobile-layout config): the modal, its nav
  buttons, and the joker card are visible and the modal is usable at 360px width.

### 8.3 Manual verification (exception — visual only)

- The Tonk walkthrough renders through the **same** modal chrome as Big2 (single shell),
  and the joker ★ face reads correctly at `small` card size on desktop and 360px mobile.
- Caption wording is faithful to LLD 65 (A=1/face/10, Joker=0, discard-then-draw, TONK
  scoring, 150 → one true loser) — reviewer check against the rules spec.

### 8.4 Constraint acceptance check (the #95 design test)

The diff MUST consist of: (1) `tonkWalkthrough.ts` (new), (2) the one registry line in
`walkthroughs.ts`, (3) the one union widening + import in `walkthroughTypes.ts`, plus
tests. Any renderer/modal/scene-mapper edit (beyond the optional `:key` cleanup in E2)
in the diff indicates the shell was insufficient and must be surfaced as a
shell-is-wrong finding, not silently absorbed.

---

## 9. File Organization

```
New files:
  src/frontend/component/howto/tonkWalkthrough.ts   -- TONK_WALKTHROUGH data (6 steps, incl. joker fixture)

Modified files:
  src/frontend/component/howto/walkthroughTypes.ts  -- widen cards fixture: Card[] -> (Card | TonkCard)[] (+ import)
  src/frontend/component/howto/walkthroughs.ts       -- register tonk: TONK_WALKTHROUGH (one line + import)
  tests/frontend/walkthroughs.test.ts                -- add Tonk content-shape + joker + source-scan tests; revise the tonk-fallback test
  e2e/howto-walkthrough.spec.ts                      -- Tonk resolution + joker-render + mobile assertions

NOT modified (reused verbatim — modifying any of these is a shell-is-wrong signal):
  src/frontend/component/howto/WalkthroughScene.vue
  src/frontend/component/howto/WalkthroughModal.vue
  src/frontend/component/howto/HelpCluster.vue
  src/frontend/component/howto/stepNav.ts
  src/frontend/component/game-ui/GameCard.vue
```
