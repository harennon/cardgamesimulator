export const meta = {
  name: "ship-batch",
  description:
    "Triage all open issues, select 2-3 to ship, execute sequentially",
  whenToUse:
    "When you want to autonomously triage the backlog and ship a batch of issues end-to-end.",
  phases: [
    { title: "Triage", detail: "Assess all untriaged open issues in parallel" },
    {
      title: "Label",
      detail: "Apply triage labels and post comments on close/needs-info",
    },
    {
      title: "Select",
      detail: "CEO picks 2-3 issues from triage:fix pool",
      model: "opus",
    },
    { title: "Ship", detail: "Execute ship-issue sequentially for each pick" },
  ],
};

// --- Schemas ---

const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    issueNumber: { type: "integer" },
    issueTitle: { type: "string" },
    realProblem: {
      type: "boolean",
      description: "Is this actually broken or actually needed?",
    },
    effort: {
      type: "string",
      enum: ["small", "medium", "large"],
      description: "small: <1hr focused work, medium: 1-4hrs, large: half-day+",
    },
    risks: {
      type: "object",
      properties: {
        availability: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Could this cause downtime?",
        },
        scaling: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Performance impact at load?",
        },
        operations: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Adds monitoring/maintenance burden?",
        },
        customerExperience: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Could regress UX?",
        },
        backwardsCompat: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Breaks existing clients/APIs?",
        },
        security: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "New attack surface?",
        },
        dataIntegrity: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Could corrupt/lose state?",
        },
        reversibility: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "How hard to roll back? (high = hard to reverse)",
        },
        blastRadius: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Touches shared/foundational code?",
        },
        gameCorrectness: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Could alter game rules/fairness?",
        },
        testability: {
          type: "string",
          enum: ["low", "medium", "high"],
          description:
            "How hard to verify? (high = hard to test automatically)",
        },
      },
      required: [
        "availability",
        "scaling",
        "operations",
        "customerExperience",
        "backwardsCompat",
        "security",
        "dataIntegrity",
        "reversibility",
        "blastRadius",
        "gameCorrectness",
        "testability",
      ],
    },
    recommendation: {
      type: "string",
      enum: ["fix", "defer", "close", "needs-info"],
    },
    reasoning: {
      type: "string",
      description: "2-3 sentences justifying the recommendation",
    },
  },
  required: [
    "issueNumber",
    "issueTitle",
    "realProblem",
    "effort",
    "risks",
    "recommendation",
    "reasoning",
  ],
};

const FETCH_SCHEMA = {
  type: "object",
  properties: {
    needsTriage: {
      type: "array",
      items: {
        type: "object",
        properties: {
          number: { type: "integer" },
          title: { type: "string" },
        },
        required: ["number", "title"],
      },
      description: "Issues that need (re-)triage",
    },
    labelsToRemove: {
      type: "array",
      items: {
        type: "object",
        properties: {
          number: { type: "integer" },
          label: { type: "string" },
        },
        required: ["number", "label"],
      },
      description:
        "Issues whose old triage label should be removed before re-triaging",
    },
  },
  required: ["needsTriage", "labelsToRemove"],
};

const SELECTION_SCHEMA = {
  type: "object",
  properties: {
    selected: {
      type: "array",
      items: { type: "integer" },
      description: "Issue numbers to ship, ordered by priority (1-3 items)",
    },
    demote: {
      type: "array",
      items: { type: "integer" },
      description:
        "Issue numbers to re-label from triage:fix to triage:defer (stale/low-priority)",
    },
    reasoning: {
      type: "string",
      description:
        "Why these issues, in what order, and what was deferred/rejected",
    },
  },
  required: ["selected", "reasoning"],
};

// --- Helpers ---

const MAX_PARALLEL_TRIAGE = 15;
const DEFER_STALENESS_DAYS = 7;

// --- Workflow ---

phase("Triage");

