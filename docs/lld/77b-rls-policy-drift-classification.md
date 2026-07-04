# LLD 77b: Widen the linked-prod drift adapter to classify RLS + policy statements

## Scope

**Covers:** Extending `classifyStatement` (and its downstream attribution) in
`scripts/lib/linked-diff-adapter.mjs` so that the two Postgres Row-Level-Security
statements a pending RLS migration actually emits — `enable row level security`
and `create policy` — become first-class *classified* drift objects instead of
hitting the fail-closed F3 throw. Specifically:

1. **v1 statement recognition for exactly two shapes:** `enable row level
   security` and `create policy`. The three inverse/mutation verbs — `disable row
   level security`, `drop policy`, `alter policy` — are **deferred** and remain
   unrecognized (they keep hitting the existing fail-closed F3 throw, which is
   safe). See §v1 Scope for the rationale and the deferred-follow-up note.
2. A stable, deterministic **object-id grammar** for the two v1 objects
   (`rls:<schema>:<table>`, `policy:<schema>:<table>:<CMD>` — the name-agnostic
   decision is justified in §Approach).
3. **Direction semantics** for both v1 statements, worked out against the
   confirmed shadow→prod diff direction, so an RLS-adding *pending* migration's
   statements ATTRIBUTE to that migration (dropped as benign).
4. Extending `pendingAttribution` (and its `pendingDeclaredObjects` source) so
   RLS/policy objects attribute by their affected **table** name via a new
   `pending.rlsTables` set — see §State Model for the exact control flow (Gap 1)
   and the raw-text-scan requirement (Gap 2).
5. Preserving fail-closed on everything still unrecognized (including the three
   deferred verbs).
6. The fixture/test plan: repurpose the (now-classifiable) `unclassifiable`
   fixture, add RLS/policy fixtures, add pure-function assertions.

**Does NOT cover:**
- **`disable row level security`, `drop policy`, `alter policy`** — deferred to a
  documented follow-up (see §v1 Scope). They stay behind the F3 throw.
- Any change to `evaluateDriftGate` (`scripts/lib/drift-gate.mjs`) verdict logic.
  Objects are consumed by string equality exactly as today; this LLD only adds
  new object ids to the *producer*.
- Any change to `expectedFromPending` (the E1 seam stays E1 — see §State Model).
- Migration `011` itself. This LLD is a **prerequisite** for the (separately
  revised) LLD 011; §Coordination states precisely what 011 may now assume.
- Wiring `--linked` to prod, credentials, or the `prod-migrate.yml` workflow.
- Semantic dedupe of policies (two genuinely-different policies with the same
  (table, cmd) are not distinguished — out of scope, called out in §Edge Cases).

---

## v1 Scope (Gap 3 — deferred verbs)

**v1 ships ONLY the `enable row level security` and `create policy` recognizers.**
The inverse/mutation verbs `disable row level security`, `drop policy`, and
`alter policy` are **deliberately deferred** and remain unclassified, so they keep
hitting the existing fail-closed F3 throw (adapter line 346) → the gate blocks →
safe.

Rationale (design-review recommendation, aligned with CLAUDE.md §2 simplicity):
- The milestone driver, LLD 011, emits **only** `ENABLE ROW LEVEL SECURITY` and
  `CREATE POLICY` (verified against `docs/lld/011-lock-down-game-history.md`
  §Interfaces — 011 never disables RLS, drops a policy, or alters a policy). So
  the two v1 recognizers fully unblock 011.
