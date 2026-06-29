# LLD 99: Tonk Player Actions UI (discard, draw, tonk declaration)

**Status:** Draft for review. Parent #41, order 4 of 5. Depends on #58 (Tonk board rendering, LLD 88 — merged PR #98).

This LLD adds the interactive action layer to the read-only Tonk board (LLD 88). It turns `TonkBoard.vue` into a fully playable surface, driven entirely by the server's `validActions` per turn phase. No new transport events, no schema changes, frontend-only.

---

## Scope

### Covers

- A **Tonk action panel** (`TonkActionPanel.vue`) that renders into the existing `tonk-board__actions` footer slot and **morphs its controls by `turnPhase`**:
  - **Discard phase:** a text-only **Discard** button (armed by hand selection); plus a **Call TONK** button when `callTonk` is present in `validActions` (gate open).
  - **Draw phase:** a **Draw stock** button and a **Take discard** button (the latter rendered only when `drawableDiscard !== null`).
- A **"1 Discard → 2 Draw" phase stepper** at the top of the panel showing turn progress (Direction A, approved).
- **Same-rank multi-discard hand selection** in `TonkHand.vue`: tap to select one or more same-rank cards; non-matching cards are visually dimmed; a mixed-rank selection is visually flagged (bad-select) but **the server is the sole authority** — the Discard button still dispatches and a server rejection drives the inline error.
- **Three Tonk action emitters** added to the existing `useGameActions` composable (`discard`, `drawCard`, `callTonk`), all over the existing `game:action` WebSocket channel using the Tonk engine's action shapes.
- **Inline error display** in the panel on server rejection, **preserving the player's selection** so they can adjust.
- Wiring in `GameView.vue` to pass selection/dispatch handlers down to `TonkBoard.vue`, and in `TonkBoard.vue` to host the panel and the interactive hand.
- Touch-usable controls on mobile (≥44px targets, reuse existing footer responsive rules).

### Explicitly does NOT cover

