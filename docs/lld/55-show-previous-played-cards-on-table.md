# LLD 55: Show Previous Played Cards on the Table

## Scope

**Covers:** A Big2-only "trick pile" UI in the table area showing the plays (and passes) made during the **current trick**, so players can see what came before `lastPlay` without opening the log drawer.

- Collapsed state: a stacked card pile sitting beside the centered current play, with a gold count badge.
- Expanded state: a click/tap overlay fanning every play in the current trick in play order, with passes represented inline.
- The pile resets when a new trick starts.
- Current-trick data is derived **client-side** from `Big2PublicState.playHistory` (cumulative full-game history).

**Does NOT cover:**

- Any server, engine, or shared-type changes. Server-authoritative state is unchanged; this is frontend-only.
- A universal cross-game history component. This is scoped to Big2. (Tonk's discard pile is a different concept and is explicitly out of scope — rejected.)
- Showing prior **tricks** (full-game history). That remains in `GameLog` / the mobile log drawer.
- Changing the existing `lastPlay` rendering in `PlayArea` (the centered current play stays as-is).
- Spectator view (`EnrichedSpectatorView`). See Edge Cases for why it is deferred, not built here.

## Approach

**Where it lives.** A new presentational component `TrickPile.vue` rendered inside `PlayArea.vue`, positioned beside the existing centered `play-area__cards`. `PlayArea` already receives `Big2PublicState`-derived props from `GameBoard.vue`; we pass it the data it needs (see Interfaces).

**Data derivation (client-side, no server change).** `Big2PublicState.playHistory` is the cumulative, full-game ordered list of `Big2HistoryEntry` (both plays and passes, in turn order). The component must derive the **current trick** — the contiguous suffix of `playHistory` belonging to the trick that is currently in progress.

Trick-boundary rule (matches engine semantics in `big2-engine.ts`): a trick ends the moment a pass causes `consecutivePasses >= activePlayerCount - 1`; the engine then clears `lastPlay`, sets `isFreePlay = true`, and the trick winner leads a fresh trick. Because active-player count changes as players finish, exactly replaying that count client-side is fragile. Instead we use a **deterministic structural rule** that does not require tracking active-player count:

> Walk `playHistory` from the end backwards. The current trick is the suffix consisting of the **trailing run of consecutive passes plus the most recent `play` entry and everything after it, up to but not including the play that the previous trick was won on.**

Concretely, this reduces to a simpler, robust forward segmentation the implementer should use:

- A trick is "closed" when, scanning forward, a `play` entry is followed only by `pass` entries until the next `play` entry AND the number of those passes is enough to have ended the trick. We cannot know that count reliably client-side.

Because the count-based rule is not reliably derivable from `Big2HistoryEntry[]` alone, the **chosen approach** is:

**Use the live `lastPlay` / `isFreePlay` signal as the anchor and segment only the trailing window.** The current trick = the contiguous suffix of `playHistory` ending at the last `play` entry whose `cards` match `lastPlay.cards` (by rank+suit set) and `playerId === lastPlay.playerId`, extended forward to include any trailing passes, and extended backward to include every entry since the previous trick-clearing boundary.

To make backward extension deterministic without active-count, the component segments using this invariant the engine guarantees: **a trick contains exactly one leading play after a free play, then alternating plays/passes, and ends with the trick winner's play followed by N passes that the engine consumed to reset.** Since the reset entries (the passes that closed the prior trick) are themselves in `playHistory`, the current trick begins at the **first `play` entry that appears after the last maximal run of passes that immediately precedes the segment containing `lastPlay`**.

**Recommendation (resolve ambiguity with the simplest correct rule):** segment by re-deriving boundaries from the players list, which the component already has. The component receives `players` (active + finished). Active count at any point is hard to reconstruct historically, so adopt the following pragmatic rule that is correct for the overwhelmingly common case and degrades gracefully:

- **Current trick = the suffix of `playHistory` starting immediately after the most recent boundary**, where a boundary is detected as **a `pass` entry immediately followed by a `play` entry that begins a new lead** (i.e., index `i` is a boundary if `entry[i].action === "pass"` and `entry[i+1].action === "play"` and there is no earlier `play` in the same uninterrupted lead). See Edge Cases for the degenerate scenarios and the exact tie-break.

> NOTE TO IMPLEMENTER / OPEN POINT: The cleanest, unambiguous fix is a 1-field server addition — a `trickStartIndex: number` on `Big2PublicState` (index into `playHistory` where the current trick began), set by the engine wherever it resets `isFreePlay = true`. This makes client derivation trivial and exact (`playHistory.slice(trickStartIndex)`), removes all heuristic risk, and is information-safe (no hidden data). **This LLD specifies the frontend-only derivation per the approved scope, but flags `trickStartIndex` as the recommended robust alternative** — if the design reviewer agrees, prefer it. Decision is escalated to the reviewer/CEO since the selection note constrained this to frontend-only.

**Visual direction (approved mockup — do not re-litigate).** Collapsed = a **stacked** card pile (layered/fanned cards reading as a physical pile), NOT a fading horizontal trail and NOT scattered cards (both rejected). The **top** of the collapsed pile shows the **most recently played** play (reviewer's nonblocking suggestion, adopted). A gold count badge shows the number of plays/passes in the current trick. Clicking/tapping expands an overlay fanning every play in the current trick in play order, passes shown inline.

**No new server round-trips, no new socket events.** Everything is computed from data already in `EnrichedPlayerView.gameSpecificPublicState`.

## Interfaces / Types

No changes to `src/shared/big2-types.ts` (unless the `trickStartIndex` option above is adopted by review).

New component: `src/frontend/component/game-ui/TrickPile.vue`

Props:

```ts
defineProps<{
  // Full cumulative history from Big2PublicState.playHistory
  playHistory: readonly Big2HistoryEntry[];
  // Live anchor signals used to bound the current trick
  lastPlay: Big2Play | null;
  isFreePlay: boolean;
  // For resolving displayName fallbacks (already available in PlayArea)
  players: readonly PlayerPublicInfo[];
}>();
```

Internal derived type (component-local, not shared):

```ts
interface TrickEntry {
  playerId: PlayerId;
  displayName: string;
  action: "play" | "pass";
  cards?: readonly Card[];
  handType?: HandTypeKind;
}
// currentTrick: computed<TrickEntry[]> derived from playHistory (see State Model)
```

Component-local computed values:

- `currentTrick: TrickEntry[]` — entries belonging to the in-progress trick, in play order (oldest → newest).
- `playEntries: TrickEntry[]` — `currentTrick.filter(e => e.action === "play")`.
- `passCount: number` — count of `pass` entries in `currentTrick`.
- `badgeCount: number` — total entries in the trick to show in the gold badge (spec: number of plays in current trick; passes surfaced inside the expanded overlay). Final choice in Edge Cases.
- `expanded: ref<boolean>` — collapsed vs. expanded overlay state.

Component emits: none. Self-contained toggle state.

`PlayArea.vue` changes:

- Accept and forward `playHistory`, `isFreePlay` (in addition to existing `lastPlay`, `players`). `GameBoard.vue` already has `big2State` and passes `lastPlay`/`players`; add `:play-history="big2State?.playHistory ?? []"` and `:is-free-play="big2State?.isFreePlay ?? true"`.
- Render `<TrickPile>` beside `play-area__cards`.

Reuse existing `GameCard.vue` (`size="small"` for the pile, `size="medium"` in the expanded overlay) — do not create new card-rendering code. Reuse `HAND_TYPE_LABELS` and `SUIT_SYMBOLS` patterns already present in `PlayArea`/`GameLog`.

## State Model

- **No persisted state.** Server-authoritative `InternalGameState`/`Big2State` are untouched. Nothing new is written to Supabase.
- **No new in-memory server state, no new socket payload fields.**
- **Source of truth:** `Big2PublicState.playHistory` (already sent in `EnrichedPlayerView.gameSpecificPublicState`), plus live `lastPlay` and `isFreePlay`.
- **Derived, ephemeral, client-only:** `currentTrick` is recomputed reactively whenever `playHistory`/`lastPlay`/`isFreePlay` change. `expanded` is local UI state.

**Current-trick derivation algorithm (deterministic, frontend-only):**

1. If `playHistory` is empty → `currentTrick = []`. Render empty/hidden pile.
2. Find the index of the trick's first entry by scanning **backward** from the end:
   - Let `n = playHistory.length`.
   - The trick currently in progress begins right after the previous trick was won. Identify the previous boundary: scan backward to find the **last index `b` such that `playHistory[b]` is a `pass` AND it terminates a maximal pass-run that closed the prior trick** — operationally, the trick start is the index of the **most recent `play` entry that is the leader of the current trick.** Because the leader is the first `play` after a free play, and `isFreePlay`/`lastPlay` give us the live boundary, use: start = index after the last contiguous trailing-or-internal pass-run that precedes the earliest play of the current uninterrupted lead.
3. **Implementer simplification (authoritative for this LLD):** because robust backward segmentation from `Big2HistoryEntry[]` alone is error-prone, derive the trick start as follows and treat it as the spec:
   - Walk forward, maintaining a running segment. Start a new segment whenever the previous entry was a `pass` and the current entry is a `play` **and** the current entry's player differs from / re-leads (heuristic). Keep the **last** segment as `currentTrick`.
   - Validate the result against the live anchor: the last `play` in `currentTrick` MUST equal `lastPlay` (same `playerId` and same card set) when `lastPlay !== null`; if it does not match, fall back to "current trick = entries after the last `play` whose cards equal `lastPlay`, inclusive" so the displayed pile always agrees with the centered current play.
   - If `isFreePlay === true` and `lastPlay === null` (a fresh trick just opened and no one has played yet), `currentTrick = []` — the pile is empty and hidden; the centered area shows the existing "New Trick" message.

> The two-step "derive then validate against `lastPlay`" guarantees the pile never contradicts the authoritative centered play, which is the user-visible correctness bar. The OPEN POINT above (`trickStartIndex`) would replace steps 2–3 with `playHistory.slice(trickStartIndex)`.

**Reactivity:** all computed; no watchers needed except optional auto-collapse of the overlay when `playHistory` length changes (so a new play closes a stale expanded overlay). Specify: when `currentTrick` resets to `[]` (new trick), force `expanded = false`.

## Edge Cases

1. **Empty history (game just started, first play not yet made):** `playHistory = []` → pile hidden. Centered area shows existing "New Trick — Play any combination".
2. **Fresh trick, no plays yet (someone just won a trick):** `isFreePlay === true && lastPlay === null` → `currentTrick = []` → pile hidden. Centered area shows the lead prompt.
3. **Single play in trick (only the leader has played):** pile shows 1 card stack; badge count = 1; expanding shows just that play. Pile is still rendered (it conveys "1 play so far"). Acceptable; it is visually distinct from the centered current play because the centered play already shows the same cards — see #4.
4. **Pile vs. centered `lastPlay` duplication:** the most recent play is shown BOTH as the centered current play and as the **top** of the collapsed pile. This is intentional per the approved mockup (top of pile = most recent). The expanded overlay also includes it. Do not dedupe.
5. **Passes in the trick:** passes are NOT cards, so they do not appear as cards in the collapsed stack. They are represented **inline in the expanded overlay** (e.g., a "Pass — {name}" chip in play order). Collapsed badge: show **count of plays** (cards) by default; if the trick contains passes, optionally annotate (decision: badge = number of plays; passes visible only when expanded — keeps the collapsed badge unambiguous as "N cards/sets played this trick").
6. **Long trick (4 players, many plays):** collapsed stack caps visible layered cards (e.g., max 4–5 offset layers; deeper plays simply stack under). Expanded overlay must scroll/wrap if it overflows the viewport (especially mobile). Specify max-height with overflow handling.
7. **Trick reset mid-view:** if the overlay is expanded and a new trick starts (`currentTrick` becomes `[]`), force-collapse and hide the pile (no stale overlay).
8. **Player finishes mid-trick:** finished players' earlier plays remain in `currentTrick` until the trick resets — correct, they are part of this trick's history. No special handling.
9. **Reconnection / late join:** `playHistory` is full and authoritative on (re)connect; derivation runs on whatever history is present. No special handling.
10. **Mobile layout:** the collapsed pile must fit the constrained `table` grid cell (see `GameBoard.vue` mobile grid). Pile should shrink (smaller cards / fewer offset layers) and remain tappable (min 44×44 tap target on the toggle, per existing mobile conventions). The expanded overlay should present full-width-ish with scroll.
11. **Spectator view:** `EnrichedSpectatorView.gameSpecificPublicState` carries the same `Big2PublicState` shape, but `GameBoard.vue` here is the player board only. Spectator integration is **out of scope** for this LLD (deferred); note for a follow-up so the spectator board can reuse `TrickPile` unchanged (it is purely presentational from public state).
12. **Reduced motion:** expand/collapse and any pile transition must respect `prefers-reduced-motion: reduce` (disable transitions), matching the existing pattern in `GameBoard.vue`.
13. **Derivation/anchor mismatch:** if the heuristic segment's last play does not match `lastPlay`, fall back to anchoring on `lastPlay` (State Model step 3) so the pile never contradicts the centered play.

## Dependencies

- **Reads from existing code (no upstream LLD blocking):**
  - `src/shared/big2-types.ts` — `Big2PublicState`, `Big2HistoryEntry`, `Big2Play`, `HandTypeKind`.
  - `src/shared/engine-types.ts` — `Card`, `PlayerId`, `PlayerPublicInfo`.
  - `src/frontend/component/game-ui/PlayArea.vue` — host component (modified).
  - `src/frontend/component/game/GameBoard.vue` — passes `big2State.playHistory` / `isFreePlay` into `PlayArea` (modified).
  - `src/frontend/component/game-ui/GameCard.vue` — reused as-is (`size` prop already supports `small`/`medium`).
  - `src/styles/game-variables.css` — existing CSS tokens (`--gold-accent`, `--card-*`, etc.).
- **Approved mockup:** the committed "click-to-expand trick pile" mockup (frontend reviewer approved). Build exactly that; mockup step is satisfied.
- **No backend, engine, DB, or socket dependencies** unless the optional `trickStartIndex` server field (OPEN POINT) is adopted at review — that would add a small edit to `big2-engine.ts` + `big2-types.ts` and is the only path that touches the server.

## Test Requirements

Per `docs/testing-principles.md`, this is a frontend presentational change driven by pure data; bias toward automated assertions over manual where computed state/DOM can be checked.

**Unit (component logic — current-trick derivation, the core risk):**

- `playHistory = []` → `currentTrick = []`, pile hidden.
- `isFreePlay && lastPlay === null` → `currentTrick = []`, pile hidden.
- Single play, no passes → `currentTrick` has 1 play; badge = 1; top of pile = that play.
- Multiple plays in a trick → `currentTrick` ordered oldest→newest; collapsed top = most recent play (matches `lastPlay`).
- Trick with interleaved passes → passes excluded from collapsed card stack; present in expanded overlay in order; badge = number of plays.
- New trick after a trick-clearing pass run → previous trick's entries excluded; `currentTrick` contains only the new lead onward.
- Derivation/anchor mismatch fallback → when the heuristic segment disagrees with `lastPlay`, derived trick still ends at `lastPlay` (assert last play in `currentTrick` equals `lastPlay`).
- Player finishes mid-trick → their earlier play remains in `currentTrick`.

**Unit (rendering / interaction):**

- Collapsed pile renders N layered `GameCard`s (one per play, capped) with most-recent on top.
- Clicking/tapping the pile toggles `expanded`; overlay fans all plays in order with pass chips inline.
- New play arriving while expanded with a trick reset force-collapses the overlay.
- Badge shows correct count and is hidden when `currentTrick` is empty.

**Integration (component within GameBoard, using EnrichedPlayerView fixtures):**

- `GameBoard` forwards `playHistory`/`isFreePlay` to `PlayArea` → `TrickPile`; pile reflects state across a simulated sequence of plays and a trick reset.
- Centered current play and pile top never contradict each other across a sequence.

**Security / information hiding:**

- Assert `TrickPile` consumes only public `Big2PublicState` data (`playHistory`, `lastPlay`, `isFreePlay`, public player info) and never references any hand/hidden field. (Lightweight: a test that the component's props/usage contain no hand data; primarily enforced by it only receiving public-state props.)

**Manual (visual only — cannot be asserted in DOM):**

- Stacked-pile visual reads as a physical pile (not a trail, not scattered) on desktop and mobile.
- Expanded overlay layout/scroll on a small mobile viewport.
- `prefers-reduced-motion` disables transitions.

## Frontend Design

Approved design = the committed **"click-to-expand trick pile"** mockup (frontend reviewer approved). Build exactly this; the visual direction is settled and must not be re-litigated.

- **Collapsed pile:** a **stacked** pile of cards (layered/fanned, reading as one physical pile) sitting **beside** the centered current play in the table area (left side / corner per mockup). The **TOP card of the pile is the MOST RECENTLY played play** — this is the reviewer's one nonblocking suggestion, adopted (not the first card of the trick). Earlier plays stack beneath with a small offset. Explicitly NOT a fading horizontal trail and NOT scattered cards (both prior directions were rejected by the user).
- **Gold count badge:** a small gold badge on the pile showing the number of plays in the current trick (passes surfaced in the expanded view, not the badge).
- **Expanded overlay:** clicking/tapping the pile opens an overlay that **fans every play in the CURRENT trick in play order**, with **passes represented inline** (e.g., a muted "passed" chip with the player's name positioned in sequence). Tapping outside / a close affordance / Escape collapses it (match the existing log-drawer Escape handling pattern in `GameBoard.vue`).
- **Reset behavior:** the pile and badge **reset when a new trick starts** (derived: `currentTrick` becomes empty). When empty, the pile is hidden and the centered area keeps showing the existing "New Trick" prompt.
- **Reuse + tokens:** reuse `GameCard.vue` (`size="small"` collapsed, `size="medium"` expanded) and existing CSS variables (`--gold-accent`, `--card-*`, `--panel-bg`, `--text-muted`). Match the felt/gold visual language already in `PlayArea`/`GameBoard`.
- **Responsiveness:** pile fits the desktop `table` grid cell and shrinks gracefully in the mobile grid (`GameBoard.vue` mobile media query); toggle is a ≥44px tap target; overlay scrolls if it overflows on mobile.
- **Motion:** transitions respect `prefers-reduced-motion: reduce`.
- **Scope:** Big2 only. No universal cross-game component (rejected — Tonk's discard pile is a different concept).