- The three deferred verbs are exactly where the emission-form assumption is
  riskiest (a `DROP POLICY` carries no `FOR <cmd>` clause, so its id shape is
  genuinely ambiguous; `ALTER POLICY`'s direction is non-obvious). Deferring them
  eliminates the id-dedupe/masking risk entirely for this milestone and keeps the
  risky-assumption surface minimal.
- Because the deferred verbs stay behind the F3 throw, if prod ever produces a
  `disable`/`drop policy`/`alter policy` statement, the gate **fails closed and
  blocks** — it is never mis-classified or silently swallowed. That is the correct
  safe default until a real `--linked` capture exists to confirm their emission
  form and finalize their id shape.

**Documented follow-up (not this LLD):** once a real `--linked` capture containing
one of the deferred verbs exists, widen the recognizer to classify it. The
direction semantics are already worked out in §Approach (disable/drop-policy ⇒
`direction:"add"`/residual; alter-policy ⇒ residual) and can be lifted directly;
the open question is purely the id shape for `drop policy` (no cmd in the
statement) and the exact emission form. Residual ids for the deferred verbs may
safely embed the policy name (residuals are *surfaced*, not string-matched for
attribution), but that is out of scope here.

---

## Approach

### ⚠️ The single riskiest assumption, stated first (direction-inverting)

**ASSUMPTION (must confirm against a real `--linked` capture):** when prod is
MISSING RLS that the migrations declare, `db diff` surfaces it as an **`enable row
level security` statement on the prod side** (i.e. "to make prod match shadow,
enable RLS on prod") — NOT as a `disable row level security` on the shadow side.
The entire direction mapping below hinges on this: if the diff instead emitted
`disable` (shadow-side framing), the verb→direction table would invert and 011's
statements would be mis-mapped to `direction:"add"`/residual instead of
`direction:"drop"`/pending-attributable.

Why this is the assumed answer: the confirmed capture (`prod-db-diff.txt`) shows
`db diff` always emits the statement that **mutates prod toward the shadow**
(prod is missing the revokes → it emits `revoke ... from anon`, the operation
applied *to prod*). By the same framing, prod missing RLS ⇒ emit `enable ...`
(applied to prod). The existing `db-diff.unclassifiable.txt` fixture is literally
`alter table "public"."player_stats" enable row level security;`, consistent with
this framing. But this fixture predates a *pending-RLS* capture, so it is
corroborating, not conclusive.

**Fail-closed net (why a wrong answer here is safe, not catastrophic):** if the
real capture shows `disable` (or any other form) instead of `enable`, the v1
`enable`-only recognizer simply does not match it → the statement falls through to
the existing F3 throw (adapter line 346) → the gate **blocks** rather than
mis-classifying. So a wrong assumption degrades to "011 is blocked, reconcile the
recognizer against the real capture," never to "drift silently passes." This is
Edge Case 7. The `--linked` reconciliation step in §Test Requirements exists
precisely to confirm/refute this before 011 ships.

### Why this is needed (verified)

`classifyStatement` (adapter lines 243–349) recognizes exactly five shapes —
constraint, index, table, function, grant/revoke — plus a two-entry
preamble allowlist (`set check_function_bodies`, `set search_path`). Anything
else THROWS `LinkedDiffError` (fail-closed, F3, line 346). The repo proves RLS is
in the "anything else" bucket: `scripts/fixtures/linked/db-diff.unclassifiable.txt`
IS `alter table "public"."player_stats" enable row level security;`, and
`tests/scripts/linked-diff-adapter.test.ts` lines 126–132 assert exactly that
statement throws `LinkedDiffError`.

**Consequence (verified against migration `002_enable_rls.sql` + the confirmed
diff direction):** the moment a migration that adds RLS/policy to a table is
pending (prod does not have it yet), `supabase db diff --linked` will emit an
`enable row level security` / `create policy` statement to reconcile prod up to
the shadow. The adapter throws F3 → `verify-drift.mjs` `--linked` branch catches
`LinkedDiffError` and `exit(2)` (verify-drift.mjs lines 116–125) → the gate
blocks the run → the RLS migration can never be pushed. This blocks LLD 011 and
every future RLS migration.

The fix makes RLS drift *visible as a classified object* so it can be attributed
to a pending migration (dropped as benign) or acknowledged like any other object
type — exactly the machinery grants/tables/indexes already use.

### The direction crux (question 3) — reasoned against the confirmed capture

`db diff --linked` builds a shadow DB from the in-tree migrations and diffs
**shadow → prod**, emitting the statements that would make *prod* match the
*shadow* (adapter header lines 18–23; `scripts/fixtures/captures/README.md`
lines 11–13). VERIFIED by the real capture (`prod-db-diff.txt`): migration `010`
declares `game_history` SELECT-only, prod still carries TypeORM-era write grants,
and the diff emits `revoke ... from "anon"` (the statement that removes prod's
extra grant to match shadow). The adapter maps that `revoke` verb to
`direction: "drop"` (adapter line 328) meaning **prod is MISSING** the
shadow-declared state — the *pending-migration signature*.

Apply that same rule to RLS. When a migration enables RLS on a table but prod has
not applied it yet:
- The shadow (from migrations) HAS RLS enabled; prod does NOT.
- To make prod match shadow, the diff must emit **`enable row level security`**.
- By the confirmed rule, "prod is missing the shadow-declared state" ⇒
  **`direction: "drop"`** (pending-attributable), *even though the SQL verb is
  `enable`*. This is the counterintuitive-but-correct mapping: **direction is not
  the SQL verb; it is "which side is missing the object."** `enable` here means
  *prod-missing* = drop-semantics = attributable to the pending migration that
  introduces it.

- **`create policy`** (v1) emitted ⇒ shadow has a policy prod lacks ⇒ prod-missing
  ⇒ `direction: "drop"` (pending-attributable).

The two v1 verbs (`enable row level security`, `create policy`) are therefore both
`direction: "drop"` — the pending-migration signature.

**Deferred verbs (reasoning kept for the follow-up; NOT implemented in v1 — see
§v1 Scope).** For reference when the follow-up lifts them:
- **`disable row level security`** emitted ⇒ shadow has RLS *disabled* but prod
  has it *enabled* ⇒ prod-EXTRA ⇒ `direction: "add"` (residual).
- **`drop policy`** emitted ⇒ prod has a policy the migrations don't ⇒ prod-extra
  ⇒ `direction: "add"` (residual).
- **`alter policy`** emitted ⇒ prod's policy differs from shadow's ⇒ classify as
  `direction: "add"` (residual — surface for review, do not attribute).
In v1 all three stay unrecognized → F3 throw → gate blocks (safe).

This mapping makes the target outcome hold: an RLS-adding pending migration's
`enable`/`create policy` statements get `direction: "drop"` → run through
`pendingAttribution` → attributed to the pending migration by table → dropped as
benign (mirrors exactly how the game_history table/index/constraint drops
attribute to pending 010, adapter lines 679–701).

> **VERIFIED vs ASSUMPTION ledger (v1 verbs).**
> - **VERIFIED — lowercase/quoted form:** every line of `prod-db-diff.txt` is
>   lowercase and `"schema"."table"`-quoted; the `enable row level security` form
>   is literally the `db-diff.unclassifiable.txt` fixture.
> - **VERIFIED — authored SQL grammar:** `002_enable_rls.sql` establishes
>   `ALTER TABLE x ENABLE ROW LEVEL SECURITY;` and
>   `CREATE POLICY "name" ON x FOR SELECT USING (...)` as the forms the project
>   writes.
> - **ASSUMPTION (riskiest — must confirm against a real `--linked` capture that
>   includes a pending RLS migration):**
>   1. The direction-inverting prod-side-vs-shadow-side question — hoisted to the
>      top of §Approach because a wrong answer inverts the whole mapping. (Riskiest
>      of all.)
>   2. The *exact* `create policy` emission form — whether `db diff` quotes the
>      policy name, schema-qualifies the table, and preserves the `for select`
>      clause verbatim (`create policy "name" on "public"."game_history" for
>      select using (...)`), vs. re-emitting via some other shape.
> - The two v1 recognizer regexes are written to the assumed form; §Test
>   Requirements includes a reconciliation step against a real capture, and Edge
>   Case #7 is the fail-closed net if the real form differs (statement falls
>   through to F3 → gate blocks, never mis-classifies).
> - The `disable` / `drop policy` / `alter policy` emission form is **not assumed
>   here** — those verbs are deferred (§v1 Scope) and stay behind the F3 throw
>   until a real capture exists.

### The object-id grammar decision (question 2 — the hardest)

Object ids are matched by **string equality** in `evaluateDriftGate` for both
`expectedFromPending` and `acknowledgedResidual` (drift-gate.mjs lines 58–61,
82–86). So an id must be **stable and deterministic**: the same statement must
always produce the same id, or attribution/acknowledgment silently breaks.

**RLS enable → `rls:<schema>:<table>`.** RLS is a boolean table property; there is
exactly one RLS state per table, so `rls:public:game_history` is the natural,
collision-free, name-free id. No decision tension here. (v1 classifies only
`enable`; `disable` would reuse the same id shape when the deferred follow-up adds
it.)

**Policies — name-based vs shape-based (the load-bearing call).** A table can have
multiple policies, so the id must disambiguate them. Two candidate grammars:

- **(A) name-based:** `policy:<schema>:<table>:<policyname>`, e.g.
  `policy:public:game_history:game_history_select_own`.
- **(B) shape-based:** `policy:<schema>:<table>:<cmd>` (cmd = SELECT/INSERT/…),
  e.g. `policy:public:game_history:SELECT`, deliberately dropping the name.

**Recommendation: (B) shape-based, keyed by table + command, NOT the policy name.**

Rationale, grounded in this repo's history:
- The project's post-conditions are **deliberately name-agnostic** and match
  policies by `cmd` + `qual`, never by name, *because of TypeORM-era name drift*.
  This is documented in the draft LLD 011 §Post-condition (decision 6, line 54;
  post-condition assertion line 97: "assert by *shape* … not by the literal
  name") and in `002_enable_rls.sql` (policies carry human-readable display names
  like `"Users can view their own stats"` that a diff/rename could churn).
- If the id embedded the name (grammar A), then two **functionally identical**
  policies whose names differ (a prod policy named
  `"Users can view their own history"` vs. a migration policy named
  `game_history_select_own`, same `FOR SELECT USING (auth.uid() = user_id)`)
  would produce **two different ids**. The gate would see the prod one as an
  unexpected residual and the migration one as unattributed — reintroducing
  exactly the name-fragility the rest of the system was designed to avoid, and
  reopening the PR-#107-class churn where a rename reddens the gate.
- The gate's whole job here is "does prod's *effective security shape* match the
  migrations' *effective security shape*." Two SELECT policies with the same
  effect but different names ARE, for this gate's purpose, the **same object**.
  Grammar B encodes that: one id per (table, command).

**Cost of B, stated honestly:** collapsing to (table, cmd) means the gate cannot
distinguish two *genuinely different* SELECT policies on the same table (e.g. one
with `USING (auth.uid() = user_id)` and a second, broader
`USING (true)`). If a migration adds a second SELECT policy on a table that
already has one, both map to `policy:public:<table>:SELECT` and the second is
deduped away (adapter dedupe, lines 709–717) — the gate would not flag it. This
is an accepted limitation: (i) this project uses **one policy per (table, cmd)**
(002 has exactly one SELECT policy per table, one INSERT policy on feedback), so
the collision cannot arise with current usage; (ii) the failure mode is
*permissive* (a missed second policy), which is a known, documented gap, not a
silent *pass of unrelated drift*; (iii) the alternative (name-based) fails *more*
often and more confusingly (every rename). If per-(table,cmd) uniqueness ever
stops holding, revisit — but do not pre-build for it (CLAUDE.md §2 simplicity).

> **Alternative considered — (C) shape-hash id** `policy:<schema>:<table>:<hash of
> cmd+qual+withcheck>`: fully shape-based including the predicate, so two SELECT
> policies with different `USING` get different ids. **Rejected** because (a) the
> `db diff` output normalizes/reformats the `qual` expression (whitespace,
> casts, `auth.uid()` vs `auth.uid ()`) unpredictably, so a hash is *not* stable
> across the migration-authored form vs the diff-emitted form — it would violate
> the string-equality stability requirement, the very thing that must not break;
> (b) it embeds no human-readable meaning in the id, making allowlist entries
> unauditable. Grammar B is the stable, auditable, current-usage-correct choice.

**Determinism of B:** `cmd` is uppercased to a fixed token set
(`SELECT|INSERT|UPDATE|DELETE|ALL`) exactly as grants uppercase privileges
(adapter line 331), so casing/whitespace in the raw statement cannot perturb the
id. The schema defaults to `public` when the diff omits it (matching the
table/index rules, adapter lines 275, 293).

---

## Interfaces / Types

No exported signature changes. `classifyStatement(stmt: string):
ClassifiedObject[]` keeps its shape (adapter lines 213–226, 243). New object-id
forms are added to the `ClassifiedObject.object` JSDoc enumeration:

```
 * @property {string} object  stable id. Existing:
 *   constraint:<t>:<name>, grant:<role>:<t>:<PRIV>, table:<schema>:<name>,
 *   index:<schema>:<name>, function:<schema>:<name>.
 *   NEW (LLD 77b, v1):
 *     rls:<schema>:<table>              — ENABLE ROW LEVEL SECURITY
 *     policy:<schema>:<table>:<CMD>     — CREATE POLICY (CMD in
 *                                         SELECT|INSERT|UPDATE|DELETE|ALL)
```

`ClassifiedObject.table` is populated for both new kinds (the RLS/policy's target
table). **Both new kinds are `direction:"drop"` and attribute via a NEW dedicated
control-flow branch in `pendingAttribution` — NOT the existing
`pending.tables`-only branch.** The existing first branch
(`if (obj.table && pending.tables.has(obj.table))`, adapter line 601) is
insufficient for the milestone: in the 011 scenario the RLS target table
`game_history` is created by *applied* migration 010, so it is NOT in
`pending.tables`, and the existing branch would fail to attribute → 011's RLS
would surface as residual. The exact control flow (which set is consulted, in what
precedence, and which `byName` wins) is specified in §State Model (Gap 1) and the
`pending.rlsTables` raw-text derivation in §State Model (Gap 2). This §Interfaces
section defers to §State Model for attribution; there is no "no-change" path.

### New recognizer patterns (v1 — two branches, added to `classifyStatement`
before the final throw)

