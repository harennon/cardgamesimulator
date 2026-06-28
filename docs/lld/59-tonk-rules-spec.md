# LLD 59: Tonk (Tunk) Rules Specification

> **STATUS: DRAFT — HARD GATE.** This is a docs-only deliverable. **No engine code may be
> written until the user explicitly signs off on the chosen variant below.** Tonk has many
> regional variants; getting the rules wrong poisons every downstream sub-issue of #41. The
> architect is presenting one variant for approval — not silently assuming one. See
> [Variant Sign-Off](#variant-sign-off) at the end.

## Scope

**Covers:** The exact Tonk variant we will implement — deck, players, deal, point values, all
win conditions, spread/hit rules, drop/knock + caught-drop scoring, single-hand vs match
scoring, turn structure (draw+discard), turn-timer auto-action semantics, and information-hiding
expectations. It also maps every rule onto the existing `GameEngine` interface and flags any rule
that does not map cleanly (leaking-abstraction risk).

**Does NOT cover:** Engine implementation, action/state TypeScript definitions beyond
illustrative sketches, frontend/UI, WebSocket wiring, or stats plumbing changes. Those are
downstream sub-issues of #41. The type signatures shown here are illustrative targets for the
engine LLD (#41.2), not a final API.

This spec is written so the engine LLD can be authored from it with **no rules TBDs**.

---

## Approach

### Chosen variant (the simplest defensible common Tonk)

We implement **classic 2–4 player Tonk with a single 52-card deck, 5-card deal, draw-then-discard
turns, spreads + hitting, drop/knock with under-cut penalty, and a multi-hand match to a target
score.** This is the most widely documented common ruleset and maps cleanly onto our turn-based,
server-authoritative engine. Rationale for each major choice is given inline below; the few
genuinely contested points are called out with the alternative and why we rejected it.

The driving constraint is the **existing `GameEngine` interface** (`initialize`,
`validateAction`, `applyAction`, `getPlayerView`, `getValidActions`, `getAutoTimeoutAction`,
`getSpectatorView`) and the existing **stats pipeline** (`statsService.recordGameCompletion`),
which derives stats purely from `state.winner` (a single `PlayerId | null`) and
`state.scores[].score`. Any rule that would force a second winner, a per-hand stats write, or a
new engine method is a red flag and is resolved here in favor of the simplest mapping.

### Card / rank model reuse

The shared `Card`, `Suit`, and `Rank` types (`src/shared/engine-types.ts`) are reused unchanged.
Tonk needs **point values** and **run adjacency**, not Big2's `RANK_ORDER`. The Tonk engine
defines its own `TONK_POINTS` map and its own ace-low run ordering (see Card Point Values). It
does **not** import Big2's `RANK_ORDER`/`compareCards` (where 2 is high and ace is high) — those
encode Big2 semantics. The 52-card `FULL_DECK` array shape is reusable, but the engine builds its
own deck constant to avoid coupling to Big2 constants.

---

## Rules Specification

### 1. Deck composition and players

- **Deck:** one standard **52-card** deck. No jokers.
- **Players:** **min 2, max 4.** `GameEngineConfig` carries `minPlayers: 2, maxPlayers: 4`.
  `initialize` throws if `players.length` is outside `[2, 4]` (per the interface contract).
- Suits are irrelevant to scoring and to set/run validity beyond the standard "a run is one
  suit" rule. There is no trump.

### 2. Deal, stock, and discard setup

Performed in `initialize` using the injected `PRNG` (server-side shuffle only).

- Shuffle the 52-card deck with the PRNG.
- Deal **5 cards** to each player (clockwise, one at a time — dealing order is cosmetic since the
  deck is pre-shuffled; deal in player-index order).
- Place the next card **face-up** to start the **discard pile**.
- The remaining cards form the **stock** (face-down draw pile).
  - 2 players: 52 − 10 − 1 = **41** in stock.
  - 3 players: 52 − 15 − 1 = **36** in stock.
  - 4 players: 52 − 20 − 1 = **31** in stock.
- **Starting player:** player to the dealer's left. Since there is no human dealer, define the
  dealer as `players[0]` and the starting player as `players[1 % playerCount]`. This sets
  `currentPlayerIndex`. (Rationale: deterministic, simple, and rotates naturally if/when rematch
  rotates the dealer — out of scope here.)
- **Tonk-on-deal check runs immediately after the deal, before the first turn** (see §4a).

### 3. Card point values

| Card | Points |
| ---- | ------ |
| Ace (A) | 1 |
| 2–10 (number cards) | face value (2..10) |
| Jack (J), Queen (Q), King (K) | 10 each |

- **Aces are low and worth 1** (both for scoring and for runs — see §6). This is the common Tonk
  convention and avoids the "ace high or low" ambiguity that plagues other variants. **Rejected
  alternative:** ace = 11 / ace-high. Rejected because it complicates runs (A-2-3 is the canonical
  low Tonk run) and is the less common convention.
- A player's **hand count** = sum of point values of cards remaining in hand.

### 4. Win conditions

Tonk has multiple ways a hand ends. All of them resolve to a single hand winner and per-player
hand points; the **match** winner is derived from accumulated match scores (see §8).

#### 4a. Tonk (instant declaration on deal) — "tonk"

After the deal, if a player's 5 cards total **exactly 49 or 50 points**, that player has **Tonk**
and immediately wins the hand without any turns being played.

- Check is automatic in `initialize` / first view, but the player must **declare** it on their
  first action opportunity (see mapping note below). To keep the engine deterministic and avoid a
  "must-declare-or-forfeit" sub-rule, **we auto-declare Tonk for any qualifying player at deal
  time**, resolving ties (multiple players with 49/50) by lowest player index. The hand ends
  before turn 1.
- **Reward:** a Tonk-on-deal is a **double win** — the declarer's opponents each pay a hand
  penalty equal to their hand point total, **and** the declarer additionally collects a fixed
  bonus (see §8 scoring; we fold this into match points rather than chips).
- **Decision:** value is **49 or 50** (the standard "high tonk"). **Rejected alternative:** "low
  tonk" / exactly the deal summing to a specific low total — less common and confusing alongside
  the lowest-count win.

> Mapping note (leaking abstraction risk, LOW): auto-declaring at deal time means a Tonk hand can
> reach `status === "COMPLETED"` directly out of `initialize`. The interface contract says
> `initialize` returns `status "IN_PROGRESS"`. **Resolution:** `initialize` always returns
> `IN_PROGRESS`; the Tonk-on-deal resolution is applied as a synthetic first transition so that
> `applyAction` (not `initialize`) is what produces `COMPLETED`. The engine LLD will model this as
> a `declareTonk` action that the engine itself injects, OR by having the first `getValidActions`
> for a qualifying player offer only `declareTonk`. Either keeps `initialize`'s contract intact.
> Flagged for the engine LLD to choose; both are clean.

#### 4b. Going out (discarding to an empty hand) — "goingOut"

On your turn, after drawing and after laying spreads/hits, if you can **discard your last
card(s)** such that your hand becomes empty, you **go out** and win the hand immediately.

- You may only go out by getting your hand to **zero cards**. The normal turn ends with a single
  discard, so "going out" means your final discard empties your hand (your other cards having been
  laid into spreads / hit onto spreads this turn or earlier).
- **Minimum-hand-to-go-out constraint:** there is **no minimum-spread requirement** to go out in
  this variant (you do not need to have melded anything; you simply must reach an empty hand). This
  is the simplest defensible rule. **Rejected alternative:** "must have a spread down to go out" —
  adds a special case with little gameplay value at our scale.
- **Reward:** opponents pay their remaining hand point totals (see §8).

#### 4c. Lowest count at stock exhaustion — "stockExhausted"

If the **stock runs out** (no cards left to draw) the hand ends. The player(s) with the **lowest
hand point total** win.

- **Tie:** if multiple players tie for the lowest count, the hand is a **wash** — no points change
  hands for that hand (no winner, no payments). See §8 and Edge Cases. (Rationale: avoids
  arbitrary tie-breaks and a second "winner".)
- See Edge Cases §E3 for the exact "stock empties mid-turn" timing.

#### 4d. Drop / knock — "drop"

Instead of the normal draw+discard, on your turn **before drawing** you may **drop** (also called
"knock" / "going down"), declaring you believe you have the lowest hand. The hand ends immediately
and all hands are compared. See §7 for the full drop/under-cut resolution.

### 5. Spreads (melds): sets, runs, minimum size, when allowed

A **spread** is a meld laid face-up in front of a player.

- **Valid sets:** 3 or 4 cards of the **same rank** (e.g., three 7s).
- **Valid runs:** 3+ cards of the **same suit in consecutive rank order**, ace **low only**
  (A-2-3 valid; Q-K-A **not** valid; runs do not wrap). Run length 3, 4, or 5.
- **Minimum spread size:** **3 cards** for both sets and runs.
- **When melds may be laid:** only on **your own turn, after you have drawn and before you
  discard.** You may lay any number of valid spreads in one turn. You **cannot** lay a spread
  during another player's turn.
- Once laid, a spread is **public and permanent** — it cannot be picked back up.
- Cards in a spread no longer count toward your hand point total (they're out of your hand).

### 6. Hitting (laying off onto existing spreads)

- On **your own turn, after drawing and before discarding**, you may **hit** (lay off) one or more
  cards from your hand onto **any existing spread on the table — your own or an opponent's** — as
  long as the resulting spread remains valid (a set stays same-rank ≤4 cards; a run stays a
  consecutive same-suit sequence, ace low).
- **Decision: hitting onto opponents' spreads is allowed.** This is the common Tonk rule and is the
  primary way to dump high cards. **Rejected alternative:** own-spreads-only — less common and
  removes a core strategic element.
- Hit cards leave your hand and stop counting toward your hand total. They are credited to the
  spread's location but, for scoring, only the holder's **remaining hand** matters, so hitting is
  purely a way to reduce your own count.
- You may hit and lay new spreads in the same turn, in any order, before discarding.

### 7. Drop / knock rules and caught-drop (under-cut) scoring

On your turn, **before drawing**, you may **drop**. (You may not drop after drawing.)

- When you drop, **all players reveal hand point totals** and the hand ends.
- **Correct drop:** if the dropper has the **strictly lowest** hand total, the dropper wins. Each
  opponent pays the difference between their total and the dropper's total (folded into match
  points, see §8).
- **Caught drop / under-cut:** if **any** opponent has a hand total **equal to or lower** than the
  dropper's, the dropper is **caught (under-cut)**. The dropper is **penalized**; the
  lowest-count opponent (lowest index on tie) is treated as the hand winner.
  - **Penalty model (simplest):** on a caught drop, the dropper is assessed a fixed **under-cut
    penalty** added to their match score, and the lowest-count player wins the hand and collects as
    in a normal going-out. The exact penalty constant is fixed in §8.
- **First-turn drop:** dropping is allowed on your first turn (no draw required to drop).

### 8. Scoring (hand and match)

**Match format:** a Tonk game is a **multi-hand match played to a target score**. Players
accumulate a **match score** across hands; the match ends when a player's match score **reaches or
exceeds the target**. Tonk traditionally tracks "chips lost," but to fit our existing stats
pipeline cleanly we use an **ascending penalty-points** model (lower is better is inverted to a
points-collected model — see mapping note).

- **Default target:** `targetScore = 100` (configurable via `GameEngineConfig.options.targetScore`,
  default 100). Match ends at the **end of the hand in which** any player reaches ≥ target.
- **Per-hand point transfer (the core engine computation):**
  - **Going out (4b) / correct drop (7):** the hand winner scores the **sum of all opponents'
    remaining hand point totals** added to the winner's match score. (Equivalent to "winner collects
    what everyone else was holding.")
  - **Tonk-on-deal (4a):** winner scores the sum of opponents' hand totals **plus a TONK_BONUS of
    25** match points (the double-win reward).
  - **Caught drop / under-cut (7):** the lowest-count opponent scores the sum of the *other*
    players' hand totals as a normal win; the **dropper additionally** has an **UNDERCUT_PENALTY of
    25** added to **the winner's** score (the dropper "pays" the penalty, modeled as the winner
    collecting it). The dropper themselves scores 0 for the hand.
  - **Stock exhaustion (4c):** lowest-count player scores the sum of opponents' totals. **Tie =
    wash:** no score changes that hand.
- **Match winner:** the player with the **highest accumulated match score** when the match ends.
  Ties on match score at the target are broken by **who reached the target first** (i.e., the hand
  that triggered the end belongs to the player who crossed the threshold; if two cross in the same
  hand, lower player index wins). This guarantees exactly one match winner.

> **Constants fixed by this spec:** `TONK_BONUS = 25`, `UNDERCUT_PENALTY = 25`, `targetScore` default
> `100`, Tonk-on-deal threshold `49 or 50`. These are the only tunable numbers; they are set here so
> the engine LLD has no TBDs.

#### Mapping to the existing stats pipeline (CRITICAL — no plumbing changes)

`statsService.recordGameCompletion` (`src/backend/service/statsService.ts`) consumes only:
`state.winner` (single `PlayerId | null`) and `state.scores[].score`, deriving `gamesWon` from
`playerId === winner`, `gamesLost` otherwise, and `totalScore += score`.

- The Tonk engine writes `state.winner = <match winner>` and `state.scores = [{ playerId, score:
  <final match score> }, ...]` **once, when the whole match COMPLETES** — exactly like Big2 writes
  placement points once at game end. **Per-hand results are internal** to `gameSpecificState`; they
  never touch the stats pipeline. This means **zero changes** to `statsService`, `StatsDelta`, or
  `PlayerStats`. A higher match score is "better," matching the additive `totalScore` semantics
  already used for Big2 placement points.
- A "wash" hand (stock-exhaustion tie) records no per-hand transfer but is a normal internal hand;
  the match still completes normally and produces one `winner`.

> **Leaking-abstraction check (match vs single hand):** Modeling a *match* (multiple hands) inside
> one `InternalGameState` is the single most important design call. It is clean: the engine keeps a
> `matchScores` array and a `handNumber` in `gameSpecificState`, re-deals inside `applyAction` when
> a hand ends and the target is not yet reached (using a **pre-shuffled deck stored in
> `gameSpecificState`**, since `applyAction` takes no PRNG — see the interface contract). The game
> stays `IN_PROGRESS` across hands and only goes `COMPLETED` when the target is reached. **No new
> engine method is required.** The only constraint this imposes is that `initialize` must shuffle
> and stash **enough deck material for re-deals** OR the engine must carry forward a deterministic
> reshuffle scheme. See Edge Cases §E6 and the engine-LLD flag below.

### 9. Turn structure (draw → discard) and how it differs from Big2

A normal Tonk turn is **two phases in a fixed order**:

1. **Draw phase:** draw **one** card, either the top of the **stock** (face-down, hidden) or the
   top of the **discard pile** (face-up, known). *(Or, before drawing, choose to **drop** — §7 —
   which ends the hand instead of taking a turn.)*
2. **Meld phase (optional):** lay spreads (§5) and/or hit existing spreads (§6), in any order.
3. **Discard phase:** discard exactly **one** card face-up to the top of the discard pile —
   **unless** the meld phase emptied your hand, in which case you **go out** (§4b) and win without
   discarding.

**Contrast with Big2:** Big2 is a single-action turn (`playCards` or `pass`) that ends the turn
atomically. Tonk's turn is **stateful within itself** — a draw must precede a discard, and melds
happen in between. This is the core structural difference and the main interface-mapping concern.

#### Turn modeling on `applyAction` (recommended)

Model the turn as **multiple actions within one player's turn**, with an explicit
intra-turn phase tracked in `gameSpecificState.turnPhase`:

- `drawStock` / `drawDiscard` — valid only when `turnPhase === "draw"`; transitions to `"meld"`.
- `drop` — valid only when `turnPhase === "draw"` (before drawing); ends the hand.
- `laySpread` / `hit` — valid only when `turnPhase === "meld"`; stays in `"meld"`.
- `discard` — valid only when `turnPhase === "meld"`; advances to the next player (or goes out).

`currentPlayerIndex` does **not** change until the discard (or drop / going-out). `getValidActions`
returns different action types depending on `turnPhase`. This fits the existing contract: each
action is a discrete `(state, action) → newState` transition, `version` increments per action, and
the "turn" is just a sequence of transitions by the same `currentPlayerIndex`.

> **Leaking-abstraction check (turn timer, MEDIUM — the key one to flag):** `getAutoTimeoutAction`
> returns a *single* `GameAction`. But a timed-out Tonk player may be mid-turn in **either** the
> `draw` phase or the `meld` phase, and a complete safe turn requires **draw then discard** — two
> actions. The interface returns only one action per call.
>
> **Resolution (no new engine method):** `getAutoTimeoutAction` returns the **single safe action
> appropriate to the current `turnPhase`**, and the turn-timer driver calls it again if the player
> is still the current player and still out of time:
> - `turnPhase === "draw"` → return `drawStock` (safest: never reveals intent, never wastes a
>   useful discard-pile card). Never auto-`drop` (dropping risks an under-cut penalty — unsafe).
> - `turnPhase === "meld"` → return `discard` of the player's **highest-point card** (minimizes the
>   downside of an unattended turn; deterministic tie-break by suit order then rank). Never
>   auto-lay spreads or hits (those are strategic and could help opponents via shared spreads).
>
> Because the timer layer (LLD 7, Turn Timer) already loops "if still this player's turn and timer
> expired, apply auto-action," two calls naturally complete a `draw → discard` turn. **This must be
> verified against the existing turn-timer driver in the engine/timer LLD**: if that driver applies
> exactly one auto-action and then *waits for the next timer tick*, a timed-out Tonk player will
> take two timer periods to complete a turn. That is acceptable (safe, no stall) but should be a
> conscious decision. **Flagged for the engine LLD + turn-timer LLD to confirm the loop semantics.**
> If the driver only ever calls `getAutoTimeoutAction` once per turn, the engine LLD must instead
> make a single auto-action that both draws and discards atomically — which would be a *new*
> compound action type and a minor abstraction stretch. Recommend the two-call approach.

