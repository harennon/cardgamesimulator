/**
 * Drift-detection gate logic (LLD 77 §5).
 *
 * Pure, credential-free diff-subtraction + fail-closed semantics. The CLI
 * (verify-drift.mjs) feeds this the structured output of
 * `supabase db diff --linked` and the live "pending migrations" set; this module
 * decides pass/fail. Kept pure so it is unit-tested against CAPTURED/FIXTURE
 * diffs with no prod access (LLD 77 §5.5). Wiring `--linked` to live prod and
 * storing the prod link secret is human-owned (§9).
 *
 * Model: a structured diff is a list of "diff objects", each with a stable
 * `object` identifier (e.g. "constraint:player_stats_pkey1",
 * "grant:anon:player_stats:INSERT"). The gate:
 *   1. observed  = the diff against linked prod.
 *   2. expected  = the diff objects attributable to applying expectedPending.
 *   3. residual  = observed − expected − acknowledgedResidual.
 *   4. residual non-empty  → FAIL (fail-closed; warn-only rejected, §5.4).
 *   5. allowlist stale (an expectedPending entry already applied, or a pending
 *      migration missing from expectedPending) → FAIL.
 */

/**
 * @typedef {{ object: string }} DiffObject
 * @typedef {{ object: string, reason: string, issue: string }} AcknowledgedResidual
 * @typedef {{ expectedPending: string[], acknowledgedResidual: AcknowledgedResidual[] }} Allowlist
 */

/**
 * @typedef {object} GateInput
 * @property {DiffObject[]} observed         Diff objects from `db diff --linked`.
 * @property {DiffObject[]} expectedFromPending  Diff objects produced by applying expectedPending.
 * @property {Allowlist} allowlist           The parsed expected-diff.allowlist.json.
 * @property {string[]} actualPending        Migration filenames actually pending against prod.
 */

/**
 * @typedef {object} GateResult
 * @property {boolean} ok                    True iff the gate passes.
 * @property {string[]} residual             observed − expected − acknowledged (object ids).
 * @property {string[]} staleExpected        expectedPending entries that are NOT actually pending.
 * @property {string[]} missingExpected      actually-pending migrations missing from expectedPending.
 * @property {string[]} unusedAcknowledged   acknowledgedResidual entries that matched nothing in observed.
 * @property {string[]} reasons              Human-readable failure reasons (empty iff ok).
 */

/** @param {DiffObject[]} list */
function objectIds(list) {
  return list.map((d) => d.object);
}

/**
 * Computes the gate verdict. Pure: no I/O, deterministic.
 * @param {GateInput} input
 * @returns {GateResult}
 */
export function evaluateDriftGate(input) {
  const observed = objectIds(input.observed);
  const expected = new Set(objectIds(input.expectedFromPending));
  const acknowledgedIds = new Set(
    input.allowlist.acknowledgedResidual.map((a) => a.object),
  );

  // residual = observed − expected − acknowledged
  const residual = observed
    .filter((id) => !expected.has(id))
    .filter((id) => !acknowledgedIds.has(id))
    .sort();

  // Stale-allowlist detection: keep the allowlist honest (§5.3 rule 5).
  const actualPendingSet = new Set(input.actualPending);
  const expectedPendingSet = new Set(input.allowlist.expectedPending);

  const staleExpected = input.allowlist.expectedPending
    .filter((f) => !actualPendingSet.has(f))
    .sort();
  const missingExpected = input.actualPending
    .filter((f) => !expectedPendingSet.has(f))
    .sort();

  // An acknowledgedResidual that suppresses nothing is dead weight — flag it so
  // the allowlist cannot accrete stale exceptions.
  const observedSet = new Set(observed);
  const unusedAcknowledged = input.allowlist.acknowledgedResidual
    .map((a) => a.object)
    .filter((id) => !observedSet.has(id))
    .sort();

  /** @type {string[]} */
  const reasons = [];
  if (residual.length > 0) {
    reasons.push(
      `Unexpected drift (residual): ${residual.join(", ")}. Clean it up (prefer #83) or add a reviewed, issue-linked acknowledgedResidual entry.`,
    );
  }
  if (staleExpected.length > 0) {
    reasons.push(
      `Stale expectedPending (already applied / not pending): ${staleExpected.join(", ")}. Remove from the allowlist.`,
    );
  }
  if (missingExpected.length > 0) {
    reasons.push(
      `Pending migration(s) missing from expectedPending: ${missingExpected.join(", ")}. Add them to the allowlist.`,
    );
  }
  if (unusedAcknowledged.length > 0) {
    reasons.push(
      `acknowledgedResidual entries that matched no observed drift: ${unusedAcknowledged.join(", ")}. Remove them.`,
    );
  }

  return {
    ok: reasons.length === 0,
    residual,
    staleExpected,
    missingExpected,
    unusedAcknowledged,
    reasons,
  };
}