Written against the VERIFIED lowercase/quoted form; `?:` groups keep the existing
`ID` helper (`"([^"]+)"`, adapter line 102). Whitespace-robust via `\\s+`.
**v1 adds exactly these two branches; `disable`, `drop policy`, and `alter policy`
are NOT added (they keep hitting the final F3 throw — §v1 Scope).**

1. **RLS enable** — one branch:
   ```
   ^alter\s+table\s+(?:only\s+)?(?:"<schema>"\.)?"<table>"\s+
     enable\s+row\s+level\s+security$
   ```
   - groups: `[schema?, table]`
   - `object = rls:<schema||public>:<table>`, `table = <table>`
   - `direction`: `"drop"` (prod-missing/pending signature — see §Approach
     direction crux). The branch is anchored to `enable ... security$`; a
     `disable ... security` statement does NOT match this branch → falls through to
     F3 (deferred, safe).

2. **create policy** — one branch. Policy name is captured **but discarded from the
   id** (grammar B); the `FOR <cmd>` clause is captured for the id, and defaults to
   `ALL` when the statement omits `FOR` (Postgres default):
   ```
   ^create\s+policy\s+(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s+on\s+
     (?:"<schema>"\.)?"<table>"(?:\s+for\s+(select|insert|update|delete|all))?
   ```
   - `cmd = (captured for-clause || "ALL").toUpperCase()`
   - `object = policy:<schema||public>:<table>:<CMD>`, `table = <table>`
   - `direction`: `"drop"` (prod-missing/pending). The branch is anchored to
     `^create policy`; `drop policy` / `alter policy` do NOT match → F3 (deferred).