---

## Interfaces / Types (illustrative — final form belongs to the engine LLD)

These sketches show the rules are expressible without new engine plumbing. They are **not**
binding API.

```ts
// gameSpecificState payload for InternalGameState.gameSpecificState
interface TonkState {
  readonly hands: readonly (readonly Card[])[];      // per player, by index — HIDDEN
  readonly stock: readonly Card[];                    // face-down draw pile — HIDDEN
  readonly discard: readonly Card[];                  // discard pile; last = top — PUBLIC top
  readonly spreads: readonly TonkSpread[];            // all laid melds — PUBLIC
  readonly turnPhase: "draw" | "meld";                // intra-turn phase
  readonly matchScores: readonly number[];            // accumulated, by player index
  readonly handNumber: number;                        // 1-based
  readonly targetScore: number;
  readonly handHistory: readonly TonkHandResult[];    // per-hand outcomes (internal/public-safe)
  // deterministic re-deal material — see Edge Cases E6
}

interface TonkSpread {
  readonly kind: "set" | "run";
  readonly cards: readonly Card[];
  readonly ownerIndex: number;       // who laid it (display only; not used in scoring)
}

// Actions (all extend GameAction { type, playerId })
type TonkAction =
  | { type: "drawStock"; playerId: PlayerId }
  | { type: "drawDiscard"; playerId: PlayerId }
  | { type: "drop"; playerId: PlayerId }
  | { type: "laySpread"; playerId: PlayerId; cards: readonly Card[]; kind: "set" | "run" }
  | { type: "hit"; playerId: PlayerId; spreadId: number; cards: readonly Card[] }
  | { type: "discard"; playerId: PlayerId; card: Card };

// Public state mirror exposed via gameSpecificPublicState (no hands, no stock contents)
interface TonkPublicState {
  readonly discardTop: Card | null;
  readonly stockCount: number;          // count only, never contents
  readonly spreads: readonly TonkSpread[];
  readonly turnPhase: "draw" | "meld";
  readonly matchScores: readonly number[];
  readonly handNumber: number;
  readonly targetScore: number;
  readonly handHistory: readonly TonkHandResult[];
}
```