- **No spread/meld creation, no hit/lay-off, no drop/knock.** These mechanics do not exist in this variant (LLD 65 §1).
- **No client-side Tonk rule validation.** The client never decides if a discard is legal, if the gate is open, or if a draw source is allowed beyond what `validActions` / `drawableDiscard` already tell it. All authority is server-side (LLD 65 §6.2, §8).
- **No new socket events.** Reuses `game:action` only (LLD 65 transport contract).
- **No backend, engine, DB, API, or migration changes.** The engine (#57), action shapes, `validActions`, and `getPlayerView` already exist. This LLD must not touch the prod-migration path (#60).
- **No turn-timer UI changes** (LLD 88 already renders the timer; auto-timeout is server-driven, LLD 65 §7).
- **No game-over / scoring UI** (separate work).
- The **draw-source thumbnail on the Take button** is intentionally omitted — see Frontend Design.

---

## Approach

### A. Server-authoritative, `validActions`-driven (architecture-principles #1, #3)

Every control's **visibility and enabled state derives only from**:

1. `view.validActions` — the action **types** the server currently permits (`discard`, `callTonk`, `draw`), already filtered to the current player and phase by `computeValidActions` (`src/backend/engine/tonk/valid-actions.ts`). Empty when it is not the local player's turn.
2. `tonkState.turnPhase` — which phase shell to render.
3. `tonkState.drawableDiscard` — whether the "Take discard" button is offered at all (`!== null`).

The client does **not** check the TONK gate, same-rank legality, or draw-source legality to decide whether to *submit*. It uses those only for **affordance hints** (dimming, disabling the primary button at count 0). The server's `validateDiscard` / `applyAction` is the authority; a rejection produces the inline error.

> **Why dim mixed-rank but still allow submit?** The mockup dims non-matching cards and flags a mixed selection (`card--badselect`), which is a UX hint, not a rule decision. The Discard button stays clickable on a mixed selection so the **server** returns `"Discard must be a single rank."` and we surface it inline — keeping the client honest to principle #1 (never compute rules in frontend, even for responsiveness). We may disable the Discard button only on the trivially-empty case (`selectionCount === 0`), which is not a Tonk rule but a "nothing to submit" guard.

### B. Reuse the existing composable / socket plumbing (no Tonk special-cases in generic code)

`useGameActions` already owns the `game:action` emit pattern, `actionError`, and `actionPending`. We **add three Tonk methods to it** following the exact shape of `playCards`/`pass` (build the action object with `playerId: ""` — the server overrides `playerId` from the authenticated socket, per the existing Big2 pattern and `GameActionPayload` doc comment). This is additive and game-agnostic at the transport layer — the socket/state composables (`useSocket`, `useGameState`) are untouched.

`useCardSelection` already provides `selectedIndices`, `selectedCards`, `toggleCard`, `clearSelection`, `selectionCount` over a `Ref<readonly Card[]>` hand. Tonk hands may contain jokers (`TonkCard`), so the selection composable's `Card` typing is widened to accept the hand's element type — see Interfaces/Types (option chosen: reuse `useCardSelection` with a `TonkCard`-compatible cast at the call site, mirroring how `TonkBoard` already narrows `you.hand` to `TonkCard[]`).

### C. Component layout (Direction A — Phase Stepper)

```
TonkBoard.vue
  ├─ tonk-board__hand   → TonkHand.vue            (now interactive: selection)
  └─ tonk-board__actions → TonkActionPanel.vue    (NEW — phase-morphing footer)
```

`GameView.vue` owns the selection state (via `useCardSelection`) and the dispatch handlers (via `useGameActions`), exactly as it already does for Big2/`GameBoard`. It passes them into `TonkBoard` as props/emits; `TonkBoard` forwards selection to `TonkHand` and action intents to `TonkActionPanel`. This mirrors the established `GameBoard` wiring (`@toggle-card`, `@play`, `@pass`) so there is no new pattern.

> **Why widen `GameView` rather than self-contain in `TonkBoard`?** `GameView` already instantiates `useGameActions` and `useCardSelection` and binds the socket. Reusing those keeps `actionError`/`actionPending` in one place and avoids a second socket-bound composable instance. `TonkBoard` stays a presentational shell that receives state + emits intents, consistent with LLD 88.

### D. Selection-reset semantics

- On a **successful discard**, clear the selection (the hand changed; `GameView.onDiscard` calls `clearSelection()`, mirroring `onPlay`).
- On a **rejected discard**, keep the selection (so the player can deselect the offending card). `actionError` shows the server message.
- On a **phase change to `draw`** (after our own successful discard) or a **turn change** (it becomes someone else's turn), clear the selection defensively so stale highlights never persist. A `watch` on `(turnPhase, currentPlayerIndex)` in `GameView` handles this — same place the Big2 board would reset.

---

## Interfaces / Types

### Existing action shapes consumed (server-defined — DO NOT redefine)

From `src/backend/engine/tonk/tonk-types.ts` (re-exporting `@shared/tonk-types`). The client builds these and sends via `game:action`:

```ts
// type: "discard" — cards >=1, all same rank (server validates)
{ type: "discard"; cards: readonly TonkCard[]; playerId: "" }
// type: "draw" — source chooses pile; "discard" only when drawableDiscard !== null
{ type: "draw"; source: "stock" | "discard"; playerId: "" }
// type: "callTonk" — only in discard phase, only when in validActions
{ type: "callTonk"; playerId: "" }
```

`TonkDrawSource = "stock" | "discard"` and `TonkCard = Card | TonkJoker` are already in `@shared/tonk-types`. `playerId` is sent as `""`; the server overrides it from the socket identity (existing convention — `useGameActions.playCards`, `GameActionPayload` comment in `socket-events.ts`).

### `useGameActions` additions (`src/frontend/composables/useGameActions.ts`)

Add to `UseGameActionsReturn` and the returned object (each follows the `playCards` template: set `actionError = null`, `actionPending = true`, emit `game:action`, resolve the ack, set `actionError` on failure):

```ts
discard(
  gameId: string,
  cards: readonly TonkCard[],
): Promise<{ success: boolean; error?: string }>;

drawCard(
  gameId: string,
  source: TonkDrawSource,
): Promise<{ success: boolean; error?: string }>;

callTonk(
  gameId: string,
): Promise<{ success: boolean; error?: string }>;
```

Action objects emitted (spread into `GameActionPayload.action`, matching `playCards`):

- `discard` → `{ type: "discard", cards: [...cards], playerId: "" }`
- `drawCard` → `{ type: "draw", source, playerId: "" }`
- `callTonk` → `{ type: "callTonk", playerId: "" }`

Default error strings when the ack omits one: `"Invalid discard"`, `"Cannot draw"`, `"Cannot call TONK"`. `actionError`/`actionPending` are the existing shared refs — no new error channel.

### `useCardSelection` (widening for jokers)

`useCardSelection` is typed over `Ref<readonly Card[]>`. The Tonk hand is `readonly TonkCard[]`. Choose **option 1** (recommended): change the composable's generic surface to `readonly (Card | TonkCard)[]` — additive, since `Card` is assignable to `TonkCard`. Big2 callers are unaffected (a `Card[]` satisfies `(Card | TonkCard)[]`). `selectedCards` returns the same element type as the input hand. This keeps one selection composable instead of forking a Tonk-specific one.

Alternative (rejected): a parallel `useTonkCardSelection`. Rejected as duplication for zero behavioral difference — selection is index-based and rank-agnostic; the only rank logic (same-rank dimming) lives in the component, not the composable.

### `TonkHand.vue` prop additions

`TonkHand` becomes interactive. New props (all optional so the spectator/read-only render is unchanged):

```ts
defineProps<{
  cards: readonly TonkCard[];
  selectable?: boolean;            // true only on the local player's discard phase + your turn
  selectedIndices?: ReadonlySet<number>;
  dimmedIndices?: ReadonlySet<number>;   // non-matching-rank hint (see below)
  badSelect?: boolean;             // selection spans >1 rank → error styling on selected cards
}>();
const emit = defineEmits<{ toggle: [index: number] }>();
```

- When `selectable`, each `GameCard` gets `:interactive="true"`, `:selected="selectedIndices.has(index)"`, and `@click="emit('toggle', index)"`. `GameCard` already supports `interactive` + `selected` styling (gold lift).
- `dimmedIndices` / `badSelect` are **presentational hints computed in `TonkActionPanel`/`TonkBoard`**, not rules: dimmed = "a same-rank group is selected and this card is a different rank"; badSelect = "the current selection itself spans multiple ranks." Both are derived purely from the selected cards' ranks (a display transformation of state, allowed by LLD 88's display-helper boundary), and neither gates submission.

### `TonkActionPanel.vue` (NEW)

```ts
defineProps<{
  validActions: readonly ValidAction[];   // from view.validActions
  turnPhase: TonkTurnPhase;
  isMyTurn: boolean;
  selectionCount: number;                  // selected card count (discard phase)
  drawableDiscard: TonkCard | null;        // null → no "Take discard" button
  stockCount: number;                      // shown as a sub-label on Draw stock
  currentPlayerName: string;               // for the "X is taking their turn…" pill
  actionError?: string | null;
  actionPending?: boolean;
}>();
const emit = defineEmits<{
  discard: [];        // GameView reads selectedCards and calls useGameActions.discard
  draw: [source: TonkDrawSource];
  callTonk: [];
}>();
```

Derived (computed) flags — all from `validActions` + `turnPhase`, never from rule re-computation:

- `canDiscard = validActions.some(a => a.type === "discard")`
- `canCallTonk = validActions.some(a => a.type === "callTonk")`
- `canDraw = validActions.some(a => a.type === "draw")`
- Discard button `:disabled = !isMyTurn || selectionCount === 0 || actionPending`
- Call TONK button `:disabled = !isMyTurn || actionPending` (rendered only when `canCallTonk`)
- Draw stock button `:disabled = !isMyTurn || actionPending`
- Take discard button rendered only when `canDraw && drawableDiscard !== null`; `:disabled = !isMyTurn || actionPending`

### `TonkBoard.vue` / `GameView.vue` prop & emit additions

`TonkBoard` gains props for the local-player interactive layer and re-emits intents:

```ts
// new props on TonkBoard
selectedIndices: ReadonlySet<number>;
selectionCount: number;
actionError: string | null;
actionPending: boolean;
// new emits on TonkBoard
toggleCard: [index: number];
discard: [];
draw: [source: TonkDrawSource];
callTonk: [];
```

`GameView` binds these to `useCardSelection` + `useGameActions` (new `onDiscard`, `onDraw`, `onCallTonk` handlers alongside the existing `onPlay`/`onPass`). `GameView` passes the existing `selectedIndices`/`selectionCount`/`actionError`/`actionPending` it already holds.

---

## State Model

All state is **server-derived and already flowing**; this LLD adds only **client-local ephemeral selection** state. Nothing new is persisted; nothing new is in-memory on the server.

| State | Owner | Lifetime | Source |
| --- | --- | --- | --- |
| `view.validActions` | server → `useGameState` | per `game:state` event | `getPlayerView` (LLD 65 §6.2) |
| `tonkState.turnPhase`, `drawableDiscard`, `stockCount`, etc. | server → `TonkPublicState` | per `game:state` event | `getPlayerView` |
| `you.hand` (`TonkCard[]`) | server → `useGameState` | per `game:state` event | `getPlayerView` (your hand only) |
| `selectedIndices` | `useCardSelection` (client) | until cleared (success / phase / turn change) | local |
| `actionError`, `actionPending` | `useGameActions` (client) | per dispatch round-trip | local |

**Flow of one turn (the same player acts twice):**

1. `game:state` arrives with `turnPhase: "discard"`, `validActions: ["discard"(, "callTonk")]`. Panel shows the Discard button (+ TONK if gated open). Stepper highlights step 1.
2. Player taps same-rank cards → `selectedIndices` grows; non-matching cards dim; Discard arms with a count badge.
3. Player taps **Discard** → `GameView.onDiscard` → `useGameActions.discard(gameId, selectedCards)` → `game:action`. On success the server sends a new `game:state` with `turnPhase: "draw"` (still this player's turn) and clears selection client-side. On rejection, inline error shows, selection preserved.
4. Panel re-renders for `turnPhase: "draw"`, `validActions: ["draw"]`. Stepper marks step 1 done, step 2 active. Shows **Draw stock** and (if `drawableDiscard !== null`) **Take discard**.
5. Player taps a draw button → `useGameActions.drawCard(gameId, source)` → `game:action`. On success the server hands the turn off (next seat); a new `game:state` arrives; the panel becomes the not-your-turn pill.
6. **TONK alternative:** in step 1, if `callTonk` is in `validActions`, tapping **Call TONK** dispatches `callTonk` instead of discarding; the trick ends server-side. TONK is never offered in the draw phase (it is never in `validActions` there).

**Reconnection / spectator:** unchanged from LLD 88. A spectator-style render (`myPlayerIndex === -1`) has no own hand and no `validActions` for itself, so the panel renders nothing actionable (the not-your-turn pill / disabled shell). `selectable` is false.

---

## Frontend Design

**Approved direction: Direction A — Phase Stepper** (mockup `docs/mockups/tonk-player-actions-ui.html`, commit `8ed4606` on branch `lld-71-tonk-player-actions-ui`). It reuses the existing footer-bar slot (`tonk-board__actions` / the Big2 `game-board__actions` shell) and morphs its buttons per `turnPhase`. Lowest layout risk; matches the live felt-table aesthetic (same tokens, fonts, `GameCard`).

The panel contains, top-to-bottom:

1. **Inline error** (`tonk-action-panel__error`) — shown only when `actionError` is set. **KEEP** the rejection message (e.g. *"Discard must be a single rank…"*) — required feedback.
2. **Phase stepper** — `1 Discard → 2 Draw`. Step 1 active in discard phase; step 1 done (✓) + step 2 active in draw phase. Pure derivation of `turnPhase`.
3. **Buttons** — phase-dependent (below).
4. When **not your turn:** a quiet "{name} is taking their turn…" pill and a disabled Discard button (the mockup's state G).

**User-specified tweaks (honored exactly):**

- **Take discard button is TEXT-ONLY.** Do **NOT** repeat the drawable card thumbnail on the button. #58 (the A1 choice in LLD 88) already renders the drawable discard card in its own cyan-ringed board slot (`TonkPiles.vue` "drawable" slot). The button reads **"Take discard"** with no card pip. (This diverges from the mockup's E state, which showed a mini card on the button — the divergence is intentional and user-directed.)
- **DROP the footer prompt text.** Do **NOT** render the `action-panel__prompt` line (e.g. *"Your hand is low (6). Discard, or call TONK…"*, *"Three Queens selected…"*, *"Draw one card to finish your turn."*). The buttons + stepper are self-explanatory. Also drop the `gate-hint` ("TONK unlocks after everyone has had a turn") — gate state is conveyed by the TONK button simply appearing/not appearing.

**Button spec per state (Direction A, with tweaks):**

| `turnPhase` | gate | `drawableDiscard` | Buttons rendered |
| --- | --- | --- | --- |
| discard | closed | — | **Discard** (primary, text-only, count badge when `selectionCount > 1`) |
| discard | open | — | **Call TONK** (quiet/secondary) + **Discard** (primary) |
| draw | — | `null` | **Draw stock** (primary, `"{n} face-down"` sub) + **Take discard** (disabled, `"none available"` sub) |
| draw | — | non-null | **Draw stock** (primary) + **Take discard** (ghost, text-only) |

- **Call TONK** uses the quiet/secondary `--tonk` style (transparent, red outline) — **never** the visual primary, so it is not the accidental default action (the issue's hard constraint d). Discard remains the gold primary.
- **Count badge** on Discard shows the number of selected cards (only meaningful for multiples); follows the mockup's `count-badge`.
- **Selection styling in the hand** (LLD 88 `GameCard` tokens reused): selected = gold lift (`card--selected`); non-matching rank when a group is selected = dimmed (`tonk-hand__card--dimmed`, opacity ~0.42); a mixed-rank selection flags selected cards with error styling (`tonk-hand__card--badselect`, red lift) as a hint — submission still allowed, server rejects.

**Touch/mobile:** all buttons ≥44px min-height (mockup `.btn { min-height: 44px }`), reuse the existing `--mobile-actions-height` footer rules already on `tonk-board__actions`. Hand cards are large tap targets (`TonkHand` already uses `size="large"` with horizontal scroll). Buttons wrap (`flex-wrap`) so a two-button row never overflows on narrow screens.

---

## Edge Cases

| # | Case | Handling |
| --- | --- | --- |
| E1 | Not your turn | `validActions` is empty (server). All buttons disabled; not-your-turn pill shown; hand `selectable=false`. |
| E2 | Discard phase, nothing selected | Discard button disabled (`selectionCount === 0`) — a "nothing to submit" guard, not a rule check. |
| E3 | Mixed-rank selection | Cards flagged `badSelect` (red); Discard stays enabled; on tap the **server** rejects with `"Discard must be a single rank."` → inline error, **selection preserved**. |
| E4 | Same-rank multiples (e.g. 3 Queens) | All selected (gold lift); other ranks dimmed; Discard shows count badge `3`; dispatches `{ type: "discard", cards: [Q♣,Q♦,Q♠] }`. |
| E5 | Discard a card not in hand / stale selection after re-render | Cannot happen via UI (selection is by index into the current hand). If the server still rejects (`"Cards not in hand."`), the inline error shows; selection cleared on the next `game:state` only if hand changed. |
| E6 | TONK gate closed | `callTonk` absent from `validActions` → Call TONK button not rendered (no client gate math). |
| E7 | TONK gate open | `callTonk` present → quiet Call TONK button rendered alongside Discard. Tapping dispatches `callTonk`; trick ends server-side. |
| E8 | TONK in draw phase | Impossible — server never includes `callTonk` in draw-phase `validActions`; the panel's draw shell has no TONK control. |
| E9 | `drawableDiscard === null` (trick-1 first player / no preceding discard) | Take discard button **rendered disabled** with a `"none available"` sub-label (mockup F). Only Draw stock is actionable. Player can never draw a non-existent discard. |
| E10 | Draw-back-own-discard attempt | Structurally impossible: the only draw-from-discard affordance maps to `source: "discard"`, which the server resolves to the turn-start `drawableDiscard` snapshot (never the player's own just-discarded live top — LLD 65 §3.3, §8.3). The client never lets the player pick a specific pile card. |
| E11 | Spectator-style render (`myPlayerIndex === -1`) | No own hand, no actionable `validActions`. Panel renders the disabled/not-your-turn shell; `selectable=false`. (Consistent with LLD 88 E11.) |
| E12 | Action in-flight (`actionPending`) | All buttons disabled until the ack resolves, preventing double-submit (mirrors `ActionPanel`/Big2). |
| E13 | Server rejection of draw (e.g. empty stock resolved as trick-end) | The draw ack may still succeed (engine resolves Case C); if it returns an error, inline error shows. No client special-casing of stock-out — the next `game:state` reflects the result. |
| E14 | Phase flips to `draw` after our discard | Selection cleared (watch on `turnPhase`); panel morphs to draw shell. Stepper shows step 1 done. |
| E15 | Turn hands off after our draw | Selection cleared (watch on `currentPlayerIndex`); panel becomes not-your-turn pill. |
| E16 | Joker in hand | Selectable like any card; joker groups only with jokers for the same-rank dimming hint (uses `isJoker`); `GameCard` already renders the joker face. Server enforces the joker-grouping rule. |
| E17 | Rapid re-render mid-selection (new `game:state` while selecting, e.g. spectator-count event) | `selectedIndices` is index-based; a `game:state` that doesn't change the hand leaves indices valid. If the hand changes (only on our own successful discard), selection is cleared by the success handler. |

---

## Dependencies

Must exist before implementation (all present in this worktree):

- **#58 / LLD 88 — Tonk board rendering** (merged PR #98): `TonkBoard.vue`, `TonkHand.vue`, `TonkPiles.vue` (drawable slot), `TonkPhaseBanner.vue`, `tonkDisplay.ts`, `GameCard.vue` (interactive/selected support). This LLD extends them.
- **Tonk engine action shapes & `validActions`** (#57): `TonkDiscardAction`/`TonkDrawAction`/`TonkCallTonkAction` and `computeValidActions` in `src/backend/engine/tonk/`. Consumed as-is; not modified.
- **`@shared/tonk-types`**: `TonkCard`, `TonkJoker`, `TonkDrawSource`, `TonkTurnPhase`, `TonkPublicState`, `isJoker`. Consumed as-is.
- **`useGameActions`** (`src/frontend/composables/useGameActions.ts`): extended with `discard`/`drawCard`/`callTonk`.
- **`useCardSelection`** (`src/frontend/composables/useCardSelection.ts`): generic surface widened to `Card | TonkCard`.
- **`game:action` channel** (`@shared/socket-events` `GameActionPayload`): reused verbatim; no new events.
- **`GameView.vue`**: wires selection + dispatch into `TonkBoard` (mirrors its existing `GameBoard` wiring).

No dependency on #60 (prod migration), the `deckRoundsTarget` plumbing (§8.8), or any DB/API change.

---

## Test Requirements

Per testing-principles: bias to automated tests; the existing Tonk frontend tests (`tests/frontend/tonk*.test.ts`) transcribe component computeds and test them in isolation (the project pattern — see `tonkBoardDispatch.test.ts`, `tonkDisplay.test.ts`). Follow that pattern: extract the panel's derivation logic and test it as pure functions / mounted-component assertions. No new backend tests (no backend change).

### Unit — `TonkActionPanel` button derivation (the security-relevant boundary)

- Discard phase, gate closed: only the Discard button is present; Call TONK absent; Draw buttons absent.
- Discard phase, gate open (`callTonk` in `validActions`): Discard **and** Call TONK present; Call TONK uses the secondary `--tonk` style (assert class, not the primary class) so it is never the visual default.
- Draw phase: Draw stock present; Take discard present **iff `drawableDiscard !== null`**, and disabled when `null`.
- Discard button disabled when `selectionCount === 0` or `!isMyTurn` or `actionPending`.
- All buttons disabled when `!isMyTurn` (validActions empty) regardless of phase.
- All buttons disabled when `actionPending` (no double-submit).
- Inline error renders iff `actionError` is set; the prompt text and gate-hint are **absent** in all states (regression guard for the two user tweaks).
- Take discard button is **text-only** (no card/pip element inside it) — regression guard for the user tweak.

### Unit — same-rank selection hints (pure derivation)

- Given a selected set of all-same-rank indices, the dimmed set = all other-rank indices; `badSelect = false`.
- Given a selected set spanning ≥2 ranks, `badSelect = true` (and the selected cards carry error styling); submission is **not** blocked by this flag.
- Jokers: selecting a joker dims all non-joker cards; selecting joker + a ranked card sets `badSelect`.
- Empty selection: no dimming, `badSelect = false`, Discard disabled.

### Unit — `useGameActions` Tonk emitters

- `discard(gameId, cards)` emits `game:action` with `{ type: "discard", cards, playerId: "" }`; resolves the ack; sets `actionError` from a failed ack (default `"Invalid discard"`), `actionPending` toggles around the round-trip.
- `drawCard(gameId, "stock")` and `drawCard(gameId, "discard")` emit `{ type: "draw", source, playerId: "" }`.
- `callTonk(gameId)` emits `{ type: "callTonk", playerId: "" }`.
- (Mock the socket ack — do not boot a real server, per testing-principles #1 and the existing composable test style.)

### Unit — `useCardSelection` joker widening (regression)

- A `TonkCard[]` hand (including a joker) toggles/selects by index; `selectedCards` returns the joker objects; Big2 `Card[]` usage still compiles and behaves identically (type-level regression — covered by the build + a small selection test).

### Component / integration — turn flow (mounted `TonkBoard` or `GameView` slice)

- Discard → draw morph: with `turnPhase: "discard"` then `"draw"`, the rendered button set changes and the stepper advances (step 1 done, step 2 active).
- On a successful discard emit (mocked ack success), selection is cleared; on a rejected discard, selection is **preserved** and the inline error shows.
- Tapping Draw stock emits `draw` with `"stock"`; tapping Take discard (when enabled) emits `draw` with `"discard"`.
- Not-your-turn (`validActions` empty): the not-your-turn pill renders, hand is non-`selectable`, buttons disabled.

### Manual (visual/UX only — minimal, per testing-principles #5/§decision-heuristics)

- Mobile: buttons are ≥44px and tappable; two-button rows wrap rather than overflow on a narrow viewport (use `?debug` overlay if helpful).
- Selected-card gold lift, dimmed non-matching, and red bad-select styling are visually distinct on the felt background.

(Information-leakage tests are not added here: this is a pure consumer of the already-filtered `getPlayerView`; the engine's existing info-hiding tests cover the boundary. No hidden state is introduced client-side.)
