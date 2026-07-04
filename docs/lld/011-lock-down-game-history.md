# LLD 011: Lock down `game_history` on prod (revoke stray writes + enable RLS) and unblock the drift gate

> **REBASELINE NOTE (2026-07-04).** This LLD was rewritten after two things landed
> that the original draft predates. Both are now RESOLVED and are treated as
> ground truth below:
>
> 1. **LLD 77b is MERGED** (`scripts/lib/linked-diff-adapter.mjs` on `main`). The
>    adapter now *classifies* `enable row level security` + `create policy` and
>    *self-attributes* them to a pending migration whose SQL declares them (even
>    inside a `DO $$` block, via a raw-text scan). **This is the big change:** the
>    draft's claim that "RLS never produces a diff object / needs no allowlist
>    entry" is WRONG. The correct statement is: RLS/policy statements DO appear in
>    the diff, but they *self-attribute to pending 011 and are dropped as benign*,
>    so they still need **no** `acknowledgedResidual` entry — for a different,
>    stronger reason. See §Approach "What 011 may assume from 77b" and Edge Case 8.
> 2. **A fresh post-010 prod capture is COMMITTED**
>    (`scripts/fixtures/captures/prod-db-diff-posto10.txt`,
>    `prod-migration-list-posto10.txt`, updated `captures/README.md`). It CONFIRMS
>    the previously-unverified premise: 010 is applied (`010 | 010 | 010`, nothing
>    pending) and the public-schema diff is exactly the six stray `game_history`
>    write grants + the cosmetic `increment_player_stats` re-emission. The six
>    grant object-ids below are derived directly from this capture.
>
> Everything tagged **VERIFIED** cites the committed capture or the merged adapter
> code. Everything tagged **ASSUMPTION** is called out inline. **Status: ready for
> design-review.**

## Scope

**Covers:** A single forward SQL migration `011` (plus its post-condition and the
drift-gate/allowlist/fixture choreography) that closes a real prod data-integrity
exposure on the `game_history` table (created by `010`) and, as a side effect,
lets the `prod-migrate` drift gate proceed:

1. **`supabase/migrations/011_lock_down_game_history.sql`** — `REVOKE INSERT,
   UPDATE, DELETE ON game_history FROM anon` **and** `FROM authenticated`
   (following the `008` idiom, extended to `authenticated`), then `ENABLE ROW
   LEVEL SECURITY` on `game_history` plus a SELECT-own-rows policy (`USING
   (auth.uid() = user_id)`) mirroring `player_stats` in `002`, inside a `DO $$`
   idempotency guard.
2. **`supabase/migrations/postconditions/011_lock_down_game_history.postcondition.sql`**
   — asserts RLS is ENABLED, a SELECT policy exists (shape-based, name-agnostic),
   and the grant set is now `anon`/`authenticated` SELECT-only (no write DML),
   `service_role` full.
3. **A backfill** of an RLS-enabled + SELECT-policy assertion into `010`'s
   post-condition, landing **in the same PR as `011`**, so this class cannot
   silently regress (cumulative-state reasoning; §010 post-condition hardening).
4. **The gate choreography** — the exact before/after state of
   `expected-diff.allowlist.json` and `scripts/fixtures/clean-diff.json` (plus the
   coupled tests) across the phases: (P0) reconcile `010`-applied out of
   `expectedPending`, add `011`, and acknowledge ONLY the six stray grants so the
   run that applies `011` passes both the offline and linked gate; (P1) `011` is
   applied by `db push`; (P2) a follow-up PR returns the allowlist/fixtures to a
   clean minimal state.

**Does NOT cover:**
- Any change to the drift-gate logic (`drift-gate.mjs`), the linked-diff adapter
  (`linked-diff-adapter.mjs` — **77b already did the RLS/policy widening this LLD
  now depends on**), or the `prod-migrate.yml` workflow structure. All used as-is.
- Any other table, RPC, or grant. `010`'s table shape, indexes, and
  `get_windowed_stats` are untouched. `games`/`player_stats`/`feedback` are
  already locked down by `002`/`008`.
- Application/backend code. Stat recording and windowed reads go through
  `service_role`, which bypasses RLS and retains full DML — zero app impact.
- Wiring or holding prod credentials. Applying `011` to prod is the existing
  human-owned `supabase db push` step in `prod-migrate.yml`.