// Step 1: Fetch and classify issues (structured output, no side effects)
const fetchResult = await agent(
  `Identify all open GitHub issues that need triage (new or re-triage).

Step 1 — Fetch all open issues:
  gh issue list --state open --json number,title,labels,updatedAt --limit 50

Step 2 — Fetch open PRs to exclude in-progress issues:
  gh pr list --json number,headRefName --state open

Step 3 — Classify each issue:
  A) NEEDS TRIAGE (add to needsTriage):
     - No label starting with "triage:" (never triaged)
     - Has "triage:needs-info" BUT updatedAt is more than 24 hours after the issue was last labeled (info was likely provided)
     - Has "triage:defer" AND updatedAt is more than ${DEFER_STALENESS_DAYS} days ago (stale defer — reassess)
     - Has "triage:close" BUT updatedAt is more recent than when the label was likely applied (pushback received)

  B) SKIP (exclude):
     - Has "triage:fix" label (handled by selection phase)
     - Has any triage label with no re-triage trigger met
     - Has an open PR whose branch name contains the issue number (already being shipped)

For items in category A that have an existing triage label, add them to labelsToRemove with the exact label string (e.g. "triage:defer").

Do NOT run any gh issue edit commands. Only read and classify.`,
  { label: "fetch-issues", schema: FETCH_SCHEMA },
);

if (!fetchResult) {
  log("Fetch agent failed. Stopping.");
  return { status: "failed", phase: "fetch-issues" };
}

// Step 2: Remove old labels for re-triage issues (parallel — independent operations)
if (fetchResult.labelsToRemove && fetchResult.labelsToRemove.length > 0) {
  await parallel(
    fetchResult.labelsToRemove.map(
      (item) => () =>
        agent(
          `Remove the label "${item.label}" from issue #${item.number}:
gh issue edit ${item.number} --remove-label "${item.label}"`,
          { label: `unlabel-retriage-${item.number}` },
        ),
    ),
  );
  log(
    `Removed stale labels from ${fetchResult.labelsToRemove.length} issues for re-triage`,
  );
}

const issuesToTriage = fetchResult.needsTriage || [];

if (issuesToTriage.length === 0) {
  log("No untriaged issues found.");

  // Check if there are triage:fix issues waiting for selection
  const existingPoolAgent = await agent(
    `Run: gh issue list --state open --label "triage:fix" --json number,title --limit 20
Return the result as plain JSON text.`,
    { label: "check-fix-pool" },
  );

  let existingPool;
  try {
    existingPool =
      typeof existingPoolAgent === "string"
        ? JSON.parse(existingPoolAgent)
        : existingPoolAgent;
  } catch {
    existingPool = [];
  }

  if (!Array.isArray(existingPool) || existingPool.length === 0) {
    log("No triage:fix issues in pool either. Fully idle.");
    return { status: "idle", message: "No issues to triage or ship" };
  }

  log(
    `Skipping triage — ${existingPool.length} issues already in triage:fix pool`,
  );
}

// Triage in parallel (capped to avoid excessive fan-out)
let triageResults = [];
if (issuesToTriage.length > 0) {
  const batch = issuesToTriage.slice(0, MAX_PARALLEL_TRIAGE);
  if (issuesToTriage.length > MAX_PARALLEL_TRIAGE) {
    log(
      `Capping triage to ${MAX_PARALLEL_TRIAGE} issues (${issuesToTriage.length} total — remainder triaged next run)`,
    );
  }

  triageResults = await parallel(
    batch.map(
      (issue) => () =>
        agent(
          `Triage GitHub issue #${issue.number}: "${issue.title}"

1. Read the issue: gh issue view ${issue.number}
2. Read relevant source files to understand the scope (use grep/find to locate related code)
3. Read docs/architecture-principles.md, docs/execution-plan.md, and docs/customer-experience.md for context
4. Assess:
   - Is this a real problem that needs fixing, or is it stale/invalid/duplicate?
   - How much effort to fix? (small: <1hr, medium: 1-4hrs, large: half-day+)
   - Rate each risk dimension (low/medium/high)
   - Recommend: fix, defer, close, or needs-info

Be honest and critical. Not every issue is worth fixing. Consider whether the issue is still relevant given current project state.`,
          {
            label: `triage-${issue.number}`,
            schema: TRIAGE_SCHEMA,
          },
        ),
    ),
  );
}