`TonkPoints` map and ace-low run ordering are engine-local constants (do not reuse Big2's
`RANK_ORDER`).

---

## State Model

- **Server-only truth** lives in `InternalGameState.gameSpecificState` as `TonkState`: all hands,
  the stock, the discard pile, spreads, intra-turn phase, match scores, hand number, and re-deal
  material. Persisted as JSON (per HLD) and cached in memory for active games.
- **Per-player view** (`getPlayerView`): the player sees **their own hand**, opponents' **card
  counts only**, the **discard pile top**, the **stock count** (not contents), all **spreads**,
  `turnPhase`, `matchScores`, `handNumber`, `targetScore`, and `validActions` (only when it is
  their turn and `status === "IN_PROGRESS"`).
- **Spectator view** (`getSpectatorView`): everything in the public state — discard top, stock
  count, spreads, match scores, turn order, status — and **no hands and no stock contents**.
- **Information hiding (explicit expectations):**
  - **HIDDEN:** every player's hand (including order/contents), the stock pile contents and order,
    and any stashed re-deal material. `getPlayerView(state, A)` must physically exclude B's hand
    and the stock contents.
  - **PUBLIC:** the **top** of the discard pile, the **count** of the stock and of each hand, and
    **all spreads** (sets/runs and any hits laid onto them).
  - The full discard pile *history* below the top is **public** in standard Tonk (players track
    what's been discarded), so the discard array may be exposed in full; only the **stock** and
    **hands** are hidden. *(Flagged as a minor product call: if we prefer to hide buried discards,
    expose only `discardTop`. Recommend exposing the full discard pile — it's standard and aids
    play.)*
- **Persistence cadence:** unchanged from the platform model — write internal state on each action
  (version increments), read from in-memory cache during play.
- **Match vs hand:** a single `InternalGameState` spans the whole match. Hand boundaries are
  internal transitions inside `applyAction`; `status` stays `IN_PROGRESS` across hands and flips to
  `COMPLETED` only when a player reaches the target. `winner`/`scores` are written once at match
  completion (feeds stats unchanged).

---

## Edge Cases

- **E1 — Tonk-on-deal tie (multiple 49/50 hands):** lowest player index wins the Tonk; others get
  no bonus. Resolved deterministically at deal time (§4a).
- **E2 — Drawing the last stock card:** the draw is legal; the hand continues normally through that
  player's discard. Stock exhaustion is only evaluated **when a player must draw and the stock is
  empty** (E3).
- **E3 — Stock empties and the next player must draw:** if a player begins their draw phase with an
  **empty stock**, the hand ends immediately as a **stock-exhaustion** result (§4c) — lowest count
  wins, ties wash. *(Common-variant alternative: reshuffle the discard pile minus its top into a new
  stock. **Rejected** for simplicity and to keep `applyAction` deterministic without extra shuffle
  state; the bounded deck guarantees the hand ends.)*
- **E4 — Going out vs discard:** if the meld phase empties the hand, the player **goes out** (wins)
  and does **not** discard. If the player still holds cards, a discard is mandatory to end the turn.
- **E5 — Caught drop with a tie among opponents:** if the dropper is under-cut and multiple
  opponents tie for the lowest count, the **lowest player index** among them is the hand winner; the
  dropper still pays `UNDERCUT_PENALTY` (§7/§8).
- **E6 — Re-deal between hands (`applyAction` is PRNG-free):** the interface forbids passing a PRNG
  to `applyAction`, but a match must re-shuffle and re-deal between hands. **Resolution:**
  `initialize` shuffles the **full 52-card deck once** and the per-hand deal/stock are carved from a
  deterministic, pre-shuffled ordering stored in `gameSpecificState`. For subsequent hands, the
  engine reconstitutes the 52 cards (all hands + spreads + discard + stock from the just-finished
  hand) and re-orders them via a **deterministic PRNG re-seeded from `state.randomSeed` +
  `handNumber`** — computed inside the engine without external I/O, satisfying determinism. *(This
  is the cleanest way to honor "applyAction takes no PRNG" while supporting multi-hand matches.
  **Flagged for the engine LLD** to confirm the re-seed scheme; it is the one place the
  single-hand-oriented interface is stretched, and it is stretched cleanly.)*
- **E7 — Match-end tie:** if two players cross `targetScore` in the same hand, the lower player
  index wins the match (guarantees a single `winner`); §8.
- **E8 — Invalid intra-turn ordering:** `discard` before `draw`, `drop` after `draw`, `laySpread`
  during `draw` phase, hitting onto a spread that would become invalid, discarding a card not in
  hand, or any action by a non-current player → all rejected by `validateAction` with state
  unchanged.
- **E9 — Player disconnect mid-turn:** out of scope for this rules spec; handled by the turn-timer
  auto-action (§9) and reconnection LLD. The auto-action semantics defined above are the rules-level
  contract the timer relies on.

---

## Dependencies

**Before the engine sub-issue (#41.2) can begin:**

- [ ] **User sign-off on this variant** (the hard gate — see below).
- Existing `GameEngine` interface (`src/backend/engine/game-engine.ts`) — unchanged; this spec is
  expressed against it.
- `GameType` already includes `"tonk"` (`src/shared/engine-types.ts`) — no plumbing change.
- Shared `Card`/`Suit`/`Rank` types — reused as-is.
- Existing stats pipeline (`statsService`, `StatsDelta`, `PlayerStats`) — **no changes**; this spec
  is designed to feed it via single-`winner` + per-player `score` at match completion.
- Big2 engine (`src/backend/engine/big2/*`) — **reference only** for structural patterns
  (`gameSpecificState` shape, public-state mirror, placement-style one-shot scoring). Do not import
  Big2 rank constants.
- Turn-timer driver (LLD 7) — its loop semantics must be confirmed against §9 (the one MEDIUM
  leaking-abstraction flag).

**Flags surfaced for the engine LLD (no new engine plumbing required; all resolvable within the
existing interface):**

1. Two-phase turn vs single-action `getAutoTimeoutAction` (§9) — resolve via the timer-loop calling
   the auto-action per phase. **Confirm timer-loop semantics.**
2. Tonk-on-deal producing `COMPLETED` — keep `initialize` returning `IN_PROGRESS`; resolve via a
   first synthetic/declare action (§4a note).
3. Multi-hand match inside one `InternalGameState` with PRNG-free `applyAction` re-deals (§8, E6) —
   resolve via deterministic re-seed from `randomSeed + handNumber`.

None of these require changing the `GameEngine` interface; each is called out so the engine LLD
handles it deliberately rather than special-casing later.

---

## Test Requirements

(Specifying *what* must be tested per `docs/testing-principles.md`; the engine LLD/implementer
writes the actual tests. All engine tests are pure, deterministic via seeded/disabled shuffle, and
self-contained.)

**Unit — card values & combinations**
- Point values: A=1, 2–10 face, J/Q/K=10; hand-total summation.
- Set validity: 3 and 4 of a rank valid; mixed-rank invalid; 5-of-a-rank impossible.
- Run validity: same-suit consecutive (len 3/4/5) valid; ace-low (A-2-3) valid; Q-K-A and wrap
  invalid; mixed-suit invalid; non-consecutive invalid.
- Hit validity: extending a set to ≤4 valid, to 5 invalid; extending a run at either end valid;
  inserting an out-of-sequence card invalid; hitting an opponent's spread valid.

**Unit — turn structure & valid actions**
- `getValidActions` returns draw/drop options in `draw` phase; meld/discard options in `meld` phase;
  empty when not the player's turn or game not `IN_PROGRESS`.
- Phase transitions: draw → meld → discard advances `currentPlayerIndex`; drop ends hand from
  `draw` phase only.
- Invalid-action rejections (each leaves state/version unchanged): discard before draw, drop after
  draw, lay/hit in draw phase, discard card not in hand, action by non-current player, any action
  after match `COMPLETED`.

**Unit — win conditions & scoring**
- Tonk-on-deal at 49 and at 50 (and *not* at 48); tie resolution by index; TONK_BONUS applied.
- Going out (empty hand after meld) wins; winner collects sum of opponents' totals.
- Correct drop (strictly lowest) wins; under-cut (opponent ≤ dropper) penalizes dropper, lowest
  opponent wins, UNDERCUT_PENALTY applied; under-cut tie resolved by index.
- Stock-exhaustion lowest count wins; **tie = wash** (no score change).
- Match accumulation across multiple hands; match ends at `targetScore`; match-end tie resolved to
  a single `winner`.

**Unit — auto-timeout (turn timer)**
- `getAutoTimeoutAction` in `draw` phase returns `drawStock` (never `drop`).
- In `meld` phase returns `discard` of the highest-point card (deterministic tie-break).
- Returns `null` when game is `COMPLETED` / not in a timeout-applicable state.
- Two successive auto-actions complete a full `draw → discard` turn and advance the player.

**Integration / invariants**
- Full multi-hand match simulation with seeded PRNG: pick from `validActions` each step; assert
  invariants after **every** action — total cards across hands+stock+discard+spreads = 52; exactly
  one valid `currentPlayerIndex`; `validActions` non-empty for the current player;
  `status` only advances forward; match terminates and declares exactly one `winner`.
- Re-deal determinism: same `randomSeed` ⇒ identical hand sequence (reproducibility, per E6).

**Security / information-leakage**
- `getPlayerView(state, A)` never contains B's hand or the stock contents (negative assertions).
- `getSpectatorView` contains no hands and no stock contents; exposes discard top, stock count,
  spreads, match scores.
- A player view in another player's `meld`/`draw` phase still hides that player's hand.

**Manual:** none required at the rules/engine level (all behavior is verifiable via computed
state). UI/animation manual checks belong to the frontend LLD.

---

## Variant Sign-Off

**This LLD is blocked pending explicit user approval of the variant summarized below. The engine
sub-issue (#41.2) MUST NOT begin until this is signed off.**

| Dimension | Chosen value |
| --------- | ------------ |
| Deck | Single standard 52-card, no jokers |
| Players | 2–4 |
| Deal | 5 cards each; 1 to discard; rest = stock |
| Card points | A=1, 2–10 face, J/Q/K=10 |
| Tonk-on-deal | Hand totals 49 or 50 → instant win + TONK_BONUS 25 |
| Going out | Empty hand → win; no minimum-spread requirement |
| Stock exhaustion | Lowest count wins; tie = wash |
| Spreads | Sets (3–4 same rank) and runs (3+ same suit, ace low, no wrap); min 3; laid on own turn after draw |
| Hitting | Onto any spread (own or opponents'), own turn after draw |
| Drop/knock | Before draw; correct = lowest wins; under-cut (opponent ≤ dropper) → UNDERCUT_PENALTY 25, dropper scores 0 |
| Scoring | Multi-hand match; winner collects opponents' remaining totals; match to targetScore (default 100); single winner |
| Turn | draw (stock or discard) → optional meld/hit → discard; drop replaces a turn |
| Timer auto-action | draw phase → drawStock; meld phase → discard highest-point card; never auto-drop |
| Info hiding | Hands + stock hidden; discard (top + history) + spreads + counts public |

**If the user wants a different variant** (e.g., reshuffle-on-exhaustion, single-hand-only,
own-spreads-only hitting, ace-high, chip-based scoring, or a different Tonk threshold), the
architect updates this spec **before** any engine work — that is the entire purpose of this gate.