Each branch returns a **single** `ClassifiedObject` in an array (mirroring the
table/index/function branches). RLS/policy statements never fan out per-privilege
the way grants do.

---

## State Model

Pure, I/O-free — no persistence, no in-memory game state (this is build-time gate
logic). Data flow of a new object through the adapter:

1. `splitDdlStatements` (unchanged) splits raw stdout into statements. **VERIFIED
   no change needed:** RLS/policy statements are terminated by a top-level `;`
   and contain no dollar-quoted bodies, so the existing splitter handles them.
   (Policy `USING (...)` predicates contain parens and possibly single-quoted
   literals; the splitter already respects single-quoted strings, lines 165–184,
   and parens are irrelevant to `;`-splitting.)
2. `classifyStatement` (EXTENDED) returns the new `ClassifiedObject`(s) instead of
   throwing.
3. `adaptLinkedDiff` (UNCHANGED routing) routes by `direction`. Both v1 kinds are
   `direction:"drop"` → `pendingAttribution(obj, pendingObjects, allTables)`. The
   attribution control flow for RLS/policy is specified unambiguously below
   (Gap 1). `direction:"add"` never occurs for v1 (deferred verbs are the only
   `add`-direction RLS/policy statements).
4. Dedupe by id (lines 709–717) — RLS/policy ids participate normally.
5. `buildExpectedFromPending` stays **E1** (returns `[]`, lines 474–476):
   pending-attributable RLS/policy statements are dropped in step 3 before they
   can become residual, so nothing needs subtracting via `expectedFromPending`.
   No change to the E1/E2 seam.

### Gap 1 — the unambiguous `pendingAttribution` control flow for RLS/policy

`pendingAttribution(obj, pending, allTables)` (adapter lines 600–620) is extended
with a **single dedicated branch for `kind === "rls" || kind === "policy"`**,
evaluated by object kind. RLS/policy objects are routed to this new branch and do
**NOT** fall through the generic first branch ambiguously. Exact control flow:

