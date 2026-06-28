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
| Players | 3–5 with one deck; 6+ with two or more decks. **Proposed default (awaiting sign-off): `minPlayers: 3`, `maxPlayers: 6`** — ≤5 = single deck (54 cards), 6 = two decks; the pool is cut to the `deckRoundsTarget` (default 8), which cuts at every player count including ≤5 (see §8.1). Multi-deck is now proposed as an adopted default, not deferred. |
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

4. **Lower-is-better maps onto the stats pipeline via a tally-driven multi-winner derivation, not a pipeline change.** Tonk has potentially **multiple winners** (everyone who did NOT lose) and one or more losers. Win/loss is derived per player from the final tally vs the 150 threshold (`finalTally >= 150` ⇒ lost), **not** from `state.winner`. The `StatsDelta` counters are already independent (verified: `database.ts:23-27`), so this is a *derivation-logic* change for Tonk, not a schema change. `state.winner` becomes a display-only "best result" value that does **not** drive stats. The **TRUE LOSER** is recorded via `breakdown` as a flavor distinction within the losers. Detail in §6.3 (the residual leaking-abstraction note is now narrow: the existing derivation is single-winner today and its derivation must be updated for Tonk).

5. **No melds, hits, drops, or hand-emptying anywhere.** The action set is exactly `{ discard, draw, callTonk }`. This keeps the engine far simpler than Big2's combination logic.

### 2.3 Alternatives considered