// Identify failed triages (agent returned null) — these issues remain unlabeled for next run
const validResults = triageResults.filter(Boolean);
const failedCount = triageResults.length - validResults.length;
if (failedCount > 0) {
  log(
    `${failedCount} triage agent(s) failed — those issues remain unlabeled and will be retried next run`,
  );
}

// Phase 2: Apply labels and comments (parallel — each issue is independent)
phase("Label");

if (validResults.length > 0) {
  await parallel(
    validResults.map((result) => () => {
      const label = `triage:${result.recommendation}`;

      if (result.recommendation === "close") {
        return agent(
          `For issue #${result.issueNumber}:
1. First, check if a comment already exists containing "Triage recommendation: close" — if so, skip commenting:
   gh issue view ${result.issueNumber} --json comments --jq '.comments[].body' | grep -q "Triage recommendation: close" && echo "ALREADY_COMMENTED"
2. Add the label "triage:close": gh issue edit ${result.issueNumber} --add-label "triage:close"
3. If NOT already commented, post a comment using a heredoc to avoid shell escaping issues:
   gh issue comment ${result.issueNumber} --body "$(cat <<'TRIAGEEOF'
**Triage recommendation: close**

${result.reasoning}

_This is an automated triage recommendation. A human should review before closing._
TRIAGEEOF
)"

Do NOT close the issue — only label and comment (if not already commented).`,
          { label: `label-${result.issueNumber}`, phase: "Label" },
        );
      } else if (result.recommendation === "needs-info") {
        return agent(
          `For issue #${result.issueNumber}:
1. First, check if a comment already exists containing "Triage: needs more information" — if so, skip commenting:
   gh issue view ${result.issueNumber} --json comments --jq '.comments[].body' | grep -q "Triage: needs more information" && echo "ALREADY_COMMENTED"
2. Add the label "triage:needs-info": gh issue edit ${result.issueNumber} --add-label "triage:needs-info"
3. If NOT already commented, post a comment using a heredoc:
   gh issue comment ${result.issueNumber} --body "$(cat <<'TRIAGEEOF'
**Triage: needs more information**

${result.reasoning}

_Please provide additional context so this issue can be prioritized._
TRIAGEEOF
)"`,
          { label: `label-${result.issueNumber}`, phase: "Label" },
        );
      } else {
        return agent(
          `Add the label "${label}" to issue #${result.issueNumber}:
gh issue edit ${result.issueNumber} --add-label "${label}"`,
          { label: `label-${result.issueNumber}`, phase: "Label" },
        );
      }
    }),
  );
}

log(
  `Labeled ${validResults.length} issues: ${validResults.map((r) => `#${r.issueNumber}→${r.recommendation}`).join(", ")}`,
);

// Phase 3: CEO selects from triage:fix pool
phase("Select");

// Gather full triage:fix pool (includes pre-existing + newly labeled)
const poolAgent = await agent(
  `Run: gh issue list --state open --label "triage:fix" --json number,title,body --limit 20

For each issue, also fetch a brief summary by running: gh issue view <number> --json title,body --jq '.body[:200]'

Return a JSON array of {number, title, summary} objects where summary is the first 200 chars of the body.
Return as plain JSON text.`,
  { label: "fetch-fix-pool" },
);

let fixPool;
try {
  fixPool = typeof poolAgent === "string" ? JSON.parse(poolAgent) : poolAgent;
} catch {
  log("Failed to parse fix pool");
  return { status: "failed", phase: "select" };
}