- A rollback/`DROP POLICY` migration. RLS + revoke are strictly hardening; there
  is no functional path that needs them relaxed. (Also relevant to 77b: 77b only
  classifies `enable`/`create policy`, not `disable`/`drop policy`/`alter policy`.
  `011` emits only the two 77b-classified verbs — verified in §Interfaces — so it
  never trips 77b's deferred fail-closed branches.)

## Approach

### The two prod problems (both now VERIFIED against the committed post-010 capture)

The post-010 capture (`scripts/fixtures/captures/`, 2026-07-04) is the read-only,
`--schema public` snapshot of prod after the first prod-migrate run applied `010`:

- **`prod-migration-list-posto10.txt`** — `010 | 010 | 010`. **VERIFIED: `010` is
  APPLIED; nothing is pending.** (001–010 all show `Remote` populated.)
- **`prod-db-diff-posto10.txt`** — the public-schema content is exactly:
  the cosmetic `increment_player_stats` `CREATE OR REPLACE FUNCTION` re-emission
  (already acknowledged, issue `#91`), followed by **six** grant statements:
  ```
  grant delete on table "public"."game_history" to "anon";
  grant insert on table "public"."game_history" to "anon";
  grant update on table "public"."game_history" to "anon";
  grant delete on table "public"."game_history" to "authenticated";
  grant insert on table "public"."game_history" to "authenticated";
  grant update on table "public"."game_history" to "authenticated";
  ```
  **VERIFIED: no RLS/policy statements appear in the capture** — because prod has
  no RLS on `game_history` yet AND the applied migrations don't declare it either,
  so shadow and prod agree (the diff is silent on RLS until `011` is in-tree).

From these two facts, the two problems:

1. **Stray write grants.** `010` intended `anon`/`authenticated` to be SELECT-only
   (`010` lines "anon/authenticated SELECT-only"), but prod's `public` schema
   carries TypeORM-era `ALTER DEFAULT PRIVILEGES` that auto-grant INSERT/UPDATE/
   DELETE to `anon` **and** `authenticated` on every new `public` table. `010`
   never revoked them, so they are live on prod. This is the exact drift class
   `008`'s header documents — except `008` only revoked from `anon` on the three
   original tables; the capture proves `game_history` carries the stray grants on
   **both** `anon` and `authenticated`.
2. **No RLS.** Unlike `games`/`player_stats`/`feedback` (RLS enabled in `002`),
   `game_history` never got `ENABLE ROW LEVEL SECURITY` or a policy.

Together: a holder of the public anon key (shipped in the frontend) can INSERT/
UPDATE/DELETE `game_history` rows directly via PostgREST — forge or delete other
users' history, which feeds time-windowed stats (LLD 101). This is a **live
data-integrity exposure**, unlike the `008` case (where RLS was already blocking
anon writes and the REVOKE was pure defense-in-depth). Here RLS is **absent**, so
the grant is a genuinely open door and the fix is a security fix, not just
hygiene.

### Diff direction (why the grants are `direction:"add"`/residual and the REVOKE is the fix)

`db diff --linked` builds a shadow DB from the in-tree migrations and diffs
shadow → prod (adapter header lines 18–23; `captures/README.md`). Prod has
*extra* grants the migrations don't declare, so the diff emits `GRANT … TO anon`
statements → the adapter classifies each as `direction:"add"` (adapter line 333)
→ residual. `011`'s `REVOKE` removes exactly those extra grants on prod; once
applied, the diff is clean and the residual is gone.

### Key decisions

1. **Mirror the established idioms, do not invent.** The revoke half follows `008`
   verbatim (idempotent REVOKE, no-op on fresh DBs, SELECT left intact) — extended
   to the `authenticated` role because the capture shows both roles. The RLS half
   copies `002`'s `player_stats` pattern exactly: `ENABLE ROW LEVEL SECURITY` +
   one `FOR SELECT USING (auth.uid() = user_id)` policy, no write policies.
   `player_stats` is the correct analog: same `user_id`-scoped ownership, backend
   writes via `service_role`.

2. **Both hardening steps in one migration file `011`.** They are one logical
   concern ("lock down `game_history`") on one table in one prod-migrate run, and
   the gate must clear the grants (via ack) and accept RLS (via self-attribution)
   in the same run. Splitting into `011`+`012` would double the allowlist/fixture
   churn for no review benefit, and the two statements share failure/rollback
   semantics: if either fails the table is not locked down.

3. **RLS is defense-in-depth *on top of* the revoke, and both are needed.** The
   revoke removes the privilege surface (PostgREST anon/authenticated cannot
   write). RLS additionally guarantees that even a SELECT is row-scoped to the
   owner and that no future loosened grant silently reopens writes. `service_role`
   (backend) bypasses RLS and keeps `GRANT ALL` from `010`, so
   `increment_player_stats` / `get_windowed_stats` / history inserts are
   unaffected.

4. **Unqualified table name + catalog lookups** so the SQL resolves via
   `search_path`, letting the throwaway-schema fixture (`prodShapedFixture`) run
   the real `011` against an isolated schema (consistent with `002`/`008`/`010`).

5. **Idempotent + no-op on fresh DBs.**
   - `REVOKE` of an absent grant is a silent Postgres no-op — safe on fresh
     `supabase start` DBs.
   - `ALTER TABLE … ENABLE ROW LEVEL SECURITY` is idempotent.
   - `CREATE POLICY IF NOT EXISTS` does not exist in Postgres; use a guarded
     `DO $$ … IF NOT EXISTS (SELECT 1 FROM pg_policies …) THEN CREATE POLICY …
     END IF; $$`. This is a **hard requirement, not stylistic** — see decision 7,
     it is what makes 77b's raw-text scan the *only* thing that can attribute the
     policy.

6. **Name the policy explicitly, assert it shape-based.** Pick a stable policy
   name (e.g. `game_history_select_own`) for the `CREATE`/guard, but the
   post-condition asserts *a* SELECT policy with the owner predicate exists — it
   must not hardcode the name (the gate is grant/RLS/cmd-shape aware, not
   policy-name aware — 77b decision B). See §Post-condition.

7. **What 011 may now assume from 77b (the rebaseline crux — replaces the draft's
   Edge-Case-8 reasoning).** With 77b merged, on the run that applies `011`
   (`011` pending, `game_history` created by *applied* `010`):
   - `ALTER TABLE game_history ENABLE ROW LEVEL SECURITY` → `db diff` emits
     `enable row level security` → classifier returns `rls:public:game_history`,
     `direction:"drop"` (adapter lines 351–367; `direction:"drop"` = "prod is
     missing the shadow-declared state" = pending signature).
   - `CREATE POLICY game_history_select_own … FOR SELECT` (inside the `DO $$`
     guard) → `db diff` emits `create policy … for select` → classifier returns
     `policy:public:game_history:SELECT`, `direction:"drop"` (adapter lines
     369–393; name discarded — grammar B).
   - Both attribute to pending `011` in `pendingAttribution`'s dedicated
     `rls`/`policy` branch (adapter lines 694–702). Because `game_history` was
     created by *applied* `010`, it is **not** in `pending.tables`; attribution
     therefore comes via **`pending.rlsTables`** (adapter line 698), which is
     populated by a **raw-text regex scan** of `011`'s SQL string
     (`pendingDeclaredObjects`, adapter lines 579–605). **Critically, that scan
     reads *inside* `011`'s `DO $$ … END $$` block** — `splitDdlStatements` treats
     `$$` bodies as opaque (adapter lines 133–144), so a statement-level scan would
     miss the guarded `CREATE POLICY` and the policy would leak as unattributed
     residual. The raw-text scan (`createPolicyRe`, adapter line 582) is what makes
     the guarded policy visible for attribution. This is why decision 5's `DO $$`
     guard is safe under 77b.
   - Both are then **DROPPED AS BENIGN** in `adaptLinkedDiff` (the `direction ===
     "drop"` + attributed branch, adapter lines 781–797). They never reach the
     residual `objects` array.

   **NET (VERIFIED against the merged adapter):** `011`'s own `ENABLE RLS` and
   `CREATE POLICY` statements **self-attribute to pending 011 and require NO
   `acknowledgedResidual` entry.** Only the six stray `direction:"add"` grants are
   residual and need a transient acknowledgment. This is a *simplification* versus
   the draft (which reached "no allowlist entry" via the now-false premise that RLS
   produces no diff object at all).

## Interfaces / Types

No TypeScript, API, or engine types change. This is a DB-schema reconciliation.

### `supabase/migrations/011_lock_down_game_history.sql`

Header comment (in the `008`/`010` explanatory style: what drifted, why, why
idempotent/no-op-on-fresh, why RLS is defense-in-depth atop the revoke, that
`service_role` bypasses RLS so the app is unaffected, and a one-line pointer that
the RLS/policy statements self-attribute to pending 011 under LLD 77b), followed
by:

```sql
-- 1. Revoke the stray TypeORM-era write grants (present on prod for BOTH roles;
--    008 idiom, extended to `authenticated`). SELECT left intact (matches 010).
REVOKE INSERT, UPDATE, DELETE ON game_history FROM anon;
REVOKE INSERT, UPDATE, DELETE ON game_history FROM authenticated;

-- 2. Enable RLS + a SELECT-own-rows policy (mirrors player_stats in 002). No
--    write policies — the backend uses service_role, which bypasses RLS.
ALTER TABLE game_history ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'game_history'
      AND policyname = 'game_history_select_own'
  ) THEN
    CREATE POLICY game_history_select_own
      ON game_history FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;
```

Notes for the implementer (HARD CHECKS):
- **`current_schema()` vs literal `'public'` in the policy guard — resolve this
  deliberately.** Keep the table name **unqualified** (`game_history`) so the
  fixture's `SET search_path` isolates it. The `pg_policies` guard filters on
  `schemaname`; the throwaway fixture schema is **not** `public`. If the guard
  used the literal `'public'`, then in the fixture schema the `IF NOT EXISTS`
  subquery would find no matching row *regardless of whether the policy already
  exists in the fixture schema* → on a second run the guard would try to
  `CREATE POLICY` again and error on the duplicate. **Decision: use
  `current_schema()`** so the guard is correct on both prod (`public`) and the
  fixture schema. The implementer MUST verify against the local Supabase stack
  that (a) `pg_policies.schemaname` for a policy created in the throwaway schema
  equals `current_schema()` at run time, and (b) running `011` twice in the
  fixture schema is a clean no-op (Edge Case 3). If, contrary to expectation,
  `pg_policies` in the fixture reports a different schema than `current_schema()`,
  switch to `DROP POLICY IF EXISTS game_history_select_own ON game_history;
  CREATE POLICY …` (also idempotent, immune to the schema-name question) and note
  it — but `current_schema()` is the recommended first choice.
- Do **not** touch `service_role` grants (keep `010`'s `GRANT ALL`).
- Do **not** emit `disable row level security`, `drop policy`, or `alter policy`
  — 77b deliberately does NOT classify those (they hit its fail-closed F3 throw
  and would block the gate). `011` uses only `enable` + `create policy`, which
  77b classifies.

### `supabase/migrations/postconditions/011_lock_down_game_history.postcondition.sql`

Shape-based / name-agnostic (per the `010`/`002` post-condition style),
idempotent, read-only, resolves via `search_path`. A single `DO $$` block that
accumulates a `bad[]` array and `RAISE`s once. Asserts:

1. **RLS enabled** — `EXISTS (SELECT 1 FROM pg_class WHERE oid =
   to_regclass('game_history') AND relrowsecurity)` (the `002` post-condition
   pattern, verified above).
2. **A SELECT policy exists** — `EXISTS (SELECT 1 FROM pg_policies WHERE
   schemaname = current_schema() AND tablename = 'game_history' AND cmd =
   'SELECT')`. Assert by *shape* (a SELECT-command policy exists), **not** by the
   literal name (a future rename must not falsely fail, and this must not couple to
   a name the gate is blind to). Also assert the qualifier references `user_id`
   via `qual ILIKE '%user_id%'` — a light guard that it is the own-rows policy, not
   some unrelated SELECT policy (catches the Edge-Case-5 wrong-shape case).
3. **Grant set correct** — reuse `010`'s post-condition grant block verbatim (it
   is already exactly this assertion, verified above): `service_role` full
   (SELECT/INSERT/UPDATE/DELETE via `has_table_privilege`), `anon`/`authenticated`
   have SELECT and **not** INSERT/UPDATE/DELETE. Keeping it in `011` too means
   `011`'s post-condition fully describes the locked-down end state on its own.

A non-empty `bad[]` raises `POSTCONDITION FAILED (011): …`.

### `010` post-condition hardening (backfill — same PR as `011`)

Backfill an RLS-enabled + SELECT-policy assertion into
`postconditions/010_create_game_history.postcondition.sql`. Rationale:
- The reason this exposure shipped is precisely that `010`'s post-condition
  asserted the grant set but **not** RLS-enabled, so the missing RLS slipped
  through the gate.
- After `011` is applied, prod satisfies both `010`'s and `011`'s post-conditions;
  both run on every future prod-migrate and every `supabase start`. If `010`'s
  post-condition also asserts RLS, the class cannot regress even if `011` is ever
  reverted.
- **Cumulative-state sequencing caveat (must call out in the edited `010` header):**
  every post-condition runs against a DB where **all** migrations (including
  `011`) have been applied (the runner runs post-conditions after
  `db push`/`supabase start`). So adding an RLS assertion to `010`'s post-condition
  is only satisfiable once `011` exists and is applied. Therefore this backfill
  **must land in the same PR as `011`** (never before), and the `010`-postcondition
  edit is *not* asserting something `010` alone produces — it asserts the
  cumulative end state. Document this in the edited `010` post-condition header so
  a reader does not think `010` itself enables RLS.
- Alternative (rejected): leave `010`'s post-condition alone and rely solely on
  `011`'s. Weaker — if `011` is reverted, the regression is silent again. The
  backfill is one `EXISTS` check; cheap insurance.

## State Model

No application/game/in-memory state. Postgres catalog + role-grant metadata only.

- **Persisted (prod):** after `supabase db push` applies `011`, prod's
  `pg_class.relrowsecurity` for `game_history` is true, a `pg_policies` SELECT
  policy exists, and `relacl` no longer grants INSERT/UPDATE/DELETE to
  `anon`/`authenticated`.
- **Migration ordering:** `011` applies in filename order after `010`. On fresh
  DBs the REVOKE is a no-op and RLS/policy are freshly created; on prod it performs
  the one-time correction.
- **No data movement:** REVOKE, ENABLE RLS, and CREATE POLICY are metadata-only.
  Brief catalog lock on `game_history` (sub-millisecond).
- **Application impact:** none. Backend uses `service_role` (bypasses RLS, retains
  `GRANT ALL`). No frontend path reads/writes `game_history` with the
  anon/authenticated key (windowed stats are served by the backend via the
  `service_role`-only `get_windowed_stats` RPC).

## The gate choreography (the hard part)

The drift gate runs in `prod-migrate.yml` **before** `supabase db push` (gate →
push → verify). Two gate invocations matter and BOTH must pass on the `011` run:
- **Autonomous/CI (offline):** `verify-drift.mjs --diff-file
  scripts/fixtures/clean-diff.json` (`clean-diff.json` is the committed offline
  stand-in for live prod).
- **Human-owned (linked):** `verify-drift.mjs --linked` → `adaptLinkedDiff` reads
  live `db diff --linked` + `migration list --linked`.

Both feed the same pure `evaluateDriftGate` (verify-drift.mjs lines 138–146). Its
verdict (drift-gate.mjs):
- `residual = observed − expectedFromPending − acknowledgedResidual`; non-empty →
  FAIL.
- `expectedPending` entry not in `pending` → `staleExpected` → FAIL.
- `pending` entry not in `expectedPending` → `missingExpected` → FAIL.
- an `acknowledgedResidual` object NOT present in `observed` → `unusedAcknowledged`
  → FAIL (this guard runs in BOTH paths — it forces Phase-2 cleanup; see below).

Today, against post-`010`-applied prod, the gate FAILS on:
- **(a) residual:** the six `grant:{anon,authenticated}:game_history:{INSERT,
  UPDATE,DELETE}` objects (`direction:"add"`, unattributable to any pending
  migration → residual).
- **(b) staleExpected:** `010_create_game_history.sql` is still in the allowlist's
  `expectedPending` but is now applied to prod (migration list `Remote=010`).

`011` is what *removes* the grants, but it cannot be applied because the gate
blocks the very run that would apply it. And `010` must leave `expectedPending`.
The choreography resolves this with the minimum transient exception.

### What the adapter does with the `011` run's diff (VERIFIED against merged 77b)

For the `011` run — `011` pending, six stray grants still on prod, `game_history`
created by applied `010`:
- **`migration list --linked`** → `pending = ["011_lock_down_game_history.sql"]`
  (Remote blank for `011`; `010` now applied → not pending).
- **`db diff --linked`** emits, and the adapter classifies:
  - The six `grant … to anon/authenticated` → `direction:"add"` → **residual**
    (adapter line 806). Object ids (adapter `grant:<role>:<table>:<PRIV>`,
    uppercased priv, line 343): the set **G6** below.
  - `enable row level security` on `game_history` → `rls:public:game_history`,
    `direction:"drop"` → attributed to pending `011` via `pending.rlsTables` →
    **dropped as benign** (not residual). *(This is the 77b change; the draft's
    "RLS produces no diff object" claim was wrong — it produces one, but it is
    self-attributed and dropped.)*
  - `create policy … for select` (from inside `011`'s `DO $$` block) →
    `policy:public:game_history:SELECT`, `direction:"drop"` → attributed to `011`
    via `pending.rlsTables` (raw-text scan reads inside the `DO` block) →
    **dropped as benign**.
  - `increment_player_stats` `CREATE OR REPLACE` re-emission → `direction:"add"` →
    residual, already acknowledged (`#91`).

So the observed residual for the `011` run is exactly **G6 ∪
{`increment_player_stats`}** — RLS/policy are NOT in it. To pass, the choreography
must (i) reconcile `010` out of `expectedPending`, (ii) add `011` to
`expectedPending`, and (iii) subtract G6 via `acknowledgedResidual`. RLS/policy
need **nothing**.

**G6** (sorted, exactly as the adapter emits and the gate compares by string
equality):

```
grant:anon:game_history:DELETE
grant:anon:game_history:INSERT
grant:anon:game_history:UPDATE
grant:authenticated:game_history:DELETE
grant:authenticated:game_history:INSERT
grant:authenticated:game_history:UPDATE
```

### Fixture coupling (why `clean-diff.json` and tests move in lockstep)

The offline gate's `observed` is `clean-diff.json.objects`, its
`expectedFromPending` is `clean-diff.json.expectedFromPending`, and its
`actualPending` is `clean-diff.json.pending` (verify-drift.mjs lines 138–146).
`evaluateDriftGate` cross-checks `allowlist.expectedPending` against
`clean-diff.json.pending` (`staleExpected`/`missingExpected`). Therefore:
- **Every** change to `expectedPending` REQUIRES the matching change to
  `clean-diff.json.pending`, or the offline gate (and the coupled unit tests) go
  red — the documented PR #107 footgun.
- **Also** (subtle, and the reason `clean-diff.json.objects` must carry G6 in
  Phase 0): the offline gate evaluates `unusedAcknowledged` against
  `clean-diff.json.objects`. If Phase 0 acknowledged G6 but `clean-diff.json`
  did NOT list them in `objects`, the offline gate would fire `unusedAcknowledged`
  on all six and FAIL. So `clean-diff.json.objects` must mirror the linked
  `observed` (G6 present) for the acknowledgments to be "used". This is specified
  exactly below.

The coupled tests are in `tests/scripts/drift-gate.test.ts` — the
`"evaluateDriftGate — 010 game_history pending (LLD 101)"` describe block (lines
241–280) reads the real `clean-diff.json` + allowlist and asserts `010` is in both
`fixture.pending` and `expectedPending` (lines 261–264) and that the gate `passes
against the real fixture + allowlist as shipped` (line 266). These must be updated
to `011` in lockstep.

### Exact before/after states

#### Phase 0 — committed code that ships in the `011` PR (gate passes; `011` not yet applied)

This is the state on `main` at the moment the human dispatches the `prod-migrate`
run. Let `#NNN` = the tracking issue for the transient G6 acknowledgment (see
§Dependencies — the implementer creates it and substitutes the real number before
merge; **do not merge with the literal `#NNN` placeholder**).

`supabase/migrations/expected-diff.allowlist.json`:
```jsonc
{
  "$comment": "RECONCILED to the committed post-010 capture (scripts/fixtures/captures/prod-migration-list-posto10.txt): 010 is APPLIED to prod (Remote=010), so the pending migration is now 011_lock_down_game_history.sql. The six game_history stray write grants (G6) are the live TypeORM-era anon/authenticated INSERT/UPDATE/DELETE (direction:add residual, per prod-db-diff-posto10.txt) that 011 REVOKEs; acknowledged TRANSIENTLY (issue #NNN) ONLY so the run that applies 011 clears the gate. They MUST be removed in the Phase-2 cleanup PR once 011 is applied. 011's own ENABLE RLS + CREATE POLICY are NOT acknowledged here: under LLD 77b they self-attribute to pending 011 and are dropped as benign (they never appear as residual). increment_player_stats stays acknowledged (#91).",
  "expectedPending": ["011_lock_down_game_history.sql"],
  "acknowledgedResidual": [
    { "object": "function:public:increment_player_stats", "reason": "Cosmetic diff-engine re-emission noise (unchanged). See prod-db-diff-posto10.txt.", "issue": "#91" },
    { "object": "grant:anon:game_history:DELETE",          "reason": "Live TypeORM-era stray write grant on prod that 011 REVOKEs; transient, remove after 011 applies.", "issue": "#NNN" },
    { "object": "grant:anon:game_history:INSERT",          "reason": "Live TypeORM-era stray write grant on prod that 011 REVOKEs; transient, remove after 011 applies.", "issue": "#NNN" },
    { "object": "grant:anon:game_history:UPDATE",          "reason": "Live TypeORM-era stray write grant on prod that 011 REVOKEs; transient, remove after 011 applies.", "issue": "#NNN" },
    { "object": "grant:authenticated:game_history:DELETE", "reason": "Live TypeORM-era stray write grant on prod that 011 REVOKEs; transient, remove after 011 applies.", "issue": "#NNN" },
    { "object": "grant:authenticated:game_history:INSERT", "reason": "Live TypeORM-era stray write grant on prod that 011 REVOKEs; transient, remove after 011 applies.", "issue": "#NNN" },
    { "object": "grant:authenticated:game_history:UPDATE", "reason": "Live TypeORM-era stray write grant on prod that 011 REVOKEs; transient, remove after 011 applies.", "issue": "#NNN" }
  ]
}
```

`scripts/fixtures/clean-diff.json` (must mirror the linked reality the gate sees
for this run — so the acknowledgments are "used" and `pending` matches
`expectedPending`):
```jsonc
{
  "$comment": "Reconciled to post-010-applied prod (post-010 capture). pending is now 011 only (010 applied, Remote=010). objects mirrors the linked observed residual: the six game_history stray grants (G6, acknowledged #NNN) + increment_player_stats (#91). RLS/policy are NOT listed: under LLD 77b they self-attribute to pending 011 and are dropped by the adapter before residual, so the linked observed never contains them and neither must this offline stand-in. After 011 applies, Phase 2 removes G6 from BOTH files.",
  "objects": [
    { "object": "function:public:increment_player_stats" },
    { "object": "grant:anon:game_history:DELETE" },
    { "object": "grant:anon:game_history:INSERT" },
    { "object": "grant:anon:game_history:UPDATE" },
    { "object": "grant:authenticated:game_history:DELETE" },
    { "object": "grant:authenticated:game_history:INSERT" },
    { "object": "grant:authenticated:game_history:UPDATE" }
  ],
  "expectedFromPending": [],
  "pending": ["011_lock_down_game_history.sql"]
}
```

With this state, both gate paths pass:
- **offline (`--diff-file clean-diff.json`):** `observed = {increment_player_stats}
  ∪ G6`; `acknowledged = {increment_player_stats} ∪ G6`; `expectedFromPending = []`
  → residual = ∅. `pending = expectedPending = [011]` → no stale/missing. Every
  acknowledged id is in `observed` → no `unusedAcknowledged`. `ok:true`.
- **linked (`--linked`):** `observed` from `db diff` = G6 ∪ {increment_player_stats}
  (RLS/policy dropped as benign by 77b before residual); `pending` from migration
  list = `[011]`. Same subtraction → `ok:true`. Gate clears → `supabase db push`
  applies `011`.

Coupled test edits in the **same** Phase-0 PR (`tests/scripts/drift-gate.test.ts`):
rename the `010`-pending describe block (lines 241–280) to `011`; update its
assertions to `fixture.pending`/`expectedPending` containing
`011_lock_down_game_history.sql`; and keep `"passes against the real fixture +
allowlist as shipped"` green (it stays green because `evaluateDriftGate` subtracts
the acknowledged G6, so residual is ∅ and `ok` is true). Update the
`staleExpected` negative test to drop `011` (instead of `010`) from pending. See
§Test Requirements for the new focused G6 assertions.

> **Ordering hazard — `acknowledgedResidual` transiently carries G6 (beyond `#91`).**
> Adding G6 is a **deliberate, documented, issue-linked exception**, justified
> because: (1) it is the *only* way the fail-closed gate can pass the run that
> removes the very drift being acknowledged (chicken-and-egg the design must
> break); (2) each entry is individually reviewed, cites `#NNN`, and names its
> removal condition; (3) it is auditable and **self-expiring** — once `011` removes
> the grants from prod, `evaluateDriftGate`'s `unusedAcknowledged` guard flags the
> now-stale entries and FORCES their removal (Phase 2). **Acknowledging a grant
> does not grant it** — it only tells the gate "we know prod has this, `011` is
> about to remove it." The actual privilege is removed by `011`, not hidden by the
> allowlist.

#### Phase 1 — `011` applied to prod (during the same run)

`supabase db push` applies `011`. Prod now: RLS enabled, SELECT policy present,
`anon`/`authenticated` SELECT-only. The step-3 post-condition runner runs `011`'s
(and the hardened `010`'s) post-condition against prod → passes. **No file changes
in this phase**; it is the runtime effect of the Phase-0 commit + the human
`db push`.

#### Phase 2 — cleanup PR, committed after `011` is confirmed applied + verified

Once a subsequent `--linked` dry run (or the same run's post-condition pass)
confirms `011` is applied and the six grants are gone from prod, land a small
follow-up PR returning to the clean minimal state:

`supabase/migrations/expected-diff.allowlist.json`:
```jsonc
{
  "$comment": "011 applied to prod; the six game_history stray grants are gone (verified via --linked dry run / 011 post-condition). acknowledgedResidual back to the lone #91 cosmetic entry. expectedPending empty (no pending migrations).",
  "expectedPending": [],
  "acknowledgedResidual": [
    { "object": "function:public:increment_player_stats", "reason": "Cosmetic diff-engine re-emission noise (unchanged).", "issue": "#91" }
  ]
}
```

`scripts/fixtures/clean-diff.json`:
```jsonc
{
  "$comment": "011 applied; back to the clean baseline — lone residual is increment_player_stats (#91), nothing pending.",
  "objects": [{ "object": "function:public:increment_player_stats" }],
  "expectedFromPending": [],
  "pending": []
}
```

Coupled test edits: remove/replace the `011`-pending describe block (there is no
pending migration now); keep the generic residual/acknowledged unit tests. This
returns the repo to `expectedPending` empty, `acknowledgedResidual` = only the
long-standing `#91` entry, no `game_history` residual anywhere.

> **Why Phase 2 is not optional (VERIFIED, drift-gate.mjs lines 82–86):** if the
> six acknowledged entries are left after `011` is applied, they no longer match
> any observed drift → `unusedAcknowledged` is non-empty → the gate FAILS on the
> next run. The cleanup is *enforced by the gate itself*.

#### Cleaner ordering that avoids the transient ack? (considered, rejected)

- **A — "apply `011` first, then update the allowlist."** Impossible: the gate
  runs *before* push in the same job and blocks on G6.
- **B — "point `prod-migrate` at a diff-file that omits G6."** Worse: hides live
  drift silently instead of acknowledging it auditably, and edits the workflow.
- **C — "manually `REVOKE` the six grants on prod out-of-band, then run the gate
  (now clean), then push `011`."** Works and needs no ack, but splits the fix
  across an unaudited manual SQL step + a migration, defeating migration-as-record
  and risking prod/CI divergence again.

**The acknowledgedResidual route is recommended** — the entire fix is captured in
committed migrations + a reviewed, issue-linked, self-expiring allowlist
exception. Present all three to the reviewer; recommend the ack route.

### One-time human runs vs committed code

| Item | Kind |
|---|---|
| `011_lock_down_game_history.sql` | Committed code (Phase 0 PR) |
| `011_…postcondition.sql` + `010` post-condition RLS backfill | Committed code (Phase 0 PR) |
| Phase-0 `expected-diff.allowlist.json` + `clean-diff.json` + coupled test edits | Committed code (Phase 0 PR) |
| Tracking issue `#NNN` created + substituted for the placeholder | Done before merging Phase 0 |
| Dispatching `prod-migrate.yml` (gate → push `011` → verify) | One-time human run (needs prod secrets) |
| Confirming `011` applied (post-condition pass / `--linked` dry run shows G6 gone) | One-time human verification |
| Phase-2 cleanup (`expectedPending`→[], drop G6 acks, fixture + test edits) | Committed code (follow-up PR, after Phase 1) |

## Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | Fresh CI/local DB: `anon`/`authenticated` never had write grants | `REVOKE` of an absent grant is a silent no-op → safe. Verified by a fresh-baseline test. |
| 2 | Prod: both roles carry stray INSERT/UPDATE/DELETE | `REVOKE … FROM anon` and `… FROM authenticated` remove them (VERIFIED: capture shows both roles). Test seeds the grants on `game_history`, applies `011`, asserts `has_table_privilege(...)` false. |
| 3 | `011` re-run (idempotency) | REVOKE no-op; `ENABLE RLS` no-op; policy guard (`IF NOT EXISTS`, keyed on `current_schema()`) skips the `CREATE`. Test runs `011` twice, asserts stability (exactly one SELECT policy, RLS still on). **Depends on the `current_schema()` guard decision — see §Interfaces hard check.** |
| 4 | RLS already enabled (partial prior run) | `ENABLE ROW LEVEL SECURITY` is idempotent; policy guard prevents duplicate. No error. |
| 5 | Policy name collides with a pre-existing different policy | Guard checks by `policyname`; if a policy with that exact name exists the `CREATE` is skipped. Two *different* policies with the same name cannot coexist on one table, so this cannot silently mask a wrong policy — the post-condition asserts a SELECT policy with `qual ILIKE '%user_id%'` exists, catching a wrong-shaped one. |
| 6 | `service_role` grant accidentally affected | `011` never touches `service_role`. Post-condition asserts `service_role` retains full DML. |
| 7 | Backend/app relies on anon/authenticated writing `game_history` | None does: all writes go through `service_role`; windowed reads via the `service_role`-only `get_windowed_stats` RPC. Pre-merge grep confirms no anon-key `.insert/.update/.delete` on `game_history`. |
| 8 | **(REBASELINED)** How `011`'s RLS/policy statements are handled by the gate | Under merged **LLD 77b**: `db diff` DOES emit `enable row level security` + `create policy` for `game_history` on the `011` run; the adapter classifies them `direction:"drop"` and self-attributes them to pending `011` via `pending.rlsTables` (raw-text scan, reads inside the `DO $$` block) → **dropped as benign, never residual**. So they need **no** `acknowledgedResidual` entry. (Supersedes the draft's false claim that "RLS never produces a diff object.") VERIFIED against adapter lines 351–393, 579–605, 694–702, 781–797. |
| 9 | 77b's deferred verbs (`disable`/`drop policy`/`alter policy`) | `011` emits none of them (VERIFIED §Interfaces). If some future edit did, 77b's F3 fail-closed throw would block the gate — a signal, not a silent pass. Out of scope; do not add them to `011`. |
| 10 | Stale allowlist trap on `010`/`011` | Handled by fixture-coupling discipline: `expectedPending` and `clean-diff.json.pending` change together; coupled `drift-gate.test.ts` assertions updated in the same PR. |
| 11 | Phase-2 cleanup forgotten (G6 acks left after `011` applied) | `evaluateDriftGate.unusedAcknowledged` flags them → next gate run FAILS (VERIFIED drift-gate.mjs 82–86). Self-enforcing. |
| 12 | `010` post-condition RLS backfill landed *before* `011` exists | Would fail (prod has no RLS yet). Guard: the backfill lands in the SAME PR as `011` and asserts the cumulative (post-`011`) end state — never earlier. Documented in the `010` post-condition header. |

## Dependencies

- **LLD 77b (MERGED) — hard prerequisite.** `011` relies on 77b's RLS/policy
  classification + `pending.rlsTables` raw-text self-attribution
  (`scripts/lib/linked-diff-adapter.mjs` on `main`). Without it, `011`'s
  `ENABLE RLS` / `CREATE POLICY` would hit the adapter's F3 fail-closed throw and
  block the gate. 77b is on `main` (verified), so this is satisfied — noted so a
  reviewer confirms the dependency direction (011 → 77b, not the reverse).
- **Migration `010`** applied to prod first — VERIFIED (`prod-migration-list-posto10.txt`,
  `Remote=010`). `011` locks down the table `010` created.
- **`tests/integration/helpers/prodShapedFixture.ts`** — reused for `011`
  integration tests. Its `strayAnonWriteGrants` flag seeds grants on
  `games/player_stats/feedback` (via `baselineSql`), **not** on `game_history`
  (created by `010` inside the test). So the `011` prod-like test must (a) apply
  `010`, then (b) explicitly `GRANT INSERT, UPDATE, DELETE ON game_history TO anon,
  authenticated;` to reproduce the prod drift, then (c) apply `011` and assert. No
  fixture-helper change required; flagged so the implementer does not assume the
  flag covers `game_history`.
- **`scripts/verify-postconditions.mjs`** — enforces 1:1 migration↔post-condition
  coverage, so `011` MUST ship its post-condition file. No script change.
- **Drift gate + adapter + `prod-migrate.yml`** — used as-is; not modified.
- **Local Supabase stack** (`supabase start`, port 54322) for integration tests,
  per `DEVELOPMENT.md`.
- **Human `supabase db push`** applies `011` to prod (the existing gated workflow).
  No prod credentials in this LLD.
- **A tracking issue `#NNN`** for the transient G6 `acknowledgedResidual` entries
  and their Phase-2 removal. **The implementer must create this issue and
  substitute its real number for every `#NNN` placeholder before Phase 0 merges** —
  the literal `#NNN` must not ship. The issue body records: what G6 is, that it is
  removed by `011`, and that Phase 2 must delete the six entries + trim
  `clean-diff.json` once `011` is confirmed applied.

## Test Requirements

Follow the throwaway-schema pattern in `tests/integration/game-history.test.ts`
(`createProdShapedFixture`, `applyMigrations`, `runPostcondition`, `teardown` in
`finally`). Self-contained, no shared state (testing-principles §3), name-agnostic
assertions (shape/privilege, never a policy/constraint name).

### Integration — `011` migration (add to `tests/integration/game-history.test.ts` or a new `migration-011.test.ts`)

1. **prod-like: stray write grants revoked.** `baseline: "typeorm-era"`; apply
   `010`; then `GRANT INSERT, UPDATE, DELETE ON game_history TO anon,
   authenticated`; apply `011`; assert `has_table_privilege(role, 'game_history',
   priv)` is **false** for `{anon, authenticated} × {INSERT, UPDATE, DELETE}` and
   **true** for both roles' `SELECT`; `service_role` retains all four.
2. **RLS enabled + SELECT policy present.** After `011`: assert
   `pg_class.relrowsecurity` is true for `game_history`; assert a `pg_policies` row
   exists with `cmd = 'SELECT'` and `qual ILIKE '%user_id%'`; assert **no**
   INSERT/UPDATE/DELETE policy exists.
3. **fresh-like no-op + idempotent.** `baseline: "fresh"` (or `010` applied with no
   stray grants); apply `011` **twice**; assert no error, `SELECT` still true,
   write privs still false, RLS on, exactly one SELECT policy (count policies
   across the two runs to prove the `current_schema()` guard prevents re-create —
   directly exercises the §Interfaces hard check).
4. **`011` post-condition passes on the locked-down schema, RAISEs otherwise.**
   After `010`+`011`, `runPostcondition("011_lock_down_game_history.postcondition.sql")`
   resolves. In a variant where RLS is *not* enabled (apply `010` only, then run
   the `011` post-condition), assert it **rejects** (RAISE), proving the RLS
   assertion has teeth.
5. **hardened `010` post-condition.** After `010`+`011`,
   `runPostcondition("010_create_game_history.postcondition.sql")` passes (now
   includes the RLS assertion). In a `010`-only variant, assert the hardened `010`
   post-condition **rejects** (RLS absent) — proving the backfill closes the
   regression window.

### Unit — drift gate coupling (`tests/scripts/drift-gate.test.ts`)

6. **Phase-0 fixture + allowlist pass as shipped.** Update the existing
   `010`-pending describe block (lines 241–280) to `011`: assert `fixture.pending`
   and `allowlist.expectedPending` both contain `011_lock_down_game_history.sql`,
   and `gateWith(fixture.pending)` returns `ok:true` with G6 + `#91` all present in
   `fixture.objects` and all subtracted (residual ∅, no `unusedAcknowledged`).
7. **stale/missing coupling still enforced.** Keep the negative tests (drop `011`
   from `pending` → `staleExpected`; add an un-allowlisted pending →
   `missingExpected`), substituting `011` for `010`.
8. **acknowledgedResidual subtracts exactly G6.** A focused test: G6 in `observed`
   + G6 in `acknowledgedResidual` → residual ∅; removing one ack entry surfaces
   that one grant as residual (fail-closed); and an ack entry NOT present in
   observed is flagged `unusedAcknowledged` (guards the Phase-2 self-enforcement,
   Edge Case 11). *(No new adapter test is needed for RLS self-attribution — that
   is 77b's own test surface, already merged. This LLD's tests assert the gate-level
   choreography, not the adapter internals.)*

### Verification (manual, one-time — not automated)
- **Pre-merge grep** (Edge Case 7): confirm no anon/authenticated-key write path to
  `game_history`. Record in the PR.
- **Post-apply** (human, after `supabase db push` applies `011`): a `--linked` dry
  run shows the six `game_history` grants gone and the `011`/`010` post-conditions
  pass. This is the trigger to land the Phase-2 cleanup PR.

### Out of scope for tests
- No engine/unit game-logic tests (no game logic touched).
- No new `rls.test.ts` end-to-end anon-write test against a live server (the
  throwaway-schema privilege assertions cover the grant + RLS state directly).
- No adapter/classifier tests (77b owns those, merged).