- **Multi-deck (6+ players) in v1** — now **adopted as a proposed default** (was previously deferred; that deferral is reversed here). It adds modest deck-multiplicity bookkeeping (`numDecks = ceil(players / 5)`) and `2 * numDecks` Jokers for the TRUE-LOSER draw, but the rest of the stack already supports it: the backend has **no hard player cap** (`createGame.ts` passes `maxPlayers` through with only a truthy check; engines self-validate via `GameEngineConfig.minPlayers/maxPlayers` — verified), and the frontend `OpponentRow.vue` is an uncapped `v-for` flex row that renders any count (6+ is only visually cramped — CSS polish, not a blocker). We therefore propose `maxPlayers: 6` (the ruleset's own single→multi-deck cutoff): ≤5 stays single-deck, 6 triggers two decks; both are cut to the `deckRoundsTarget` (default 8 cuts at all counts — §8.1, §9.9). **Proposed default — confirm at sign-off (§9.1).**
- **Treating each trick as a separate `InternalGameState` / game record** — rejected. Stats and the 150-point match span multiple tricks; one persistent game state across tricks matches the cache/persistence model (architecture-principles #5) and the existing `Game` row.
- **Auto-win on a low dealt hand ("instant tonk on deal")** — rejected; not in the user's ruleset. TONK is gated to "after every player has had ≥1 turn."

---

## 3. Rules Specification (authoritative transcription)

### 3.1 Setup (per trick)

1. **Deck build.** Compose the deck (§8.1): for **≤5 players**, exactly 1 standard 52-card deck **+ 2 Jokers** (54 cards); for **6+ players**, `ceil(players / 5)` decks (each 52 + 2 Jokers) shuffled together. The pool is then **cut** down to a target size driven by `deckRoundsTarget` (default **8**) so the stock lasts ~7–9 rounds after dealing. At the default target the cut applies at **every** player count — including ≤5 (e.g. 3 players cut 15 cards) — so the card set changes between tricks at all counts (§8.1, §9.9). The cut is deterministic given the seed.
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
| `winner` | Set at `COMPLETED` to the player with the lowest final tally (ties → lowest seat index); **display/best-result only; does NOT drive stats — see §6.3.** Stats derive from each player's tally vs 150, not from this field. |
| `scores` | At `COMPLETED`: one `PlayerScore` per player. `score` = final running tally (lower is better). `breakdown` carries `{ lost: 0|1, trueLoser: 0|1, finalTally }`, where `lost = (finalTally >= 150) ? 1 : 0` (this — not `winner` — is what drives `gamesWon`/`gamesLost`; §6.3) and `trueLoser` is the within-losers flavor distinction (does not affect win/loss). **`PlayerScore.breakdown` is typed `Record<string, number>` (verified: `engine-types.ts:80`), so `lost`/`trueLoser` are numeric `0\|1` flags, NOT booleans — #57 must encode them as numbers (e.g. `lost: 1`), not `true`/`false`.** |
| `randomSeed` | The seed; deck build, every per-trick reshuffle (and the cut at 6+ players, §8.1), and the TRUE-LOSER joker draw all derive from a PRNG seeded by it (deterministic replay). |
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
- If **more than one** player has lost: shuffle a fresh full pool (consistent with the game's deck count — `numDecks` decks, i.e. `2 * numDecks` Jokers) via the PRNG, then the lost players draw one card at a time in seat order, repeating, until a **Joker** is drawn. The player who draws the Joker is the **TRUE LOSER**. (Deterministic given seed; §8.5.) More decks only add more Jokers, so termination remains guaranteed.
- `state.status` → `COMPLETED`; `trueLoserIndex` set; `winner`/`scores` populated per §6.3.

---

## 6. Mapping onto the existing `GameEngine` interface

Every method of `GameEngine` (`src/backend/engine/game-engine.ts`) maps as follows. Items flagged ⚠ are leaking-abstraction risks surfaced now per the issue's instruction. The interface was read and the mapping below is consistent with its documented contracts.

### 6.1 Method-by-method

| Method | Tonk behavior |
| --- | --- |
| `initialize(gameId, players, config, prng)` | Validate `3 ≤ players.length ≤ 6` (proposed range — §9.1). Build the deck deterministically (§8.1) using `prng` and `config.options` (optional `deckRoundsTarget` [creator-set, range 5–12, default 8 — §8.1, §8.8], `extraDecks`): the §8.1 cut formula applies uniformly (at the default `deckRoundsTarget = 8` it cuts at every player count, including ≤5; only a high enough target yields no cut). Deal 5 each; rest → stock; trick-1 discard empty. `currentPlayerIndex` = 0. `status = IN_PROGRESS`, `version = 1`, `tallies` all 0, `trickNumber = 1`, `turnPhase = "discard"`. Reads `config.options.deckRoundsTarget` defaulting to 8 (⚠ not populated today — `config.options` is `{}` at `gameService.ts:102`; see §8.8). |
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

### 6.3 Stats pipeline mapping ⚠ (leaking-abstraction: winner-centric derivation today)

> **Forward reference (out of scope here):** Game-specific (per-game-type) stats are specified in a separate forthcoming stats LLD; this section assumes the existing **global** `player_stats` contract and changes only the win/loss **derivation** for Tonk.

**Multi-winner model.** Tonk has potentially **MULTIPLE winners** — *everyone who did NOT lose is a winner* — and one or more losers. A player has **lost** iff their final tally is **≥ 150** (the ruleset: "ANY player ≥150 has lost"). The **TRUE LOSER** (§5.3) is a flavor distinction **within the losers**; it does **not** change who won or lost.

**Counters are already independent — only the derivation changes.** `StatsDelta` (`src/backend/database/database.ts:23-27`) has **independent integer counters**: `gamesWon: number` (line 25), `gamesLost: number` (line 26), `totalScore: number` (line 27). They are **not** mutually derived in the type, so the multi-winner mapping needs **no change to `StatsDelta` or the DB schema** — only the derivation logic changes.

`StatsService.recordGameCompletion` (`src/backend/service/statsService.ts:18-31`) **today** reads `const winnerId = state.winner;` (line 22) and derives, per non-guest player, `gamesWon: playerScore.playerId === winnerId ? 1 : 0` (line 29) and `gamesLost: playerScore.playerId !== winnerId ? 1 : 0` (line 30). That is the **single-winner** derivation (`state.winner` is a single `PlayerId | null` — `engine-types.ts:72` — and cannot hold multiple winners). For Tonk this derivation must be **decoupled from `state.winner`** and driven by tally-vs-150 instead. This is a derivation-logic change, **not** a `StatsDelta`/DB-schema change.

**Derivation for Tonk (per player at `COMPLETED`, derived from `scores[].score` = the final tally, NOT from `state.winner`):**
- `gamesLost = (finalTally >= 150) ? 1 : 0` — matches the ruleset (any player ≥150 has lost).
- `gamesWon  = (finalTally >= 150) ? 0 : 1` — everyone who did not lose won.
- `breakdown.trueLoser` (0/1) records the **TRUE LOSER** as a distinction **within** the losers; it does **NOT** affect `gamesWon`/`gamesLost`.
- `totalScore = finalTally` (still lower-is-better — note this inverts Big2's "higher score is better"; documented here so leaderboard/`totalScore` aggregation understands Tonk scores are **penalties, not achievements**).

Because the counters are independent and the derivation is the exact ≥150 set, there is **no over-counting** to debate — `gamesLost` is precisely the set of players at ≥150, and `gamesWon` is precisely the rest. The residual leaking-abstraction note is narrow: the **existing** `StatsService` derivation is single-winner today (`statsService.ts:29-30`, reading `state.winner`) and its derivation must be updated for Tonk to read tally-vs-150. The resolution is clean: independent counters (no schema change) + a tally-driven derivation. `state.winner` is decoupled — it is a display-only "best result" value (§4.1) and does not drive stats.

⚠ **Leaking-abstraction note (randomness in `applyAction`).** The interface says `applyAction` "takes no PRNG — it must be deterministic" and "mid-game randomness must use a pre-shuffled deck stored in `gameSpecificState`." Big2 needs no mid-game randomness. Tonk needs randomness **between tricks** (rebuild + cut a new deck) and **at game end** (TRUE-LOSER joker draw). We satisfy the determinism contract by re-seeding a `SeededPRNG` from a **derived sub-seed** (`hashSeed(randomSeed + ":trick:" + trickNumber)` / `+ ":trueloser:" + trickNumber`) inside `applyAction`. Same `(state, action)` → same result, no external PRNG needed. `hashSeed`, `SeededPRNG`, and `FixedPRNG` are exported from `src/backend/engine/prng.ts` (**verified**). This maps cleanly with **no interface change**; flagged so #57 implements the sub-seed scheme rather than reaching for `Math.random()` or threading a PRNG param.

---

## 7. Turn-timer / auto-timeout for a discard-then-draw turn

The turn timer (LLD 07) calls `getAutoTimeoutAction(state)` when a player's clock expires, and applies whatever it returns. For Tonk the auto-action depends on `turnPhase`:

| Phase when timer fires | Auto-action | Rationale |
| --- | --- | --- |
| `discard` | `discard` the **single highest-value card** in hand (one card, never multiples; never `callTonk`). Ties broken deterministically by a stable card order. | A timeout is a non-decision; auto-calling TONK could lose a player 30 points — never auto-call. Discarding the highest card is the harmless "reduce my hand value" default that mirrors Big2's "auto-action takes the safe minimal move." |
| `draw` | `draw` from the **stock**. | Drawing from the discard reveals intent/strategy; stock is the neutral default. If the stock is empty in the draw phase, see below. |

**Determinism:** `getAutoTimeoutAction` is pure and returns a valid `GameAction` for the current player (interface contract). Because a Tonk turn is two phases, a fully-timed-out turn fires the timeout **twice** (once per phase) — the timer (LLD 07) re-arms after the auto-discard is applied and the state is still that player's turn in `turnPhase = "draw"`. This is consistent with the interface: each call returns the single valid action for the current phase. **#57 + LLD 07 must confirm the timer re-arms within a turn across phases** (flagged; default is "yes, re-arm per phase" — confirm §9.4; this is also tracked as a hard integration dependency in §10).

**Deterministic tie-break (for #57):** when two or more cards share the highest value, the auto-discard picks among them by a **deterministic stable card order** that #57 must define explicitly (e.g. a fixed `(suit, rank)` ordering) so the auto-action is fully reproducible from `(state)` alone (testing-principle #2 — controlled, replayable determinism). The order itself is an engine detail; this spec only requires that it exists and is deterministic.

**Stock exhaustion mid-turn (Case C trigger):** if a player reaches the **draw phase** and the stock is empty, the trick ends immediately under §5.1 Case C (no draw possible). `applyAction` for the `draw` action (or auto-draw) detects empty stock and resolves the trick instead of drawing. A player **cannot** be forced to discard into an unwinnable state: the discard phase always succeeds (discard pile is the sink); only the draw phase can hit empty stock, and that ends the trick.

`getAutoTimeoutAction` returns `null` when `status !== "IN_PROGRESS"` or `currentPlayerIndex < 0` (e.g. during end-of-game TRUE-LOSER resolution, which is engine-internal and not a timed player turn).

---

## 8. Edge Cases (resolved — no TBDs that block the engine)

### 8.1 Deck composition, cut, and joker count selection (engine-critical, resolved — proposed defaults)

**Deck count.** `numDecks = ceil(players.length / 5)` (proposed default; `+ config.options.extraDecks`, default 0). 3–5 players → 1 deck; 6 players → 2 decks. **6 MUST trigger 2 decks** — this is the ruleset's own single→multi-deck cutoff. Each deck contributes **52 standard cards + 2 Jokers**, so `poolSize = 54 * numDecks` cards and `2 * numDecks` Jokers. (`Card` type in `engine-types.ts` has no Joker rank — see ⚠ §8.6.)

**Creator-configurable rounds target.** The cut is driven by `deckRoundsTarget`, an **integer the game creator picks in the lobby** = how many rounds the deck should last after dealing. **Range 5–12, default 8** (the 7–9-round heuristic sits inside that range). (This is the field previously named `roundsTarget` / `config.options.deckTargetRounds` and treated as an internal default; it is now exposed as a per-game creator control — renamed `deckRoundsTarget`. **NOTE: this is not wired to the engine today — see the new cross-stack plumbing in §8.8 (SCOPE EXPANSION).**) Whether to ship it as a creator control vs. keep it an internal constant for v1 is a sign-off question — §9.9.

**Unified cut formula (applies to BOTH ≤5 and 6+).** The cut amount is computed the same way for every player count from the same math:

```
handCardsDealt = 5 * players.length
poolSize       = 54 * numDecks
targetCards    = handCardsDealt + deckRoundsTarget * players.length
cutAmount      = max(0, poolSize - clamp(targetCards, [handCardsDealt + players.length, poolSize]))
```

- `clamp(x, [lo, hi])` = `min(hi, max(lo, x))`. The lower bound `handCardsDealt + players.length` guarantees the deck always survives at least one post-deal round (never cut below it); the upper bound `poolSize` means we never "need" more cards than exist, so `cutAmount` is never negative.
- **`cutAmount = 0` (NO CUT) falls out automatically whenever `targetCards ≥ poolSize`** — the clamp caps `targetCards` at `poolSize`, making `poolSize - clamp(...) = 0`. **At the default `deckRoundsTarget = 8` this does NOT happen at ≤5 players** (e.g. 3 players: `targetCards = 39 < poolSize = 54` → cut 15). No-cut only occurs at a **high enough** target (for 3 players, `deckRoundsTarget ≥ 13`), which is above the default. So at the default the deck IS cut at every player count and the card SET changes between tricks even at 3–5 players — this is the **accepted, recommended behavior** (§9.9): a low-player-count game gets the "cards change every trick" feel by default, not only on demand. A creator can still raise the target toward the top of the 5–12 range to shrink or eliminate the cut.
- **`cutAmount > 0` (REAL CUT)** whenever the creator's `targetCards < poolSize`. The cut removes the top `cutAmount` cards from the shuffled pool. The cut is **blind** — removed cards may include Jokers. Because the cut takes a different subset of the pool each trick (sub-seed varies by trick), the **card set genuinely changes every trick** when a cut applies. (If a trick's cut deck ends up with 0 Jokers it has no effect on that trick — Jokers only matter for hand value, 0, and the end-of-game draw, which uses a **fresh full pool**, §8.5.)

**Worked examples:**

| Scenario | players | numDecks | poolSize | handCardsDealt | deckRoundsTarget | targetCards (raw) | clamp range | targetCards (clamped) | cutAmount |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ≤5, **default → DOES cut** | 3 | 1 | 54 | 15 | 8 | 15 + 8·3 = 39 | [18, 54] | 39 | max(0, 54−39) = **15** |
| ≤5, high target → small cut | 3 | 1 | 54 | 15 | 12 | 15 + 12·3 = 51 | [18, 54] | 51 | max(0, 54−51) = **3** |
| ≤5, low target → larger cut | 3 | 1 | 54 | 15 | 5 | 15 + 5·3 = **30** | [18, 54] | 30 | max(0, 54−30) = **24** |
| ≤5, no-cut boundary | 3 | 1 | 54 | 15 | 13 | 15 + 13·3 = 54 | [18, 54] | 54 | max(0, 54−54) = **0** |
| 6+, default | 6 | 2 | 108 | 30 | 8 | 30 + 8·6 = **78** | [36, 108] | 78 | max(0, 108−78) = **30** |

- The 3-player default (`deckRoundsTarget = 8`) yields `targetCards = 39 < poolSize = 54`, so the formula cuts 15 cards. **Recommended resolution (§9.9): keep the default at 8 and accept this cut at ≤5 players** — the deck changing between tricks even at low player counts is acceptable/desirable. This collapses the earlier open question (it is no longer "raise the ≤5 default to avoid the cut"); the no-cut boundary (`deckRoundsTarget ≥ 13` for 3 players, see the table) is available to a creator who explicitly wants no cut, but it is **not** the default. The formula is correct and deterministic at every value; this is a product-default choice, recorded as the recommended resolution at §9.9 (still awaiting the user's own sign-off as part of the §9 gate).
- The 6-player default (`deckRoundsTarget = 8`) yields `targetCards = 78`, `cutAmount = 30`, consistent with the prior worked example.

**Overrides.** `config.options.extraDecks` (number, default 0) still allows deck-count tuning. The old `config.options.deckTargetRounds` is renamed/superseded by the creator-facing `deckRoundsTarget`. **⚠ Both `deckTargetRounds` and `extraDecks` are DEAD config today:** `config.options` is hardcoded to `{}` at `gameService.ts:102`, so nothing in `config.options` reaches the engine. Wiring `deckRoundsTarget` from the lobby to the engine therefore requires NEW cross-stack plumbing (API + DB + frontend), specified in **§8.8 (SCOPE EXPANSION)**; `GameEngineConfig.options` being typed `Record<string, unknown>` (**verified in `game-engine.ts`**) is necessary but **not sufficient** — the value still has to be put there at start time.

**Determinism.** The per-trick deck uses sub-seed `hashSeed(randomSeed + ":trick:" + trickNumber)`; same seed + trick + `deckRoundsTarget` → identical shuffle AND identical cut (testing-principles #2; can be fixed via `FixedPRNG`).

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

- Uses a **fresh full pool** consistent with the game's deck count: `numDecks` decks = `54 * numDecks` cards including `2 * numDecks` Jokers (so 54 / 2 Jokers at ≤5 players; 108 / 4 Jokers at 6 players), shuffled via sub-seed `hashSeed(randomSeed + ":trueloser:" + trickNumber)`.
- Lost players draw in ascending seat order, looping, until a Joker is drawn; that player is TRUE LOSER. With `2 * numDecks ≥ 2` Jokers in the pool, termination is guaranteed (a Joker is always reachable — more Jokers only makes one reachable sooner). Single lost player → automatic TRUE LOSER (no draw).

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
| Tie at match end for lowest tally (the display "winner") | Lowest seat index among the tied (deterministic). This is a **display tiebreak only** — `winner` does not drive stats (§6.3), so the tiebreak affects only the best-result display, not who won/lost. |
| Multiple players ≥150 simultaneously | All marked lost; TRUE LOSER by joker draw (§5.3). |
| Player ≥150 but also lowest tally | Still "lost" — `gamesLost = 1` for any player ≥150 (per ruleset), regardless of being the lowest tally. The display `winner` (lowest tally) is independent of win/loss (§6.3), so a lost player can still be the lowest-tally display `winner` while counting as a loss in stats. If *all* players are ≥150, every player gets `gamesLost = 1, gamesWon = 0`; `winner` = lowest tally among them as the display best-result; TRUE LOSER decides the flavor distinction. (Confirm at §9.8 whether the display `winner` should be `null` in an all-lost game.) |
| Initialize with <3 or >6 players | `initialize` throws `"Tonk requires 3-6 players"` (proposed range — §9.1). |
| Reconnection / spectator mid-trick | Standard `getPlayerView`/`getSpectatorView`; revealed hands only exist transiently in the log at trick end. |
| Creator omits `deckRoundsTarget` | Default to **8** (the field is optional in the request; engine falls back to the default if `config.options.deckRoundsTarget` is absent). |
| `deckRoundsTarget` out of range (<5 or >12, or non-integer) | Reject at the API boundary (§8.8); the engine additionally clamps/defaults defensively but the authoritative validation is `createGame.ts`. |

### 8.8 Creator configuration plumbing (`deckRoundsTarget`) ⚠ SCOPE EXPANSION (beyond engine #57)

> **This subsection is a SCOPE EXPANSION flagged for sign-off (§9.9).** Exposing `deckRoundsTarget` as a creator control is **not** an engine-only change — it creates new **API + DB + frontend** work that belongs to sub-issues *beyond* #57. The engine (#57) only needs to *read* `config.options.deckRoundsTarget` (defaulting to 8); everything below is what must exist *outside* the engine for the creator's lobby choice to actually reach `initialize`. Cross-reference §10 (Dependencies). If the user prefers to keep `deckRoundsTarget` an **internal constant for v1** (no creator control), **none of this plumbing is needed** and only the engine default applies — that is the alternative offered at §9.9.

**The core problem (verified against source).** `config.options` is **hardcoded to `{}`** at `gameService.ts:102`:

```ts
const config = { maxPlayers: game.maxPlayers, minPlayers, options: {} }; // gameService.ts:102
const state = engine.initialize(gameId, players, config, prng);          // gameService.ts:104
```

So there is **no path today** for any per-game option (including the §8.1 `deckTargetRounds`/`extraDecks` "overrides") to reach the engine — they are **dead config**. Adding a creator control means building the path, not flipping a flag.

**A generic `gameOptions` field already exists but is also dead — deliberate choice NOT to reuse it (verified against source).** `CreateGameRequest` already carries an untyped bag `gameOptions: { [key: string]: string }` (`src/shared/model.ts:16`), and the frontend already sends it (`src/frontend/component/CreateGameView.vue:22`, currently `{}`). But the **backend never reads `gameOptions`** (zero backend references) and it is never persisted — so it is just as dead a path as `config.options`. An implementer will reasonably ask "why not put `deckRoundsTarget` into the existing `gameOptions` bag?" — so this is called out as a deliberate decision, not an oversight:
> **Recommendation: a dedicated TYPED field `deckRoundsTarget?: number`, NOT a `gameOptions` entry.** Rationale: (1) it mirrors the proven, fully-wired `turnTimerSeconds` precedent (typed field + `VALID_TIMER_VALUES`-style validation + persisted column); (2) `gameOptions` is `string`-valued, so a numeric round-target would need stringify/parse and lose compile-time typing and clean range validation; (3) reusing `gameOptions` would STILL require the same new persistence + start-time-wiring work (it is unpersisted and unread today), so it saves nothing on the hard part while costing type safety. The alternative — wiring `gameOptions` end-to-end as the generic options channel — is viable but is a larger, cross-cutting change (it would also affect Big2 and any future per-game option) and is out of scope for this Tonk LLD; if the team later wants a generic options bag, that is a separate decision. **Either way, the existing `gameOptions` field must not be left ambiguously half-used: if the typed field is chosen, `gameOptions` stays unused (or is removed in a separate cleanup, not here).**

Mirror the **existing, fully-traced `turnTimerSeconds` precedent** end-to-end:

| Step | File:line (verified) | Change for `deckRoundsTarget` |
| --- | --- | --- |
| (a) Request type | `src/shared/model.ts` — `CreateGameRequest` (interface at line 13; `turnTimerSeconds: 30 \| 60 \| 90` at line 17) | Add `deckRoundsTarget?: number` to `CreateGameRequest` (optional; default applied if absent). Also surface it on the persisted game shape: `SerializableGame` (line 48) carries `turnTimerSeconds: number \| null` at line 56 — add a parallel `deckRoundsTarget: number \| null`. |
| (b) API validation | `src/backend/api/game/createGame.ts` — `VALID_TIMER_VALUES = new Set([30,60,90])` at line 10; rejects out-of-set at lines 21–22 | Mirror the timer check: validate `deckRoundsTarget` is an **integer in [5, 12]**; reject with `BadRequestError` otherwise. (A range check rather than a set, but the same reject-at-boundary shape.) If absent, treat as default 8 (do not reject). |
| (c) DB persistence | `src/backend/database/entities/Game.ts` — persisted column `turnTimerSeconds: number \| null = null;` at line 11 | Add a **NEW persisted field/column** `deckRoundsTarget: number \| null = null;`. **There is NO generic per-game options column today** (the entity has only specific columns), so a dedicated column is required for the creator's choice to survive to game start. |
| (d) Start-time wiring | `src/backend/service/gameService.ts` — `startGame` (line 72); the hardcoded `options: {}` (line 102) | Replace `options: {}` with `options: { deckRoundsTarget: game.deckRoundsTarget ?? 8 }` (read the persisted value; default 8 when null). This is the single line that makes ANY per-game option reach the engine — note it currently sends `{}`, so this is **new wiring, not enabling something that exists**. |
| (e) Frontend lobby control | (create-game lobby view — same component that renders the turn-timer picker) | Add a number input / slider for `deckRoundsTarget`, range 5–12, default 8, mirroring the existing turn-timer picker; include it in the `CreateGameRequest` payload. Visual spec belongs to `frontend-architect`. |

**Engine side (#57, in scope for the engine LLD):** `initialize` reads `config.options.deckRoundsTarget`, validates/clamps to [5, 12] defensively, defaults to 8 if absent, and feeds it into the §8.1 cut formula. The engine must remain correct and deterministic for any value in range regardless of whether the plumbing (a)–(e) ships — i.e. if (a)–(e) are deferred, the engine simply always sees the default 8.

**Sub-issue ownership.** (a)–(b) and (d) are backend-API/service work; (c) is a DB-entity/migration change; (e) is frontend. These are **distinct sub-issues from the engine (#57)** and must be tracked as such. Flagged here so the expansion is visible at sign-off and not silently absorbed into the engine estimate.

---

## 9. Variant Sign-Off (HARD GATE)

**Engine sub-issue #57 MUST NOT begin until the user explicitly signs off on the points below.** This spec is transcribed from the user's authoritative `TONK.Rules.md` (verified faithful); the items marked **(default)** are engine-critical points the ruleset's prose left open, resolved here with a concrete default for confirmation. The three items the prose most clearly leaves open are **§9.1 (player range now proposed as 3–6: ≤5 = single deck, 6 = two decks then cut), §9.3 (trick-1 starter = seat 0), and §9.7 (Case-C tie handling)** — these are the primary questions to put to the user. Note §9.1 reverses the earlier "multi-deck deferred" stance: multi-deck is now a proposed default, with 6+ frontend seating flagged as a downstream **non-blocking** CSS-polish cost (`OpponentRow.vue` already renders any count; backend has no hard cap — see §2.3). **Also notable: §9.9** covers the deck cut. Its default-cut sub-decision now has a **recommended resolution** (keep `deckRoundsTarget` default = 8 and accept the cut at ≤5 players; awaiting the user's own confirmation under this gate). The separate creator-control question — exposing `deckRoundsTarget` in the lobby, a **SCOPE EXPANSION** (new API + DB + frontend plumbing, §8.8) beyond the engine, vs. keeping it an internal constant for v1 — is still open and needs an explicit decision.

Confirm:

1. **Player range = 3–6.** ≤5 players → 1 deck (52 + 2 Jokers = 54); 6 players → `ceil(players/5)` = 2 decks shuffled together. The pool is cut to the `deckRoundsTarget` (default 8), which cuts at **every** player count including ≤5 (§8.1, §9.9) — the card set changes between tricks at all counts. Multi-deck is now adopted as a proposed default (reverses the earlier deferral). 6+ frontend seating is a downstream **non-blocking** CSS-polish cost (§2.3). **(default — confirm)**
2. **Deck-size heuristic:** `numDecks = ceil(players/5)`; the cut amount comes from the unified §8.1 formula driven by `deckRoundsTarget` (creator-set, range 5–12, default 8 — §9.9), deterministic blind cut via seed; Jokers may be cut from a trick's deck. At the default target the cut applies at all player counts (e.g. 15 cards at 3 players); `cutAmount = 0` only when a high enough target makes `targetCards ≥ poolSize` (`deckRoundsTarget ≥ 13` for 3 players — above the default). **(default)**
3. **Trick-1 starter = seat 0** (ruleset specifies the starter only for trick 2+). **(default)**
4. **Turn timer auto-action:** discard-phase → discard single highest card (#57 defines a deterministic stable tie-break order, §7; never auto-TONK); draw-phase → draw from stock. Timer re-arms per phase — a **hard cross-LLD integration requirement** (LLD 07), tracked in §10, not merely a preference: without per-phase re-arm a timed-out turn stalls (§7). **(default)**
5. **Joker = value 0 and the TRUE-LOSER token; TRUE-LOSER draw uses a fresh full pool of `numDecks` decks** (`2 * numDecks` Jokers — 2 at ≤5 players, 4 at 6 players). (From ruleset; confirming Joker count = `2 * numDecks`.) **(default for joker count)**
6. **Stats mapping (multi-winner):** win/loss derives per player from the final tally vs 150 — `gamesLost = (finalTally >= 150) ? 1 : 0`, `gamesWon = (finalTally >= 150) ? 0 : 1` (everyone who did not lose won), `totalScore = finalTally` (penalty, lower is better). `breakdown.trueLoser` records the TRUE LOSER as a within-losers flavor distinction and does NOT affect win/loss. `state.winner` is decoupled — display-only (lowest tally), does not drive stats. This is a derivation-logic change for Tonk's `StatsService` mapping, NOT a `StatsDelta`/DB-schema change (counters are already independent — `database.ts:23-27`). Per-game-type stats are a separate forthcoming LLD (§6.3). **(default — confirm)**
7. **Case C tie (multiple lowest hands at stock-out):** each tied-lowest player adds 30. **(default)**
8. **All-players-lost edge:** `winner` = lowest tally among them (vs `null`). **(default — confirm)**
9. **Creator-configurable deck cut (`deckRoundsTarget`) — and the SCOPE EXPANSION it carries.** The game creator picks `deckRoundsTarget` in the lobby (control type: a **number input / slider**, **range 5–12, default 8**), driving the §8.1 cut formula: a low value cuts more, a high value (≥13 for 3 players) yields no cut.

   - **Default-cut sub-decision — RECOMMENDED RESOLUTION (still awaiting the user's own sign-off as part of this gate).** The earlier open boundary question ("default 8 cuts at ≤5 — is that intended, or raise the ≤5 default to avoid the cut?") has a recommended resolution: **keep `deckRoundsTarget` default = 8 and ACCEPT the resulting cut at ≤5 players** (e.g. 15 cards at 3 players), so the deck changes between tricks even at low player counts — judged acceptable/desirable. §8.1 prose and examples now reflect this recommendation. *This is recorded as the recommended default, NOT as a settled user sign-off — it remains `(default — confirm)` under the §9 gate until the user confirms it directly. I have not received that confirmation.*
   - **Scope-expansion decision — still open.** Exposing `deckRoundsTarget` as a creator control is a **scope expansion beyond the engine (#57):** it adds new API + DB + frontend plumbing (§8.8) — `deckRoundsTarget?` on `CreateGameRequest` (model.ts), range validation in createGame.ts, a NEW persisted column on the `Game` entity (no generic options column exists today), the `gameService.startGame` change to pass it into `config.options` instead of the hardcoded `{}` (`gameService.ts:102`), and a lobby control mirroring the turn-timer picker. **Confirm whether to build that plumbing, OR keep `deckRoundsTarget` an internal constant for v1** (engine default 8 only, NO creator control — which avoids all the new plumbing entirely).

   **(default — confirm)**

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
| **Turn timer (LLD 07)** | Implemented | **HARD integration requirement — tracked check, not a preference.** A Tonk turn is two phases (discard then draw), so the timer MUST **re-arm per phase within a single turn**: on timeout it applies the auto-discard, then must fire **again** for the auto-draw while it is still the same player's turn (`turnPhase = "draw"`). If LLD 07's timer fires only **once per turn**, a timed-out player would auto-discard but never auto-draw and the turn **STALLS** (a correctness bug, not a UX preference). #57 + LLD 07 must verify per-phase re-arm as an integration check. See §7 and §9.4. |
| `src/shared/model.ts` (`CreateGameRequest`, `SerializableGame`) | Implemented | **§8.8 SCOPE EXPANSION** — add `deckRoundsTarget?` (mirrors `turnTimerSeconds` at line 17 / line 56). Note: a dead untyped `gameOptions` bag already exists at `model.ts:16` (sent by frontend, never read by backend) — §8.8 deliberately does NOT reuse it. |
| `src/backend/api/game/createGame.ts` | Implemented (`VALID_TIMER_VALUES`, lines 10/21–22) | **§8.8** — validate `deckRoundsTarget` range 5–12 mirroring the timer check. |
| `src/backend/database/entities/Game.ts` | Implemented (`turnTimerSeconds` column, line 11) | **§8.8** — add NEW persisted `deckRoundsTarget` column (no generic options column exists). |
| `src/backend/service/gameService.ts` (`startGame`, line 72; `options: {}` line 102) | Implemented | **§8.8** — pass persisted `deckRoundsTarget` into `config.options` instead of the hardcoded `{}`. |

**This LLD has no code dependencies — it is docs-only.** Downstream sub-issue #57 (engine) depends on this spec being **signed off** (§9). **The §8.8 creator-config plumbing (`deckRoundsTarget`) is a SCOPE EXPANSION beyond #57** — it spans the four rows above (API + DB + frontend) and is gated on §9.9; if the user keeps `deckRoundsTarget` an internal constant, those rows are not touched and only the engine default applies.

---

## 11. Test Requirements

> Tests are written in #57 (engine), not here. This section specifies **what** must be tested so the engine LLD/implementer have an unambiguous target. Per testing-principles: pure-function engine tests, controlled randomness (`FixedPRNG` / seeded), self-contained, invalid-action coverage, info-leakage, invariants, one full-game simulation.

### Unit — card values & hand value
- Ace=1, J/Q/K=10, 2–10=face, Joker=0; hand value = sum.

### Unit — deck build & cut (determinism + creator-configurable `deckRoundsTarget`)
- Same seed + trick + `deckRoundsTarget` → identical deck AND identical cut (determinism preserved across the configurable value).
- **Cut formula correctness:** for given `(players, numDecks, deckRoundsTarget)`, `cutAmount` matches `max(0, poolSize - clamp(handCardsDealt + deckRoundsTarget * players, [handCardsDealt + players, poolSize]))` (assert the §8.1 worked-example rows, including the 3-player default = 15 and 6-player default = 30).
- **Default `deckRoundsTarget = 8` DOES cut at ≤5 players:** with 3 players at the default (`targetCards = 39`, `cutAmount = 15`), a real cut occurs; assert the **card SET changes between tricks** (distinct subsets across tricks for distinct sub-seeds) — the "cards change every trick" behavior at low player count is the default (§9.9). A lower target (e.g. 5 → `cutAmount = 24`) cuts more.
- **High `deckRoundsTarget` yields NO cut at ≤5 players:** with a `deckRoundsTarget` high enough that `targetCards ≥ poolSize` (≥13 at 3 players), `cutAmount = 0`; assert the **card SET is identical across tricks** and only the draw ORDER varies by seed. Joker count = `2 * numDecks` = 2. (This is above the default — it is the explicit no-cut opt-in, not the default.)
- **6+ players → multi-deck cut:** `numDecks = ceil(players/5)` (6 → 2 decks); pool = `54 * numDecks` with `2 * numDecks` Jokers; cut down to `targetCards` honoring the formula and clamp; **different subset per trick** (assert distinct card sets across tricks for distinct sub-seeds); cut is reproducible and may remove Jokers.
- **Default applied when absent:** engine with no `config.options.deckRoundsTarget` uses 8.

### Unit / Integration — `deckRoundsTarget` validation (§8.8 plumbing; if the creator control ships)
- Out-of-range `deckRoundsTarget` (<5, >12, non-integer) is **rejected** at the API boundary (`createGame.ts`), mirroring the `turnTimerSeconds` reject behavior.
- In-range values (5–12) accepted; absent value defaults to 8.
- A persisted `deckRoundsTarget` survives `startGame` and reaches `initialize` via `config.options` (not the hardcoded `{}`).

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
- Multiple lost → joker-draw from a fresh pool of `numDecks` decks (`2 * numDecks` Jokers; deterministic via seed) picks TRUE LOSER; termination guaranteed even with multiple Jokers (more Jokers only ends the draw sooner).
- `winner` = lowest final tally (display/best-result only; ties → lowest seat index).

### Unit — stats derivation (multi-winner; §6.3)
- **Multiple winners:** in a game where several players finish <150, EACH of them gets `gamesWon: 1, gamesLost: 0`.
- **One or more losers:** every player ≥150 gets `gamesLost: 1, gamesWon: 0`.
- **TRUE LOSER is flavor only:** `breakdown.trueLoser` is set to 1 on exactly the TRUE LOSER and 0 on everyone else (including other losers); it does **not** change anyone's `gamesWon`/`gamesLost`.
- `totalScore` = final tally (penalty, lower is better).
- `state.winner` (lowest tally) is a display value and does **not** drive any of the above — derivation reads `scores[].score` (the tally) vs 150, not `winner`.

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
- Assert invariants hold every step, the match terminates (no infinite loop), and `winner`/`scores`/`trueLoser` are populated (with `winner` as the display lowest-tally value and `scores[].breakdown.lost`/`trueLoser` set). Assert the multi-winner stats derivation consumes the result correctly: every player <150 gets `gamesWon: 1, gamesLost: 0`, every player ≥150 gets `gamesLost: 1, gamesWon: 0`, derived from `scores[].score` vs 150 (not `winner`); `StatsService.recordGameCompletion` runs without error (per §6.3 mapping).