if (!Array.isArray(fixPool) || fixPool.length === 0) {
  log("No triage:fix issues — checking deferred pool for promotion");

  // Fallback: ask CEO to re-evaluate deferred issues when fix pool is empty
  const deferredAgent = await agent(
    `The triage:fix pool is empty — nothing to ship. Check if any deferred issues should be promoted.

Run: gh issue list --state open --label "triage:defer" --json number,title,body --limit 20

For each issue, also get a brief summary:
  gh issue view <number> --json title,body --jq '.body[:200]'

Return a JSON array of {number, title, summary} objects. If no deferred issues exist, return an empty array.`,
    { label: "fetch-deferred-pool" },
  );

  let deferredPool;
  try {
    deferredPool =
      typeof deferredAgent === "string"
        ? JSON.parse(deferredAgent)
        : deferredAgent;
  } catch {
    log("Warning: failed to parse deferred pool response — treating as empty");
    deferredPool = [];
  }

  if (!Array.isArray(deferredPool) || deferredPool.length === 0) {
    log("No deferred issues either. Fully idle.");
    return {
      status: "triaged-only",
      message:
        "Triage complete but no issues recommended for fixing and no deferred items to promote",
      triageResults: validResults,
    };
  }

  // CEO decides if any deferred items are now worth fixing
  const promotion = await agent(
    `The triage:fix pool is empty — nothing was deemed ready to ship.

However, there are ${deferredPool.length} deferred issues. Re-evaluate whether any should be promoted to fix now.

## Deferred issues
${deferredPool.map((i) => `- #${i.number}: ${i.title} — ${i.summary || "(read with gh issue view)"}`).join("\n")}

Read docs/execution-plan.md and docs/project-hld.md for current strategic context.
For any issue where the summary above is insufficient, read it: gh issue view <number>

## Consider
- Has the project state changed such that a previously-deferred item is now unblocked?
- Is anything here small enough to ship as a quick win despite being deferred?
- Would shipping any of these move the product forward meaningfully?

If yes, select 1-3 to promote and ship. Return their issue numbers.
If nothing is worth promoting, return an empty selected array with reasoning.`,
    {
      label: "ceo-promote-deferred",
      model: "opus",
      agentType: "ceo",
      schema: SELECTION_SCHEMA,
    },
  );

  if (!promotion || !promotion.selected || promotion.selected.length === 0) {
    log(
      `CEO declined to promote any deferred issues: ${promotion ? promotion.reasoning : "agent failed"}`,
    );
    return {
      status: "no-selection",
      message: "Fix pool empty and CEO declined to promote deferred items",
      reasoning: promotion ? promotion.reasoning : null,
      triageResults: validResults,
    };
  }

  // Promote selected issues: relabel from defer to fix
  for (const issueNumber of promotion.selected) {
    await agent(
      `Promote issue #${issueNumber} from triage:defer to triage:fix:
1. gh issue edit ${issueNumber} --remove-label "triage:defer"
2. gh issue edit ${issueNumber} --add-label "triage:fix"`,
      { label: `promote-${issueNumber}` },
    );
  }

  log(
    `CEO promoted ${promotion.selected.length} deferred issues to fix: ${promotion.selected.map((n) => `#${n}`).join(", ")} — ${promotion.reasoning}`,
  );

  // Skip normal CEO selection — the promotion IS the selection
  // Jump directly to Ship phase with promoted issues
  log(
    `CEO selected (via promotion): ${promotion.selected.map((n) => `#${n}`).join(", ")} — ${promotion.reasoning}`,
  );

  phase("Ship");

  const results = [];
  for (const issueNumber of promotion.selected) {
    const issueCheck = await agent(
      `Check if issue #${issueNumber} is still open:
gh issue view ${issueNumber} --json state --jq '.state'
Return ONLY the state string (e.g. "OPEN" or "CLOSED").`,
      { label: `check-open-${issueNumber}` },
    );

    if (
      issueCheck &&
      typeof issueCheck === "string" &&
      issueCheck.toUpperCase().includes("CLOSED")
    ) {
      log(`#${issueNumber} is already closed — skipping`);
      await agent(
        `Remove triage:fix label from closed issue #${issueNumber}:
gh issue edit ${issueNumber} --remove-label "triage:fix"`,
        { label: `unlabel-closed-${issueNumber}` },
      );
      results.push({ issueNumber, status: "skipped-closed" });
      continue;
    }

    log(`Shipping issue #${issueNumber}...`);
    const result = await workflow("ship-issue", issueNumber);
    results.push({ issueNumber, ...(result || { status: "agent-failed" }) });

    if (result && result.status === "success") {
      log(`#${issueNumber} shipped: ${result.prUrl}`);
      await agent(
        `Remove the triage:fix label from issue #${issueNumber}:
gh issue edit ${issueNumber} --remove-label "triage:fix"`,
        { label: `unlabel-${issueNumber}` },
      );
    } else if (result && result.status === "awaiting-frontend-decision") {
      log(
        `#${issueNumber} paused: awaiting frontend decision (branch: ${result.branchName}).`,
      );
      await agent(
        `Issue #${issueNumber} is awaiting a frontend design decision. Re-label it:
1. gh issue edit ${issueNumber} --remove-label "triage:fix"
2. gh issue edit ${issueNumber} --add-label "triage:defer"`,
        { label: `defer-awaiting-${issueNumber}` },
      );
    } else {
      const failPhase = result ? result.phase || result.status : "unknown";
      log(`#${issueNumber} stopped at: ${failPhase}`);
    }
  }

  return {
    status: "complete",
    selection: promotion.selected,
    reasoning: promotion.reasoning,
    source: "promoted-from-defer",
    results,
  };
}