```
kind = obj.object.split(":")[0]            // "rls" | "policy" | (existing kinds)

if (kind === "rls" || kind === "policy"):
    // obj.table is always set for these kinds (the RLS/policy target table).
    // Attribute iff the target table is affected by a PENDING migration —
    // either because a pending migration CREATEs it, OR because a pending
    // migration adds RLS/policy DDL to it. Union of the two sets:
    if (pending.tables.has(obj.table)):
        declFile = pending.byName.get(obj.table)
    else if (pending.rlsTables.has(obj.table)):
        declFile = pending.rlsByName.get(obj.table)
    else:
        return null                        // unattributed → residual
    return declFile

// existing kinds (table/constraint/grant/function/index) — UNCHANGED, below.
```

Precedence and byName-winner (explicit, per Gap 1):
- **`pending.tables` is consulted FIRST, `pending.rlsTables` SECOND.** If a single
  pending migration both CREATEs a table AND adds RLS to it (the common
  same-migration case), the `pending.tables` (CREATE-TABLE) `byName` entry wins.
  This is intentional: attribution to the migration that *created* the table is
  the more specific/authoritative fact, and in the same-migration case both point
  at the same file anyway, so the choice is only observable in the rare
  cross-migration case (below), where either answer is a valid pending file.
- The existing kinds (`table`/`constraint`/`grant`/`function`/`index`) keep their
  current branches **verbatim** (lines 601–619). RLS/policy never reach them
  because the new branch returns first for those kinds. This is the "route RLS/
  policy through ONE branch, not the generic first branch ambiguously" requirement.
- Gap-A cross-consistency is preserved unchanged: `declFile` is a pending file
  (both `byName` maps are built only from pending migrations), so the
  `pendingSet.has(declFile)` assert in `adaptLinkedDiff` (line 688) still holds and
  still guards against mis-attribution.

> **Note on `obj.table` for `kind === "rls"`.** The `rls:<schema>:<table>` id has
> the table in position 2 (`split(":")[2]`), and `classifyStatement` also sets
> `obj.table` directly, so the branch reads `obj.table` (already set) rather than
> re-parsing the id. Same for `policy:<schema>:<table>:<CMD>` (table at position 2,
> also mirrored in `obj.table`).

### Gap 2 — `pending.rlsTables` MUST be a RAW-TEXT regex scan (the DO-block trap)

`pending.rlsTables` is derived by a **raw-text regex scan over each pending
migration's SQL string**, mirroring the existing `tableRe` / `functionRe` scans in
`pendingDeclaredObjects` (adapter lines 507–510) — it is **NOT** derived from
`splitDdlStatements` / `classifyStatement` output. This is mandatory, not stylistic:

- 011's `CREATE POLICY` is wrapped in a `DO $$ ... END $$;` guard block (verified
  against `docs/lld/011-lock-down-game-history.md` §Interfaces, the idempotency
  guard). `splitDdlStatements` **deliberately treats `$$...$$` bodies as opaque**
  (adapter lines 133–144) — it does not look inside them. So a statement-level
  scan would never see 011's `CREATE POLICY`, `game_history` would be absent from
  `pending.rlsTables`, and 011's policy would surface as **unattributed residual**
  → the entire coordination guarantee silently breaks.
- A **raw-text regex over the whole SQL string** matches inside `DO` blocks (the
  block body is just text to a regex), so it catches the guarded `CREATE POLICY`.

Add to `pendingDeclaredObjects` (which already receives `{file, sql}` per pending
migration), two new raw-text regexes (global, `lastIndex`-reset, same idiom as
`tableRe`), each adding the captured table to `pending.rlsTables` and recording
`pending.rlsByName.set(table, file)` on first sight:

```
enableRlsRe = /\balter\s+table\s+(?:only\s+)?(?:"?[A-Za-z0-9_]+"?\.)?
               "?([A-Za-z0-9_]+)"?\s+enable\s+row\s+level\s+security/gi
createPolicyRe = /\bcreate\s+policy\s+(?:"[^"]+"|[A-Za-z0-9_]+)\s+on\s+
                  (?:"?[A-Za-z0-9_]+"?\.)?"?([A-Za-z0-9_]+)"?/gi
```

Notes:
- These scan the **migration-authored** SQL (unquoted or quoted table names, the
  `002`/`011` grammar), NOT the diff output — so they tolerate the authored forms
  (`ALTER TABLE game_history ENABLE ROW LEVEL SECURITY`, `CREATE POLICY name ON
  game_history ...`) including inside `DO` blocks.
- `pending.rlsTables` is derived **ONLY from pending migrations** (same loop as
  `tables`/`functions`, lines 512–524), so it cannot broaden attribution for any
  other object kind or any applied migration.
- `PendingObjects` gains `rlsTables: Set<string>` and `rlsByName: Map<string,
  string>` (parallel to `tables`/`byName`). `allDeclaredTables` (lines 535–546) is
  unaffected — RLS does not create tables.

