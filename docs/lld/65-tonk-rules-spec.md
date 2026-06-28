# LLD 65: Tonk Rules Specification

**Status: HARD GATE — docs-only. No engine, frontend, or transport code may be written for Tonk until the user explicitly signs off on the variant defined here (see §9, Variant Sign-Off).**

This LLD pins down the EXACT Tonk (Tunk) variant we will implement. Tonk has many regional variants; choosing wrong poisons every downstream sub-issue (engine #57, frontend, transport). This spec is transcribed to **exactly** match the user's authoritative `TONK.Rules.md` (attached to issue #56 on 2026-06-28: *"Do not deviate from this rule set"*). The transcription has been verified line-by-line against that attachment (§3 below reflects it faithfully).

> **Supersedes LLD 64 (PR #75) and LLD 59 (PR #73).** LLD 64 is the prior faithful transcription and is carried forward here essentially unchanged (this doc finalizes it as the spec of record). LLD 59 / PR #73 describes a fundamentally different game — 52-card no-joker deck, 5-card deal but with **spreads, runs, melds, hitting, drop/knock with under-cut**, draw-then-discard, single-hand winner-takes-points. The user's ruleset has **none of those mechanics**; that variant is discarded. Where any prior doc disagrees with this one, **this doc is authoritative.**

---

## 1. Scope

### In scope

- The exact Tonk variant, transcribed from the user's `TONK.Rules.md`, with all engine-critical ambiguities resolved (§8).
- Deck composition (variable size, **jokers included**), player counts, deal, stock/discard setup.
- Card point values; hand value definition.
- Turn structure: **discard-first, then draw**.
- Calling **TONK** and its scoring consequences (correct call vs caught/tied call).
- Stock-exhaustion end of trick.
- Multi-trick match scoring (ascending, **lower is better**) and game-end / TRUE LOSER determination.
- Turn-timer / auto-timeout semantics for a discard-then-draw turn.
- Information-hiding expectations.
- A full mapping onto the existing `GameEngine` interface (`src/backend/engine/game-engine.ts`) and the `StatsService` pipeline (`src/backend/service/statsService.ts`), flagging anything that does not map cleanly (leaking-abstraction risk).

### Explicitly NOT in scope (do not implement — these mechanics DO NOT EXIST in this variant)

- **Spreads / sets / runs / melds** of any kind.
- **Hitting / laying off** cards onto anyone's cards.
- **Drop / knock** with under-cut/caught penalty (the only "going out" mechanic is calling **TONK**).
- **Going out by emptying the hand.** Hands never empty — every turn discards then draws back; you win a trick by *calling TONK*, not by running out of cards.
- Instant tonk/declaration **on the deal** (no auto-win for a low dealt hand; TONK can only be called from the 2nd round onward — see §3.4).
- The actual engine code, types file, frontend, or transport. Those are sub-issue #57 and later, gated on §9.

---

## 2. Approach

### 2.1 Chosen variant (verbatim from the user's ruleset)

| Dimension | Decision |
| --- | --- |
| Deck | 1+ standard 52-card decks **with jokers included**. Variable size — cut down so the stock lasts ~7–9 rounds. |
| Jokers | Present in the deck; worth **0 points**. Also used as the tiebreak token for TRUE LOSER (§5.3). |
| Players | 3–5 with one deck; 6+ with two or more decks. **We support `minPlayers: 3`, `maxPlayers: 5` for v1** (single-deck only — see §8.1; multi-deck deferred, presented as a default for sign-off). |
| Deal | **5 cards** face down to each player. Remainder is the face-down **stock** in the center. |
| Card values | Aces = **1**, face cards (J/Q/K) = **10**, number cards 2–10 = **face value**, Jokers = **0**. |
| Hand value | Sum of the point values of all cards currently in hand. Lower is better. |
| Turn | **Discard first, then draw.** You may discard *multiples of the same rank* in one discard, but still draw exactly **1**. |
| Draw source | Trick-1 first player: stock only. Every other turn (2nd player onward, and the trick-2+ starter via the face-up start card): stock **OR** the **drawable-discard snapshot** — the single most-recent card the immediately-preceding player had on top *before the current player discarded* (captured at turn start as `drawableDiscard`; §3.3, §4.2). Because this variant discards before drawing, this is **not** the live pile top once the current player has discarded; a player can never draw back their own just-discarded card. If the preceding player discarded multiples, only the single top 1 is drawable. |
| Going out | **Call TONK** at the *beginning* of your turn, before discarding. Only allowed after every player has had ≥1 turn. |
| Trick end | TONK called, **or** stock exhausted. |
| Trick scoring | See §5.1 (TONK correct / caught / stock-out). Ascending tally; lower is better. |
| Game end | Any player's tally **≥ 150** → that player has **lost**. TRUE LOSER decided by drawing for a Joker (§5.3). |
| Next-trick dealer | Player with the **overall highest score** shuffles, deals, and starts the next trick. |

### 2.2 Key technical decisions and rationale

1. **Trick = round in engine terms.** The ruleset calls each hand a "trick." We model a Tonk *match* as a sequence of tricks within one `InternalGameState` (status stays `IN_PROGRESS` across tricks; flips to `COMPLETED` only at game end). `turnNumber` advances per action; a separate `trickNumber` lives in `gameSpecificState`.

2. **Deck size & cut are deterministic given the PRNG seed.** Deck composition (how many decks, how many cards cut) is computed at `initialize` time from player count + a target-rounds heuristic, then the cut is performed via the injectable PRNG. Re-running `initialize` with the same seed reproduces the same deck and cut exactly (architecture-principles #8; testing-principles #2). See §8.1.

3. **Discard-then-draw is two phases of one player's turn, not two turns.** A single player's turn is a `discard` action **immediately** followed (still that player, no turn hand-off in between) by a `draw` action. The engine models this as a two-phase turn with a `turnPhase` field (`"discard" | "draw"`) so that `validateAction`/`getValidActions` can offer exactly the legal action at each phase. TONK is a third action type available only at the **start** of a turn (phase `"discard"`, before any discard). See §4.

4. **Lower-is-better maps onto the winner-centric stats pipeline via a documented adapter, not a pipeline change.** `StatsService.recordGameCompletion` derives win/loss from `state.winner` + `state.scores` (verified: `statsService.ts` lines 29–31). We keep that contract: at game end we set `state.winner = <the player with the lowest final tally>` and record the **TRUE LOSER** via `breakdown`. This is a *leaking-abstraction risk* called out explicitly in §6.3.

5. **No melds, hits, drops, or hand-emptying anywhere.** The action set is exactly `{ discard, draw, callTonk }`. This keeps the engine far simpler than Big2's combination logic.

### 2.3 Alternatives considered

- **Multi-deck (6+ players) in v1** — rejected for v1. Adds deck-multiplicity bookkeeping and changes the Joker-count math for the TRUE LOSER draw, for a player count the rest of the stack (lobby max, frontend seating) is not built for. Deferred; `maxPlayers` cap of 5 keeps us single-deck. **Recommended default — confirm at sign-off (§9.1).**
- **Treating each trick as a separate `InternalGameState` / game record** — rejected. Stats and the 150-point match span multiple tricks; one persistent game state across tricks matches the cache/persistence model (architecture-principles #5) and the existing `Game` row.
- **Auto-win on a low dealt hand ("instant tonk on deal")** — rejected; not in the user's ruleset. TONK is gated to "after every player has had ≥1 turn."

---

## 3. Rules Specification (authoritative transcription)

### 3.1 Setup (per trick)

1. **Deck build.** Compose the deck (§8.1): 1 standard 52-card deck **+ 2 jokers** (54 cards) for 3–5 players, then cut it down to a target size so the stock lasts ~7–9 rounds. The cut is deterministic given the seed.
2. **Deal.** 5 cards face down to each player.
3. **Stock.** Remaining cards form the face-down stock in the center.
4. **Discard pile.**
   - **Trick 1:** discard pile starts **empty**; the trick-1 first player's `drawableDiscard` (§4.2) is `null` (no draw-from-discard option).
   - **Trick 2+:** flip **1** card face up from the stock into the discard pile before play starts. This face-up card is the trick starter's initial `drawableDiscard` snapshot (§3.3, §4.2) — it gives the trick starter a draw option (the ruleset's "slight advantage to the highest score" player). Because the starter discards before drawing, this snapshot is captured at the starter's turn start so it survives being buried under the starter's own discard; the starter still cannot draw back their own discard.
5. **First player.**
   - **Trick 1:** the player at seat index 0 (game creator's seat / lobby order) starts. (The ruleset does not specify the trick-1 starter; default to seat 0 — confirm at sign-off, §9.3.)
   - **Trick 2+:** the player with the **overall highest tally** starts (and is the dealer). Ties broken by lowest seat index (§8.7).

### 3.2 Card values

| Card | Value |
| --- | --- |
| Ace | 1 |
| 2–10 | face value |
| J, Q, K | 10 |
| Joker | 0 |

**Hand value** = sum of the values of all cards in the hand. (The ruleset states "the value of your hand is the sum of all cards"; number cards = face value is the only consistent reading and is fixed here.)

### 3.3 A turn (discard-then-draw)

A turn has two mandatory phases in this order:

1. **Discard phase.** The player discards 1 **or more** cards of the **same rank** (e.g. three Queens) face up onto the discard pile. (Jokers: a player may discard a Joker; "same rank" for multiples means same rank — Jokers only group with Jokers.) You **must** discard before drawing.
2. **Draw phase.** The player draws exactly **1** card and adds it to their hand:
   - **Trick-1 first player:** from the **stock** only.
   - **Every other turn (2nd player onward, and the trick-2+ starter):** from the **stock**, OR the **drawable discard** — see below.

> **Drawable discard is a turn-start snapshot, NOT the live pile top.** Because this variant discards *before* drawing, by the time the current player reaches the draw phase the discard-pile top is **their own just-discarded card(s)**, not the immediately-preceding player's discard. The card that is legally drawable from the discard is therefore captured as a **snapshot at the start of the current player's turn** — the single most-recent card the immediately-preceding player placed, which is the pile top *as it stood before the current player discarded*. We track this in state as `drawableDiscard: Card | null` (§4.2), set when the turn begins and distinct from the live `discardPile` top. Concretely:
> - At the **start of a turn**, `drawableDiscard` = the single top-most card placed by the immediately-preceding active player (the pre-discard pile top). If the immediately-preceding player discarded multiples, only that **single top 1** is the snapshot; the buried cards are never drawable.
> - For the **trick-2+ starter**, `drawableDiscard` = the face-up start card flipped at setup (§3.1.4).
> - For the **trick-1 first player**, `drawableDiscard` = `null` (pile started empty; no preceding discard).
> - The current player's own discard (now the live pile top) is **never** drawable: it is not the snapshot. A player can therefore never draw back a card they just discarded.

When the draw phase reads from the discard, it consumes `drawableDiscard` (the snapshot), not the live pile top.

Hand size returns to its pre-turn count each turn when 1 is discarded (discard 1, draw 1 → stay at 5); discarding multiples shrinks the hand. Hands therefore monotonically shrink or stay equal across a trick; this is fine — winning is by TONK, not by emptying.

After the draw phase, the turn passes to the next player in clockwise (ascending seat index, wrapping) order.

### 3.4 Calling TONK

- A player may call **TONK** only at the **beginning** of their own turn, **before discarding** (i.e. in the discard phase, as an alternative to discarding).
- **Gate:** TONK may only be called after **every player has had at least one full turn** (i.e. from the start of the 2nd round onward). Tracked via `trickTurnCount` in state (§4.2): gate open iff `trickTurnCount >= players.length`.
- On TONK: all hands are revealed and the trick ends immediately. Scoring per §5.1.

### 3.5 Stock exhaustion

If the stock empties (a player must draw but the stock has 0 cards) before any TONK is called, the trick ends: all hands revealed, lowest hand takes the penalty (§5.1 Case C). See §7 for the exact mid-turn timing.

---

## 4. State Model

> The concrete TypeScript types live in the **engine LLD (#57)**, not here. The shapes below are the design contract the engine must satisfy. `gameSpecificState` is typed `unknown` in `InternalGameState`; the Tonk engine narrows it to `TonkState`.

### 4.1 `InternalGameState` usage (server-only full truth)

| Field | Tonk usage |
| --- | --- |
| `status` | `IN_PROGRESS` from `initialize` until the match ends (player ≥150 → TRUE LOSER resolved), then `COMPLETED`. Never `CREATED` post-init. |
| `currentPlayerIndex` | Seat index whose turn it is. `-1` when `COMPLETED`. |
| `turnNumber` | Increments on every applied action (per existing convention). |
| `winner` | Set at `COMPLETED` to the player with the lowest final tally (stats adapter, §6.3). |
| `scores` | At `COMPLETED`: one `PlayerScore` per player. `score` = final running tally (lower is better). `breakdown` carries `{ lost: 0|1, trueLoser: 0|1, finalTally }`. |
| `randomSeed` | The seed; deck build, every per-trick cut, and the TRUE-LOSER joker draw all derive from a PRNG seeded by it (deterministic replay). |
| `gameSpecificState` | `TonkState` (below). |

### 4.2 `TonkState` (conceptual — exact types in #57)

| Field | Meaning |
| --- | --- |
| `hands: Card[][]` | Each player's hand (indexed like `players`). **Hidden** per-player. |
| `stock: Card[]` | Face-down draw pile. **Hidden** (only its count is public). |
| `discardPile: Card[]` | Face-up discards, top = most recent (the **live** pile top — i.e. the current player's own just-discarded card(s) once they have discarded). **Public.** This is the visual pile and is **not** what draw-from-discard reads. |
| `drawableDiscard: Card \| null` | **Snapshot taken at the start of the current player's turn** of the single card that is legally drawable from the discard this turn: the top-most card placed by the immediately-preceding active player as the pile stood *before* the current player discarded (or the trick-2+ face-up start card; or `null` for the trick-1 first player). Distinct from the live `discardPile` top — see §3.3. The draw phase reads from this, never from `discardPile`. Cleared to the new snapshot at each turn hand-off. **Public** (it is a face-up card). |
| `lastDiscardCount: number` | How many cards the **most recent** discard placed onto `discardPile` (so views can show how many of the live top are the current player's). Display/log only — does **not** govern draw legality (that is `drawableDiscard`). |
| `lastDiscardPlayerIndex: number \| null` | Who placed the current live `discardPile` top. Display/log only — does **not** govern draw legality. |
| `turnPhase: "discard" \| "draw"` | Which phase of the current player's turn we're in. |
| `trickNumber: number` | 1-based trick counter within the match. |
| `trickTurnCount: number` | Turns taken in the current trick; TONK gate = `trickTurnCount >= players.length`. |
| `tallies: number[]` | Running match score per player (ascending; lower better). Carried across tricks. |
| `tonkCallerIndex: number \| null` | Set transiently when scoring a trick (for view/log). |
| `lostPlayerIndices: number[]` | Players with tally ≥150 at match end (for the TRUE-LOSER draw). |
| `trueLoserIndex: number \| null` | Resolved at `COMPLETED`. |
| `log: TonkLogEntry[]` | Public action history (discards, draw-source, TONK calls, trick results). |

### 4.3 Persisted vs in-memory

Same model as Big2/LLD 04: the full `InternalGameState` (including `TonkState`) is the single source of truth, cached in memory for active games and persisted to the DB as JSON for durability (architecture-principles #5). `PlayerView`/`SpectatorView` are derived on demand, never stored. `isConnected` is a placeholder set by the engine and overwritten by the WebSocket layer (same as Big2, LLD 04 §4.2).

### 4.4 Per-trick reset vs per-match carry

When a trick ends (TONK or stock-out) and the match is **not** over:
- **Carry:** `tallies`, `players`, `randomSeed`, `trickNumber` (incremented).
- **Reset:** `hands`, `stock`, `discardPile`, `lastDiscard*`, `drawableDiscard` (→ the trick's initial drawable snapshot per §3.1.4 — `null` for trick 1, the face-up start card for trick 2+), `turnPhase` → `"discard"`, `trickTurnCount` → 0, `tonkCallerIndex` → null. New deck is rebuilt and cut deterministically (sub-seed derived from `randomSeed` + `trickNumber`, §8.1).
- **Next starter:** highest-tally player (§3.1.5).

---

## 5. Scoring

### 5.1 Trick scoring

Let `caller` = the player who called TONK (if any), and `hv(p)` = hand value of player `p` at trick end.

**Case A — TONK called and caller strictly lowest** (`hv(caller) < hv(p)` for every other `p`):
- Every **other** player adds **their own hand value** to their tally.
- The caller adds **0**.

**Case B — TONK called but caller tied or beaten** (any other player has `hv(p) <= hv(caller)`):
- The **caller** adds **30** to their tally.
- All other players add **0**.

**Case C — stock exhausted, no TONK:**
- The player with the **lowest** hand value adds **30** to their tally (a penalty, not a reward).
- All other players add **0**.
- Ties for lowest in Case C: see §7 (all tied-lowest players each add 30 — default, confirm at sign-off §9.7).

> Note the asymmetry, transcribed exactly: a *successful* TONK (Case A) penalizes everyone *except* the caller; a *failed* TONK (Case B) penalizes only the caller 30; a *stock-out* (Case C) penalizes only the lowest hand 30.

### 5.2 Match end

- After each trick's scoring, if **any** player's tally is **≥ 150**, the match enters end-of-game resolution. Every player with tally ≥150 has **lost** (regardless of how much over 150).
- Otherwise a new trick begins (§4.4).

### 5.3 TRUE LOSER determination

- If exactly **one** player has tally ≥150 → that player is automatically the **TRUE LOSER**.
- If **more than one** player has lost: shuffle a fresh full deck (with jokers) via the PRNG, then the lost players draw one card at a time in seat order, repeating, until a **Joker** is drawn. The player who draws the Joker is the **TRUE LOSER**. (Deterministic given seed; §8.5.)
- `state.status` → `COMPLETED`; `trueLoserIndex` set; `winner`/`scores` populated per §6.3.

---

## 6. Mapping onto the existing `GameEngine` interface

Every method of `GameEngine` (`src/backend/engine/game-engine.ts`) maps as follows. Items flagged ⚠ are leaking-abstraction risks surfaced now per the issue's instruction. The interface was read and the mapping below is consistent with its documented contracts.

### 6.1 Method-by-method

| Method | Tonk behavior |
| --- | --- |
| `initialize(gameId, players, config, prng)` | Validate `3 ≤ players.length ≤ 5`. Build + cut the deck deterministically (§8.1) using `prng` and `config.options` (optional `deckTargetRounds`, `extraDecks`). Deal 5 each; rest → stock; trick-1 discard empty. `currentPlayerIndex` = 0. `status = IN_PROGRESS`, `version = 1`, `tallies` all 0, `trickNumber = 1`, `turnPhase = "discard"`. |
| `validateAction(state, action)` | Pure predicate: true iff `applyAction` would succeed (Big2 pattern — delegate). |
| `applyAction(state, action)` | Dispatch on `action.type ∈ {discard, draw, callTonk}` and `turnPhase`. Deterministic; no PRNG param. **All inter-trick and end-game randomness (new deck cut, TRUE-LOSER draw) uses a PRNG re-seeded deterministically from `randomSeed` — see ⚠-A.** Returns immutable new state, `version + 1`. |
| `getPlayerView(state, playerId)` | Your hand only; opponents as counts; public discard top + count, `drawableDiscard` (the turn-start snapshot, so the current player and spectators can see what is drawable from the discard — distinct from the live top), stock **count** (not cards), tallies, trickNumber, turnPhase, log, winner/scores. `validActions` populated only on your turn (§6.2). |
| `getValidActions(state, playerId)` | Empty unless `IN_PROGRESS` and your turn. Else by phase: see §6.2. |
| `isGameOver(state)` | `state.status === "COMPLETED"`. |
| `getAutoTimeoutAction(state)` | The timeout auto-action for a discard-then-draw turn — see §7. |
| `getSpectatorView(state, n)` | Public only: no hands, no stock contents. Counts, discard top, `drawableDiscard` (turn-start snapshot), tallies, turn info, log. |

### 6.2 `validActions` by turn phase

- **`turnPhase = "discard"`, TONK gate open** (`trickTurnCount >= players.length`): `[{ type: "discard" }, { type: "callTonk" }]`.
- **`turnPhase = "discard"`, TONK gate closed:** `[{ type: "discard" }]`.
- **`turnPhase = "draw"`:** `[{ type: "draw" }]` (the payload carries the source: `"stock"` or `"discard"`; `"discard"` only offered when `drawableDiscard !== null`, i.e. the turn-start snapshot exists — §8.3, **not** when the live `discardPile` is merely non-empty).
- Per the interface contract, `getValidActions` returns action **types**, not every legal discard combination. The specific cards in a `discard` payload (which must be same-rank and in-hand) are validated in `applyAction` (mirrors Big2's "validActions is types, applyAction validates the payload").

⚠ **Leaking-abstraction note (turn phases).** The `GameEngine` interface and Big2 assume **one action per turn**. Tonk needs **two phases per turn** (discard then draw) plus a turn-start-only `callTonk`. We model this entirely **inside** `gameSpecificState.turnPhase` without changing the interface — `currentPlayerIndex` stays the same player across both phases, and the turn only hands off after the draw. This maps cleanly; flagged so #57 expects a two-phase turn and the frontend action panel renders phase-appropriately. **No interface change required.**

### 6.3 Stats pipeline mapping ⚠ (leaking-abstraction: winner-centric vs loss-centric)

`StatsService.recordGameCompletion` (`src/backend/service/statsService.ts`, **verified lines 29–31**) derives, per player: `gamesWon = (playerId === state.winner) ? 1 : 0`, `gamesLost = (playerId !== state.winner) ? 1 : 0`, `totalScore = playerScore.score`. It is **winner-centric and single-winner** (exactly one winner, everyone else "lost"). It silently skips guest players and reads only `state.winner` + `state.scores[].score`.

Tonk is **loss-centric**: there is exactly one **TRUE LOSER**; everyone else simply did not lose. Naively reusing the pipeline would mark every non-`winner` player as `gamesLost: 1`, which is wrong for Tonk.

**Recommended mapping (no generic plumbing change — simplest correct option):**
- Set `state.winner` = the player with the **lowest final tally** (ties → lowest seat index). This is the most defensible "winner" and makes `gamesWon` meaningful.
- Populate `state.scores[i].score` = final tally (lower is better — note this inverts Big2's "higher score is better," documented here so leaderboard/`totalScore` aggregation understands Tonk scores are penalties).
- Add `breakdown: { finalTally, lost: 0|1, trueLoser: 0|1 }` so a future Tonk-aware stats reader can compute true-loser stats without re-deriving.

**The `gamesLost` semantics mismatch is the residual risk.** With the recommended mapping, the existing `StatsService` would record `gamesLost: 1` for **every** player except the lowest-tally winner — which over-counts losses for Tonk (only the TRUE LOSER truly "lost"). Two options for the stats sub-issue to choose between (decision deferred to that sub-issue, **not** this spec — flagged here so it is not missed):
  1. **Accept the approximation for v1** (non-winners get `gamesLost: 1`). Zero code change to `StatsService`. Simplest; slightly inflates loss counts.
  2. **Make `StatsService` read `breakdown.trueLoser`** when present (only the TRUE LOSER gets `gamesLost: 1`; non-winner non-losers get `0/0`). One small, additive, backward-compatible change isolated to `StatsService`, not the engine or generic types.

This LLD **recommends option 2** (it records correct Tonk semantics with a tiny, isolated change) but does **not** require it for the gate; either is acceptable. The engine LLD must populate `breakdown.trueLoser` regardless so the choice can be made downstream.

⚠ **Leaking-abstraction note (randomness in `applyAction`).** The interface says `applyAction` "takes no PRNG — it must be deterministic" and "mid-game randomness must use a pre-shuffled deck stored in `gameSpecificState`." Big2 needs no mid-game randomness. Tonk needs randomness **between tricks** (rebuild + cut a new deck) and **at game end** (TRUE-LOSER joker draw). We satisfy the determinism contract by re-seeding a `SeededPRNG` from a **derived sub-seed** (`hashSeed(randomSeed + ":trick:" + trickNumber)` / `+ ":trueloser:" + trickNumber`) inside `applyAction`. Same `(state, action)` → same result, no external PRNG needed. `hashSeed`, `SeededPRNG`, and `FixedPRNG` are exported from `src/backend/engine/prng.ts` (**verified**). This maps cleanly with **no interface change**; flagged so #57 implements the sub-seed scheme rather than reaching for `Math.random()` or threading a PRNG param.

---

## 7. Turn-timer / auto-timeout for a discard-then-draw turn

The turn timer (LLD 07) calls `getAutoTimeoutAction(state)` when a player's clock expires, and applies whatever it returns. For Tonk the auto-action depends on `turnPhase`:

| Phase when timer fires | Auto-action | Rationale |
| --- | --- | --- |
| `discard` | `discard` the **single highest-value card** in hand (one card, never multiples; never `callTonk`). Ties broken deterministically by a stable card order. | A timeout is a non-decision; auto-calling TONK could lose a player 30 points — never auto-call. Discarding the highest card is the harmless "reduce my hand value" default that mirrors Big2's "auto-action takes the safe minimal move." |
| `draw` | `draw` from the **stock**. | Drawing from the discard reveals intent/strategy; stock is the neutral default. If the stock is empty in the draw phase, see below. |

**Determinism:** `getAutoTimeoutAction` is pure and returns a valid `GameAction` for the current player (interface contract). Because a Tonk turn is two phases, a fully-timed-out turn fires the timeout **twice** (once per phase) — the timer (LLD 07) re-arms after the auto-discard is applied and the state is still that player's turn in `turnPhase = "draw"`. This is consistent with the interface: each call returns the single valid action for the current phase. **#57 + LLD 07 must confirm the timer re-arms within a turn across phases** (flagged; default is "yes, re-arm per phase" — confirm §9.4).

**Stock exhaustion mid-turn (Case C trigger):** if a player reaches the **draw phase** and the stock is empty, the trick ends immediately under §5.1 Case C (no draw possible). `applyAction` for the `draw` action (or auto-draw) detects empty stock and resolves the trick instead of drawing. A player **cannot** be forced to discard into an unwinnable state: the discard phase always succeeds (discard pile is the sink); only the draw phase can hit empty stock, and that ends the trick.

`getAutoTimeoutAction` returns `null` when `status !== "IN_PROGRESS"` or `currentPlayerIndex < 0` (e.g. during end-of-game TRUE-LOSER resolution, which is engine-internal and not a timed player turn).

---

## 8. Edge Cases (resolved — no TBDs that block the engine)

### 8.1 Deck size & joker count selection (engine-critical, resolved)

- **Composition (v1, 3–5 players):** exactly **1 standard 52-card deck + 2 Jokers = 54 cards** before cutting. (`Card` type in `engine-types.ts` has no Joker rank — see ⚠ §8.6.)
- **Target stock life:** the ruleset says "~7–9 rounds." We make this deterministic: `targetCards = handCardsDealt + roundsTarget * players.length`, where `handCardsDealt = 5 * players.length` and `roundsTarget` defaults to **8**. Clamp `targetCards` to `[handCardsDealt + players.length, 54]`. Example (4 players): `20 + 8*4 = 52`, so cut 2 cards from the 54.
- **The cut:** shuffle the 54-card deck with the PRNG, then **remove the top `(54 - targetCards)` cards** (the "cut"). The cut is **blind** — cards removed may include Jokers. This is intentional and deterministic and honors the ruleset's "the cards used changes every trick." (If a trick's deck ends up with 0 Jokers it has no effect on that trick — Jokers only matter for hand value, 0, and the end-of-game draw, which uses a **fresh full deck**, §8.5.)
- **Override:** `config.options.deckTargetRounds` (number) and `config.options.extraDecks` (number, default 0) allow tuning; v1 lobby may not expose these (defaults used). `GameEngineConfig.options` is already `Record<string, unknown>` (**verified in `game-engine.ts`**) — no plumbing change.
- **Determinism:** the per-trick deck uses sub-seed `hashSeed(randomSeed + ":trick:" + trickNumber)`; same seed + trick → identical deck and cut (testing-principles #2; can be fixed via `FixedPRNG`).

### 8.2 Discarding multiples

- A discard payload may contain **>1 card** only if **all are the same rank**, all in hand. Mixed ranks → reject (`"Discard must be a single rank"`). Jokers group only with Jokers.
- Regardless of count discarded, the draw phase draws exactly **1**.
- Only the **single top** card of a multi-discard becomes the next player's `drawableDiscard` snapshot (§4.2); the buried cards of the multi-discard are never drawable.

### 8.3 Draw-source legality

Draw legality is governed by the **turn-start snapshot** `drawableDiscard` (§4.2), **not** by the live `discardPile` top. (Because discard happens before draw, the live top is the current player's own card by the time they draw; reading the live top would make draw-from-discard either impossible or self-drawing — see §3.3.)

- `draw` from `"discard"` is legal **only** when `drawableDiscard !== null`. The drawn card is exactly `drawableDiscard`.
- `drawableDiscard` is the single top-most card the immediately-preceding active player placed *before* the current player discarded (or the trick-2+ face-up start card). It is captured at turn start and is **never** the current player's own just-discarded card — a player can therefore **never** draw back a card they just discarded.
- If the immediately-preceding player discarded multiples, `drawableDiscard` is only the **single top 1**; buried cards are never drawable.
- **Trick-1 first player:** `drawableDiscard === null` (pile started empty, no preceding discard) → `"discard"` source is **illegal**; only `"stock"`.
- **Trick 2+ starter:** `drawableDiscard` = the trick-start face-up card → `"discard"` source legal, per ruleset.
- Reject `draw` with an out-of-band / arbitrary source (anything other than `"stock"` or `"discard"`), and reject `draw` from `"discard"` when `drawableDiscard === null`.

### 8.4 TONK gate & timing

- `callTonk` rejected if `trickTurnCount < players.length` (`"TONK can only be called after every player has had a turn"`).
- `callTonk` rejected if `turnPhase !== "discard"` (must be at the start of the turn, before discarding).
- After a valid `callTonk`: reveal all hands, score per §5.1, end trick.

### 8.5 TRUE LOSER draw

- Uses a **fresh full deck** (52 + 2 Jokers), shuffled via sub-seed `hashSeed(randomSeed + ":trueloser:" + trickNumber)`.
- Lost players draw in ascending seat order, looping, until a Joker is drawn; that player is TRUE LOSER. With 2 Jokers in 54 cards, termination is guaranteed (a Joker is always reachable). Single lost player → automatic TRUE LOSER (no draw).

### 8.6 Joker representation ⚠ (type gap, resolved by deferral to #57)

- `Card` in `src/shared/engine-types.ts` is `{ suit: Suit; rank: Rank }` with **no Joker**. Tonk needs Jokers (value 0, TRUE-LOSER token).
- **Resolution (for #57, not this docs gate):** represent a Joker without touching the shared `Card`/`Rank` types used by Big2. Recommended: a Tonk-local `TonkCard = Card | { joker: true; id: number }` discriminated type stored in `TonkState`, with a `cardValue(card)` helper returning 0 for jokers. This avoids widening `Rank` (which would ripple into Big2's `RANK_ORDER` and comparisons). **Flagged as a leaking-abstraction risk**; the recommended fix is Tonk-local and additive, requiring **no change to Big2 or shared `Card`**. The engine LLD owns the final type; this spec only requires that Jokers exist, are worth 0, and serve as the TRUE-LOSER token.

### 8.7 Other edge cases

| Edge case | Handling |
| --- | --- |
| Action not in `validActions` / wrong phase | Reject (e.g. `draw` while `turnPhase = "discard"`). State unchanged. |
| Action when not your turn | Reject `"Not your turn"` (Big2 pattern). |
| Action after `COMPLETED` | Reject `"Game is already over"`. |
| Discard a card not in hand | Reject `"Cards not in hand"`. |
| Empty discard payload | Reject `"Must discard at least one card"`. |
| Stock empty at draw phase | Trick ends, Case C scoring (§7). |
| Stock empty at start of a turn's discard | Discard still allowed (sink is the pile); trick only ends when a draw can't be satisfied. |
| Tie for lowest in Case C | All tied-lowest players each add 30 (default — confirm §9.7). |
| Tie at match end for lowest tally (the "winner") | Lowest seat index among the tied (deterministic). |
| Multiple players ≥150 simultaneously | All marked lost; TRUE LOSER by joker draw (§5.3). |
| Player ≥150 but also lowest tally | Still "lost" (any ≥150 has lost, per ruleset); cannot be the `winner`. If *all* players are ≥150, `winner` = lowest tally among them but they are still all "lost"; TRUE LOSER decides. (Confirm at §9.8 whether `winner` should be null in an all-lost game.) |
| Initialize with <3 or >5 players | `initialize` throws `"Tonk requires 3-5 players"`. |
| Reconnection / spectator mid-trick | Standard `getPlayerView`/`getSpectatorView`; revealed hands only exist transiently in the log at trick end. |

---

## 9. Variant Sign-Off (HARD GATE)

**Engine sub-issue #57 MUST NOT begin until the user explicitly signs off on the points below.** This spec is transcribed from the user's authoritative `TONK.Rules.md` (verified faithful); the items marked **(default)** are engine-critical points the ruleset's prose left open, resolved here with a concrete default for confirmation. The three items the prose most clearly leaves open are **§9.1 (single-deck / maxPlayers = 5), §9.3 (trick-1 starter = seat 0), and §9.7 (Case-C tie handling)** — these are the primary questions to put to the user.

Confirm:

1. **Player range = 3–5, single deck (52 + 2 Jokers), v1.** Multi-deck / 6+ players deferred. **(default)**
2. **Deck-size heuristic:** `roundsTarget = 8`, deterministic blind cut via seed; jokers may be cut from a trick's deck. **(default)**
3. **Trick-1 starter = seat 0** (ruleset specifies the starter only for trick 2+). **(default)**
4. **Turn timer auto-action:** discard-phase → discard single highest card (never auto-TONK); draw-phase → draw from stock. Timer re-arms per phase. **(default)**
5. **Joker = value 0 and the TRUE-LOSER token; TRUE-LOSER draw uses a fresh full 54-card deck.** (From ruleset; confirming Joker count = 2.) **(default for joker count)**
6. **Stats mapping:** `winner` = lowest final tally; TRUE LOSER recorded via `breakdown.trueLoser`; recommend the small `StatsService` change (option 2, §6.3) so only the TRUE LOSER counts as a loss. **(default — recommendation)**
7. **Case C tie (multiple lowest hands at stock-out):** each tied-lowest player adds 30. **(default)**
8. **All-players-lost edge:** `winner` = lowest tally among them (vs `null`). **(default — confirm)**

On sign-off, record the date and any overrides at the top of this section, then proceed to LLD for engine sub-issue #57.

> **Downstream warning (process):** sub-issues **#57–#60** have stale bodies that reference the superseded mechanics from LLD 59 / PR #73 (spreads, melds, hitting, drop/knock, draw-then-discard, going-out-by-emptying-hand). Once the variant here is signed off, those issue bodies must be **rewritten against this LLD** before any engine/types/frontend/transport work begins.

---

## 10. Dependencies

| Dependency | Status | Use |
| --- | --- | --- |
| `src/backend/engine/game-engine.ts` (`GameEngine`, `GameEngineConfig`) | Implemented (LLD 02) | Interface the Tonk engine (#57) implements. `config.options` is `Record<string, unknown>` (verified). |
| `src/shared/engine-types.ts` | Implemented | `InternalGameState`, `PlayerView`, `Card`, `GameType` (already includes `"tonk"`), etc. **Joker gap flagged §8.6** (resolved Tonk-locally in #57). |
| `src/backend/engine/prng.ts` (`PRNG`, `SeededPRNG`, `FixedPRNG`, `hashSeed`, `generateSeed`) | Implemented (verified exports) | Deterministic deck cut + TRUE-LOSER draw via sub-seeds. |
| `src/backend/engine/game-engine-factory.ts` | Implemented | `TonkEngine` registered here in #57. `"tonk"` already in `GameType`. |
| `src/backend/service/statsService.ts` | Implemented (verified lines 29–31) | Stats mapping §6.3 (recommend isolated additive change, option 2). |
| Big2 reference (`big2-engine.ts`, LLD 04) | Implemented | Pattern for immutability, `validateAction` delegation, view filtering, auto-timeout. |

**This LLD has no code dependencies — it is docs-only.** Downstream sub-issue #57 (engine) depends on this spec being **signed off** (§9).

---

## 11. Test Requirements

> Tests are written in #57 (engine), not here. This section specifies **what** must be tested so the engine LLD/implementer have an unambiguous target. Per testing-principles: pure-function engine tests, controlled randomness (`FixedPRNG` / seeded), self-contained, invalid-action coverage, info-leakage, invariants, one full-game simulation.

### Unit — card values & hand value
- Ace=1, J/Q/K=10, 2–10=face, Joker=0; hand value = sum.

### Unit — deck build & cut (determinism)
- Same seed + trick → identical deck and identical cut.
- Deck size honors `roundsTarget` math and clamps; player-count-driven composition.
- Cut is reproducible and may remove jokers.

### Unit — turn phases (discard → draw)
- `validActions` correct per phase and per TONK gate (§6.2).
- Discard: single card OK; multiples same-rank OK; mixed-rank rejected; not-in-hand rejected; empty rejected.
- Draw: from stock OK; from discard only when the turn-start snapshot `drawableDiscard !== null`; out-of-band/arbitrary source rejected; trick-1 first player cannot draw from discard (`drawableDiscard === null`).
- Turn hands off only **after** the draw phase, to the next seat.

### Unit — drawable-discard snapshot (discard-before-draw sequencing)
- **Buried preceding discard is still drawable:** after the current player discards (so the immediately-preceding player's card is no longer the live pile top), `draw` from `"discard"` still succeeds and yields exactly the immediately-preceding player's top card (the turn-start `drawableDiscard` snapshot), **not** the live pile top.
- **No self-draw:** the current player can **never** draw back a card they just discarded — `draw` from `"discard"` never returns the current player's own just-discarded card, even when it is the live pile top.
- **Snapshot captured at turn start:** `drawableDiscard` is set to the immediately-preceding player's single top card at the moment the turn begins, and is unchanged by the current player's own discard.
- **Multiples:** if the immediately-preceding player discarded multiples, only the single top card is the snapshot; buried cards of that multi-discard are never drawable.
- **Trick-2+ start card:** the face-up start card is the trick starter's initial `drawableDiscard`; it remains drawable after the starter discards (buries it) and is never confused with the starter's own discard.
- After drawing from `"discard"`, the snapshot is consumed (the card leaves the pile and enters the hand) and the next player's snapshot is recomputed at their turn start.

### Unit — TONK
- Rejected before everyone has had a turn; rejected outside discard phase / after discarding.
- Case A: caller strictly lowest → others add their hand value, caller adds 0.
- Case B: caller tied/beaten → caller adds 30, others add 0.

### Unit — stock exhaustion (Case C)
- Draw phase with empty stock ends the trick; lowest hand adds 30; ties each add 30.

### Unit — match end & TRUE LOSER
- Tally ≥150 → that player lost; new trick otherwise.
- Single lost player → auto TRUE LOSER.
- Multiple lost → joker-draw (deterministic via seed) picks TRUE LOSER; termination guaranteed.
- `winner` = lowest final tally; `breakdown.trueLoser` set on the true loser.

### Unit — invalid actions (testing-principles #6)
- Wrong turn, wrong phase, action after `COMPLETED`, action not in `validActions`: all rejected, **state unchanged**, version not incremented.

### Unit — auto-timeout (§7)
- Discard phase → single highest-value card, never multiples, never TONK.
- Draw phase → stock; empty stock → trick ends.
- Returns `null` when not `IN_PROGRESS` / no active turn.

### Security — information hiding (testing-principles #7)
- `getPlayerView(state, A)` never contains B's hand or the stock contents.
- Opponent info is counts only; stock is a count only.
- Discard top and counts and tallies are public.
- `getSpectatorView` contains no hands and no stock contents.
- At trick end, revealed hands appear only in the public log/result, not as ongoing hidden state leakage.

### Invariants — assert after every action (testing-principles #8)
- **Card conservation:** Σ hands + stock + discard = the trick's deck size (no cards created/destroyed within a trick). `drawableDiscard` is a **snapshot reference** to a card still physically present in `discardPile` (until drawn) — it is **not** counted separately, so it must never break conservation. When a player draws the snapshot, that card moves from `discardPile` to the hand (conservation preserved) and `drawableDiscard` is recomputed at the next turn start.
- `currentPlayerIndex` is a valid active seat while `IN_PROGRESS` (or `-1` when `COMPLETED`).
- `validActions` non-empty for the current player while `IN_PROGRESS` (no deadlock).
- `status` only advances forward (never `COMPLETED` → `IN_PROGRESS`).
- `tallies` are monotonically non-decreasing across tricks.
- `version` strictly increases by 1 per applied action.

### Integration — full match simulation (testing-principles #9)
- Seeded PRNG, pick from `validActions` each step (simple strategy), play tricks until some player ≥150 and a TRUE LOSER is resolved.
- Assert invariants hold every step, the match terminates (no infinite loop), `winner`/`scores`/`trueLoser` populated, and `StatsService.recordGameCompletion` consumes the result without error (per §6.3 mapping).