// Build triage context for CEO — include both current-run results and pool summaries
const currentRunContext = validResults
  .filter((r) => r.recommendation === "fix")
  .map(
    (r) =>
      `#${r.issueNumber} "${r.issueTitle}" | effort: ${r.effort} | risks: ${
        Object.entries(r.risks)
          .filter(([, v]) => v !== "low")
          .map(([k, v]) => `${k}:${v}`)
          .join(", ") || "all low"
      } | ${r.reasoning}`,
  )
  .join("\n");

const currentRunNumbers = new Set(
  validResults
    .filter((r) => r.recommendation === "fix")
    .map((r) => r.issueNumber),
);

const priorPoolContext = fixPool
  .filter((i) => !currentRunNumbers.has(i.number))
  .map(
    (i) =>
      `#${i.number} "${i.title}" | ${i.summary || "(no summary — read with gh issue view)"}`,
  )
  .join("\n");

const selection = await agent(
  `You are selecting which issues to ship in this batch.

## Available issues (triage:fix pool)
${fixPool.map((i) => `- #${i.number}: ${i.title}`).join("\n")}

## Triage assessments (current run)
${currentRunContext || "(No new issues triaged this run)"}

## Prior pool issues (triaged in earlier runs)
${priorPoolContext || "(None — all pool issues were triaged this run)"}

For any prior pool issue where the summary above is insufficient, read it with:
  gh issue view <number>

## Selection principles
- **Maximize shipped value per batch** — prefer issues that meaningfully improve the product
- **Respect effort budget** — a batch should be completable: 2-3 smalls, or 1 medium + 1 small, or 1 large solo
- **De-risk the batch** — avoid stacking multiple high-risk changes; one risky + one safe > two risky
- **Prefer unblocked work** — issues with external dependencies or missing info get skipped
- **Flag stale fixes** — if an issue has been in triage:fix for 3+ batch runs without being selected, consider whether it should be re-labeled as triage:defer (use issue updatedAt to gauge staleness)

Read docs/execution-plan.md and docs/project-hld.md for strategic context.

Select 1-3 issues to ship. If any triage:fix issues should be demoted to triage:defer (stale, lower priority than everything else, unlikely to be selected soon), list them separately.

Return the issue numbers to ship in priority order with reasoning.`,
  {
    label: "ceo-select",
    model: "opus",
    agentType: "ceo",
    schema: SELECTION_SCHEMA,
  },
);

// Guard against CEO agent failure
if (!selection) {
  log("CEO selection agent failed. Stopping.");
  return { status: "failed", phase: "select", triageResults: validResults };
}

if (!selection.selected || selection.selected.length === 0) {
  log(
    `CEO selected nothing to ship: ${selection.reasoning || "no reasoning provided"}`,
  );
  return {
    status: "no-selection",
    message: "CEO declined to ship any issues this batch",
    reasoning: selection.reasoning,
    triageResults: validResults,
  };
}

log(
  `CEO selected: ${selection.selected.map((n) => `#${n}`).join(", ")} — ${selection.reasoning}`,
);

// Demote stale triage:fix issues if any
if (selection.demote && selection.demote.length > 0) {
  for (const issueNumber of selection.demote) {
    await agent(
      `Demote issue #${issueNumber} from triage:fix to triage:defer:
1. gh issue edit ${issueNumber} --remove-label "triage:fix"
2. gh issue edit ${issueNumber} --add-label "triage:defer"`,
      { label: `demote-${issueNumber}` },
    );
  }
  log(
    `Demoted ${selection.demote.length} stale issues to triage:defer: ${selection.demote.map((n) => `#${n}`).join(", ")}`,
  );
}

// Phase 4: Ship sequentially
phase("Ship");

const results = [];
for (const issueNumber of selection.selected) {
  // Verify issue is still open before investing in shipping
  const issueCheck = await agent(
    `Check if issue #${issueNumber} is still open:
gh issue view ${issueNumber} --json state --jq '.state'
Return ONLY the state string (e.g. "OPEN" or "CLOSED").`,
    { label: `check-open-${issueNumber}` },
  );

  if (
    issueCheck &&
    typeof issueCheck === "string" &&
    issueCheck.toUpperCase().includes("CLOSED")
  ) {
    log(`#${issueNumber} is already closed — skipping`);
    await agent(
      `Remove triage:fix label from closed issue #${issueNumber}:
gh issue edit ${issueNumber} --remove-label "triage:fix"`,
      { label: `unlabel-closed-${issueNumber}` },
    );
    results.push({ issueNumber, status: "skipped-closed" });
    continue;
  }

  log(`Shipping issue #${issueNumber}...`);
  const result = await workflow("ship-issue", issueNumber);
  results.push({ issueNumber, ...(result || { status: "agent-failed" }) });

  if (result && result.status === "success") {
    log(`#${issueNumber} shipped: ${result.prUrl}`);
    await agent(
      `Remove the triage:fix label from issue #${issueNumber}:
gh issue edit ${issueNumber} --remove-label "triage:fix"`,
      { label: `unlabel-${issueNumber}` },
    );
  } else if (result && result.status === "awaiting-frontend-decision") {
    log(
      `#${issueNumber} paused: awaiting frontend decision (branch: ${result.branchName}). Will skip on next run until decision is posted.`,
    );
    // Replace triage:fix with triage:defer so it's not re-selected next batch
    await agent(
      `Issue #${issueNumber} is awaiting a frontend design decision. Re-label it:
1. gh issue edit ${issueNumber} --remove-label "triage:fix"
2. gh issue edit ${issueNumber} --add-label "triage:defer"`,
      { label: `defer-awaiting-${issueNumber}` },
    );
  } else {
    const failPhase = result ? result.phase || result.status : "unknown";
    log(`#${issueNumber} stopped at: ${failPhase}`);
  }
}

return {
  status: "complete",
  selection: selection.selected,
  reasoning: selection.reasoning,
  results,
};