**Accepted cross-migration behavior (documented, per Gap 2).** If pending migration
A enables RLS on table T and a *different* pending migration B adds a policy on T,
then both `rls:public:T` (from A's diff statement) and `policy:public:T:<CMD>`
(from B's diff statement) attribute via `pending.rlsTables.has(T)` and are dropped
as benign. `rlsByName.get(T)` points at whichever pending migration first
mentioned T in the scan order (sorted by filename), so `rls:public:T` and
`policy:public:T:<CMD>` may attribute to *different* pending files — **this is
correct and benign**: both files are in the pending set (Gap-A holds), both
statements are legitimately introduced by pending migrations, and the gate only
cares that each statement attributes to *a* pending migration, not to a specific
one. Test case (b) in §Test Requirements asserts this A-enables/B-policies case
drops both as benign.

**What is persisted:** nothing by this adapter. The classified ids flow into
`expected-diff.allowlist.json` / `scripts/fixtures/clean-diff.json` only when a
human/LLD chooses to acknowledge a *residual* (prod-extra) RLS/policy object —
which, in v1, only the deferred verbs could produce (and they throw instead).

---

## Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | `enable row level security` on a pending-created *or* pending-RLS'd table | `direction:"drop"` → `pendingAttribution` new branch consults `pending.tables` then `pending.rlsTables` → attributed → dropped as benign. (Makes 011 self-attribute; see §Coordination and §State Model Gap 1.) |
| 2 | `enable row level security` on a table NOT touched by any pending migration (neither created nor RLS'd by a pending migration) | `direction:"drop"`, unattributed (in neither set) → **residual** `rls:<schema>:<table>`. Correct: prod is missing RLS an already-applied migration should have created (real drift, not swallowed). |
| 3 | `create policy` on a pending-RLS'd table (011's guarded `CREATE POLICY` inside a `DO $$` block) | `direction:"drop"` → attributed via `pending.rlsTables` (populated by the raw-text scan that reads *inside* `DO` blocks — §State Model Gap 2) → dropped. |
| 4 | `create policy` on a table NOT touched by any pending migration | `direction:"drop"`, unattributed → residual `policy:<schema>:<table>:<CMD>` (real drift). |
| 5 | **DEFERRED verb** `disable row level security` emitted | Not recognized in v1 → falls through to F3 throw → gate blocks (safe). Follow-up will classify as `direction:"add"`/residual. |
| 6 | **DEFERRED verbs** `drop policy` / `alter policy` emitted | Not recognized in v1 → F3 throw → gate blocks (safe). Follow-up will classify as `direction:"add"`/residual (id shape TBD against a real capture — `DROP POLICY` carries no `FOR <cmd>`). |
| 7 | The real `--linked` `enable`/`create policy` form differs from the assumed regex (e.g. unquoted table, missing `for` clause, different word order) | The regex does not match → falls through to the **existing** F3 throw (line 346). **Fail-closed is preserved** — an unanticipated form blocks the gate rather than being mis-classified. This is the intended net for the flagged emission-form assumption; the fix is to widen the regex against the real capture, not to broaden into a catch-all. |
| 8 | A genuinely-unrelated statement (e.g. `create trigger`, `comment on`, `alter sequence`) | Still THROWS F3. The two v1 branches match only `... enable row level security` and `create policy ... on ...` — anchored (`^`) and specific, not catch-alls. Enumerated non-matches in §Fail-Closed below. |
| 9 | Two different-named but functionally-identical SELECT policies (prod vs migration) | Both map to `policy:<schema>:<table>:SELECT` (grammar B) → same id → the gate treats them as the same object (intended; §Approach). Name drift does not redden the gate. |
| 10 | Two genuinely-different SELECT policies on one table (same cmd, different `USING`) | Collapse to one id; the second is deduped. Accepted permissive limitation (§Approach cost of B). Cannot arise with current one-policy-per-(table,cmd) usage. |
| 11 | RLS `enable` statement with the `only` keyword (`alter table only "x" enable ...`) | The v1 RLS branch includes optional `(?:only\s+)?` (mirrors the constraint branch, adapter line 252). Handled. |
| 12 | Whitespace/case variance (`ENABLE  ROW   LEVEL SECURITY`, mixed case) | Regexes use `\s+` between words and the `i` flag; cmd tokens are uppercased. Deterministic id regardless of input spacing/case. |

### Fail-closed preservation (question 5) — what STILL throws

The whole point of the adapter is fail-closed on the unknown. After the v1
widening, `classifyStatement` still throws `LinkedDiffError` (F3) on **everything
except** its now-seven recognized shapes (constraint, index, table, function,
grant/revoke, **RLS enable**, **create policy**) plus the two-entry preamble
allowlist. Note the three deferred verbs (`disable`, `drop policy`, `alter policy`)
are explicitly among what still throws. Enumerated statements that MUST still throw
(add as explicit "still-throws" assertions in the tests):
- **`disable row level security`** (deferred verb) → throws in v1.
- **`drop policy ... on ...`** / **`alter policy ... on ...`** (deferred verbs) →
  throw in v1.
- `create trigger ... on "public"."x"` / `drop trigger`
- `comment on table/column ...`
- `alter sequence ...` / `create sequence ...`
- `create type ...` / `alter type ...`
- `alter table ... add column ...` / `... alter column ...` (column DDL — NOT the
  RLS/constraint forms; the RLS branch is anchored to `enable row level security`
  at end-of-statement, so `alter table ... alter column` does not match it, and the
  constraint branch requires `add|drop constraint`).
- `grant ... on schema ...` / `grant ... on function ...` (the grant branch is
  `on [table] <table>`; a schema/function grant does not match `ID` as a table —
  confirm it still throws rather than mis-binding).
- A bare `create policy` with no `on <table>` (malformed) → no match → throw.

The two v1 branches are **anchored and specific** (`^alter table ... enable row
level security$`, `^create policy ... on ...`). Neither uses a trailing `.*` that
could swallow an unrelated statement, and each is anchored to its exact verb so the
deferred inverse verbs (`disable`/`drop`/`alter`) do not accidentally match. This
is the explicit guard against "widening RLS accidentally broadened into a
catch-all."

---

## Dependencies

- `scripts/lib/linked-diff-adapter.mjs` — the file extended (classifier +
  `pendingDeclaredObjects` + `pendingAttribution`). No other production file
  changes.
- `scripts/lib/drift-gate.mjs` — consumed **unchanged** (string-equality match).
- `tests/scripts/linked-diff-adapter.test.ts` — the F3-throws-on-RLS test
  (lines 126–132) MUST change (RLS is now classified, not thrown). New assertions
  added.
- `scripts/fixtures/linked/db-diff.unclassifiable.txt` — MUST be **repurposed** to
  a genuinely-unclassifiable statement (it currently IS the RLS statement, which
  is now classified). See §Test Requirements.
- **A real `supabase db diff --linked` capture that includes a pending RLS
  migration** — used to CONFIRM (not gate) the v1 `enable` / `create policy`
  emission form and the direction-inverting prod-side-vs-shadow-side assumption
  (§Approach). v1 does **not** block on this capture: the two recognizers are
  backed by `002` + the existing fixture, and any real-form mismatch degrades to a
  fail-closed F3 block (Edge Case 7), never a mis-classification. The three
  deferred verbs (`disable`/`drop policy`/`alter policy`) stay behind the F3 throw
  until such a capture exists (§v1 Scope) — they are the follow-up, not this LLD.
- **No dependency on LLD 011** — 011 depends on *this*, not the reverse.

---

## Coordination note — what LLD 011 may now assume

The draft `docs/lld/011-lock-down-game-history.md` currently assumes RLS produces
**no** diff object (its §"Adapter classification of 011's REVOKEs" RLS bullet,
Edge Case 8, and the claim at line 136 that "RLS never produces a residual object
and needs no allowlist entry"). **This LLD invalidates that assumption** and
replaces it with a stronger, cleaner guarantee:

After 77b ships, for the 011 run (011 pending, `game_history` table already
created by applied 010):
- 011's `ALTER TABLE game_history ENABLE ROW LEVEL SECURITY` → diff emits
  `enable row level security` → `direction:"drop"` → attributed to pending 011
  via the new `pending.rlsTables` set (011's SQL contains the enable/policy DDL) →
  **dropped as benign**. No residual, no acknowledgment needed.
- 011's `CREATE POLICY game_history_select_own ... FOR SELECT` — authored **inside
  a `DO $$ ... END $$;` idempotency guard** — → diff emits `create policy` →
  `direction:"drop"` → attributed to 011 via `pending.rlsTables`. Critically,
  `pending.rlsTables` is built by a **raw-text regex scan** (§State Model Gap 2),
  which reads *inside* the `DO` block; a statement-level scan would miss the guarded
  policy (the splitter treats `$$` bodies as opaque) and 011's policy would leak as
  residual. → **dropped as benign**. No acknowledgment needed.
- The **six stray add-grants** (`grant:{anon,authenticated}:game_history:{INSERT,
  UPDATE,DELETE}`) are `direction:"add"` (prod-extra) → still surface as residual
  → still handled by 011's `acknowledgedResidual` choreography, **unchanged**.

**Therefore 011's choreography can now assume:** 011's own RLS `enable` and
`create policy` statements self-attribute to pending 011 and require **no**
`acknowledgedResidual` entry — only the six stray add-grants do. 011 should:
1. Delete its Edge Case 8 / RLS-produces-no-object reasoning and replace it with a
   one-line reference to LLD 77b (RLS now self-attributes to pending 011).
2. Keep its six-grant acknowledgment choreography exactly as designed.
3. Add 77b to its Dependencies as a prerequisite that must merge first.

This is a *simplification* for 011 (its RLS statements are now handled by the
same benign-attribution path as its table/grant drops), not a new burden.

---

## Test Requirements

Pure-function, credential-free, mirroring the existing patterns in
`tests/scripts/linked-diff-adapter.test.ts` (self-contained, no shared state —
testing-principles §3; synthetic inline migrations like the existing index
attribution tests, lines 364–439).

Scoped to **v1** (enable + create policy). Tests for the deferred verbs assert
they THROW (not that they classify).

### Unit — `classifyStatement` (the v1 grammar + direction)

1. **RLS enable → `rls:<schema>:<table>` with `direction:"drop"`**, from the
   verified form `alter table "public"."game_history" enable row level security`.
2. **create policy → `policy:<schema>:<table>:SELECT` with `direction:"drop"`**,
   from `create policy "game_history_select_own" on "public"."game_history" for
   select using (...)`. Assert the id **does not contain the policy name**
   (grammar B guard).
3. **create policy with no `FOR` clause → `...:ALL`** (Postgres default).
4. **`only` keyword + whitespace/case variance** still classify to the same id.
5. **Deferred verbs THROW (F3) — the v1 fail-closed guarantee.** Assert each of
   `alter table "public"."x" disable row level security`,
   `drop policy "p" on "public"."x"`, and
   `alter policy "p" on "public"."x"` throws `LinkedDiffError`. (Proves v1 does
   NOT classify them and they stay behind the fail-closed net — §v1 Scope.)
6. **Still-throws (F3) — the rest of the preserved fail-closed set.** Replace the
   current RLS-throws test (lines 126–132) with throws for genuinely-unrecognized
   statements: `create trigger ... on "public"."game_history"`,
   `comment on table "public"."game_history" is 'x'`, `alter sequence ...`. Assert
   each throws `LinkedDiffError`. (The enumerated §Fail-Closed set.)

### Unit — `pendingDeclaredObjects` (the `pending.rlsTables` raw-text scan)

7. **Bare RLS/policy on an already-created table.** A synthetic pending migration
   whose SQL is `ALTER TABLE game_history ENABLE ROW LEVEL SECURITY; CREATE POLICY
   p ON game_history FOR SELECT USING (...);` (but **no** `CREATE TABLE
   game_history`) yields `rlsTables` containing `game_history` and
   `rlsByName.get("game_history")` pointing at that file.
8. **(a) DO-BLOCK-guarded `CREATE POLICY` — the single most important test.** A
   synthetic pending migration whose SQL mirrors 011's EXACT shape: `ALTER TABLE
   game_history ENABLE ROW LEVEL SECURITY;` followed by a `DO $$ BEGIN IF NOT
   EXISTS (...) THEN CREATE POLICY game_history_select_own ON game_history FOR
   SELECT USING (auth.uid() = user_id); END IF; END $$;` guard block. Assert
   `rlsTables` contains `game_history`. This EXERCISES THE RAW-TEXT-SCAN PATH that
   test 7 (bare statement) does NOT — it proves the scan reads *inside* the `DO`
   block. **If this test would pass with a statement-level scan, the scan is wrong
   (Gap 2).**

### Integration — `adaptLinkedDiff` (attribution end-to-end)

9. **011-scenario self-attribution (the coordination guarantee).** Inline
   migrations: `010` creates `game_history` (marked applied in a synthetic
   migration-list); a pending `011` whose SQL enables RLS + creates the SELECT
   policy on `game_history` **inside a `DO $$` block** (011's real shape). Feed a
   `db diff` stdout containing `enable row level security` + `create policy ... for
   select` on `"public"."game_history"`. Assert the adapted `objects` (residual)
   contains **neither** `rls:public:game_history` **nor**
   `policy:public:game_history:SELECT` (both attributed to pending 011 and
   dropped). Direct test that 011 needs no RLS acknowledgment.
10. **(b) Cross-migration A-enables / B-policies (accepted behavior, §State Model
    Gap 2).** Two pending migrations: A (`ALTER TABLE t ENABLE ROW LEVEL
    SECURITY;`) and B (`CREATE POLICY p ON t FOR SELECT USING (...);`), both
    pending, on the same table `t` (created by an applied migration). Feed a `db
    diff` emitting both `enable row level security` and `create policy ... for
    select` on `"public"."t"`. Assert **both** `rls:public:t` and
    `policy:public:t:SELECT` are dropped as benign (adapted `objects` contains
    neither) — each attributes via `pending.rlsTables` to *a* pending migration
    even though they came from different files.
11. **Unattributed enable surfaces as residual.** `enable row level security` on a
    table that is neither pending-created nor pending-RLS'd (e.g. an applied
    table with no pending RLS) → residual `rls:public:<table>` (Edge Case #2) —
    proves the drop-direction attribution does not over-swallow.
12. **Unattributed create policy surfaces as residual** (Edge Case #4) — mirror of
    test 11 for the policy id.
13. **End-to-end through `evaluateDriftGate`** (mirror lines 445–492): the
    011-scenario adapted result + the (011-phase) allowlist that acknowledges only
    the six grants → `evaluateDriftGate` returns `ok:true` with the RLS/policy
    objects absent from residual. (May live in 011's own test suite; include at
    least adapter-level assertions 9–12 here.)

### Fixtures to add / change (`scripts/fixtures/linked/`)

- **REPURPOSE** `db-diff.unclassifiable.txt`: replace its RLS content with a
  genuinely-unclassifiable statement (recommend
  `create trigger set_updated_at before update on "public"."player_stats" for each
  row execute function moddatetime();` — a real Postgres form the classifier does
  not and should not recognize). The existing F3 test (test file lines 287–297)
  keeps passing against the new content. Update
  `scripts/fixtures/linked/README.md` line 30 accordingly. (A deferred RLS verb —
  e.g. `disable row level security` — would ALSO be a valid unclassifiable fixture
  in v1, but a non-RLS statement is preferred so the fixture's intent survives the
  eventual deferred-verb follow-up.)
- **ADD** `db-diff.rls-pending-attributed.txt`: `enable row level security` +
  `create policy ... for select` on `"public"."game_history"` (used by test 9).
- **ADD** `db-diff.rls-residual.txt`: `enable row level security` +
  `create policy ...` on a table that no pending migration touches (used by tests
  11–12) — the unattributed-drop-surfaces-as-residual case. (NOT `disable` — that
  is a deferred verb and would throw in v1.)
- Do **not** add RLS to the REAL captures — see §Blast Radius.

### Blast radius / backward-compat (question 7)

- **VERIFIED: the real prod capture is unaffected.** `prod-db-diff.txt` and
  `db-diff.pending-010.txt` contain **no** RLS or policy statements (confirmed by
  reading both — the game_history cluster is table/index/constraint/grant/function
  only; migration 002's RLS is already applied to prod so it produces no diff).
  The new branches never fire on those fixtures, so every existing adapter test
  (`adaptLinkedDiff — REAL pending-010 capture`, the sentinel, the fail-closed
  paths, index-attribution) produces **identical** output. Re-run the suite to
  confirm zero deltas on the untouched fixtures.
- **VERIFIED: `clean-diff.json` needs NO change.** It is a pre-structured diff
  (`objects/expectedFromPending/pending`), not raw stdout — it never flows through
  `classifyStatement`. It contains no RLS ids and is consumed by
  `evaluateDriftGate` unchanged. `drifted-diff.json` likewise (structured, no RLS).
- **The only behavioral change** is: statements the adapter previously threw F3 on
  (RLS/policy) are now classified. No previously-classified statement changes id
  or direction. No existing fixture's verdict changes.
- **The one test that MUST change** is the RLS-throws-F3 unit test (lines 126–132)
  — by design, since the behavior it asserts is exactly what we are fixing.
