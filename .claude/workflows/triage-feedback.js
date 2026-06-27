export const meta = {
  name: "triage-feedback",
  description:
    "Fetch user feedback, group duplicates, assess impact, and create GitHub issues",
  whenToUse:
    "When you want to process accumulated user feedback into actionable GitHub issues. Groups related feedback, identifies bugs vs feature requests, assesses blast radius, and creates well-scoped issues.",
  phases: [
    { title: "Fetch", detail: "Pull all feedback from the API" },
    {
      title: "Group",
      detail: "Cluster related feedback and identify duplicates",
      model: "opus",
    },
    {
      title: "Assess",
      detail: "Rate severity, blast radius, and user impact per group",
      model: "opus",
    },
    {
      title: "Deduplicate",
      detail: "Check existing issues to avoid duplicates",
    },
    {
      title: "Create",
      detail: "Create GitHub issues for approved groups",
    },
    {
      title: "Cleanup",
      detail: "Delete processed feedback entries",
    },
  ],
};

// --- Schemas ---

const FEEDBACK_LIST_SCHEMA = {
  type: "object",
  properties: {
    feedback: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          category: { type: "string" },
          description: { type: "string" },
          route: { type: "string" },
          userType: { type: "string" },
          createdAt: { type: "string" },
        },
        required: ["id", "category", "description"],
      },
    },
  },
  required: ["feedback"],
};

const GROUPING_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Concise issue title summarizing the group",
          },
          category: {
            type: "string",
            enum: ["bug", "feature-request", "improvement", "noise"],
            description:
              "bug: broken behavior, feature-request: new capability, improvement: polish, noise: not actionable",
          },
          feedbackIds: {
            type: "array",
            items: { type: "string" },
            description: "IDs of feedback entries in this group",
          },
          reportCount: {
            type: "integer",
            description: "Number of distinct users/reports for this issue",
          },
          summary: {
            type: "string",
            description:
              "What users are experiencing, synthesized from all reports in the group",
          },
          userQuotes: {
            type: "array",
            items: { type: "string" },
            description:
              "2-3 representative direct quotes from feedback (verbatim)",
          },
          affectedRoutes: {
            type: "array",
            items: { type: "string" },
            description: "UI routes/pages where this was reported",
          },
          affectedUserTypes: {
            type: "array",
            items: { type: "string" },
            description: "User types affected (guest, registered, admin, etc.)",
          },
        },
        required: [
          "title",
          "category",
          "feedbackIds",
          "reportCount",
          "summary",
          "userQuotes",
        ],
      },
    },
    discarded: {
      type: "array",
      items: {
        type: "object",
        properties: {
          feedbackId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["feedbackId", "reason"],
      },
      description:
        "Feedback entries that are noise/spam/unintelligible — will be deleted without creating issues",
    },
  },
  required: ["groups", "discarded"],
};

const ASSESSMENT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    category: {
      type: "string",
      enum: ["bug", "feature-request", "improvement"],
    },
    severity: {
      type: "string",
      enum: ["critical", "high", "medium", "low"],
      description:
        "critical: blocks core gameplay, high: significant UX degradation, medium: noticeable annoyance, low: cosmetic/minor",
    },
    blastRadius: {
      type: "string",
      enum: ["all-users", "most-users", "some-users", "edge-case"],
      description: "How many users are likely affected",
    },
    frequency: {
      type: "string",
      enum: ["every-session", "most-sessions", "sometimes", "rare"],
      description: "How often a user would encounter this",
    },
    reproducibility: {
      type: "string",
      enum: ["always", "usually", "intermittent", "unknown"],
    },
    userImpact: {
      type: "string",
      description:
        "One sentence: what the user experiences and how it affects their gameplay/flow",
    },
    technicalHypothesis: {
      type: "string",
      description:
        "Best guess at root cause based on the reports and affected routes/code",
    },
    priority: {
      type: "string",
      enum: ["high", "medium", "low"],
      description: "Recommended priority for the issue",
    },
    shouldCreateIssue: {
      type: "boolean",
      description:
        "false if the group is too vague, already fixed, or not worth tracking",
    },
    skipReason: {
      type: "string",
      description: "If shouldCreateIssue is false, explain why",
    },
    issueBody: {
      type: "string",
      description:
        "Full GitHub issue body in markdown (only if shouldCreateIssue is true)",
    },
  },
  required: [
    "title",
    "category",
    "severity",
    "blastRadius",
    "frequency",
    "userImpact",
    "priority",
    "shouldCreateIssue",
  ],
};

const DEDUP_SCHEMA = {
  type: "object",
  properties: {
    isDuplicate: {
      type: "boolean",
      description: "true if an existing open issue already covers this",
    },
    existingIssueNumber: {
      type: "integer",
      description: "The existing issue number if duplicate",
    },
    action: {
      type: "string",
      enum: ["skip", "comment", "create"],
      description:
        "skip: exact duplicate, comment: add user reports to existing issue, create: new issue",
    },
    reason: { type: "string" },
  },
  required: ["isDuplicate", "action", "reason"],
};

// --- Workflow ---

phase("Fetch");

const feedbackResult = await agent(
  `Fetch all feedback from the API using the feedback script.

Run: node scripts/feedback.mjs --json

This outputs a JSON array of feedback objects. Parse and return them all.
Each entry has: id, category, description, metadata (with route, userType), createdAt.

Flatten metadata fields into the top level (route, userType).
Return ALL entries — we'll group and filter in the next phase.`,
  { label: "fetch-feedback", schema: FEEDBACK_LIST_SCHEMA },
);

if (
  !feedbackResult ||
  !feedbackResult.feedback ||
  feedbackResult.feedback.length === 0
) {
  log("No feedback found. Nothing to triage.");
  return { status: "idle", message: "No feedback to process" };
}

const MAX_FEEDBACK_PER_RUN = 50;
const allFeedback = feedbackResult.feedback;
const feedbackCount = allFeedback.length;

if (feedbackCount > MAX_FEEDBACK_PER_RUN) {
  log(
    `${feedbackCount} entries found — processing first ${MAX_FEEDBACK_PER_RUN} (remainder next run)`,
  );
}
const feedbackToProcess = allFeedback.slice(0, MAX_FEEDBACK_PER_RUN);
log(
  `Fetched ${feedbackCount} feedback entries, processing ${feedbackToProcess.length}`,
);

// --- Phase 2: Group related feedback ---

phase("Group");

const grouping = await agent(
  `You have ${feedbackToProcess.length} feedback entries from users. Group related entries together — these are reports about the SAME underlying issue from different users (or the same user at different times).

## Feedback entries
${JSON.stringify(feedbackToProcess, null, 2)}

## Grouping principles
- Two entries are in the same group if they describe the same root problem, even if worded differently
- A single entry can be its own group (unique report)
- Look for patterns: same route, same category, similar descriptions, same timeframe
- Preserve the original feedback IDs for each group (we'll use them to delete processed entries)
- Pick a concise, actionable title for each group (this becomes the GitHub issue title)
- Include 2-3 verbatim user quotes that best represent the problem
- Category: bug (something broken), feature-request (something new), improvement (something that exists but could be better), noise (spam, gibberish, "test", etc.)
- Mark clearly non-actionable entries as "noise" in the discarded list — these get deleted without issues

## Important
- Don't over-merge: "cards are hard to tap" and "game is laggy" are different issues even if both are UX complaints
- Don't under-merge: "can't select cards on iPhone" and "card selection broken on mobile" are the same issue
- reportCount should reflect how many distinct reports mention this (signal for blast radius)`,
  { label: "group-feedback", model: "opus", schema: GROUPING_SCHEMA },
);

if (!grouping || !grouping.groups || grouping.groups.length === 0) {
  log("Grouping produced no results. Check feedback data.");
  return { status: "failed", phase: "group" };
}

const actionableGroups = grouping.groups.filter((g) => g.category !== "noise");
const noiseCount = (grouping.discarded || []).length;
log(
  `Grouped into ${actionableGroups.length} actionable clusters + ${noiseCount} noise entries`,
);

// --- Phase 3: Assess each group ---

phase("Assess");

const assessments = await parallel(
  actionableGroups.map(
    (group, idx) => () =>
      agent(
        `Assess this feedback group for severity, blast radius, and whether it warrants a GitHub issue.

## Group: "${group.title}"
- Category: ${group.category}
- Report count: ${group.reportCount}
- Summary: ${group.summary}
- User quotes: ${group.userQuotes.map((q) => `"${q}"`).join("; ")}
- Affected routes: ${(group.affectedRoutes || []).join(", ") || "unknown"}
- Affected user types: ${(group.affectedUserTypes || []).join(", ") || "unknown"}

## Assessment criteria

### Severity
- critical: Blocks core gameplay (can't play, can't join, game crashes)
- high: Significant UX degradation (major feature broken, confusing flow)
- medium: Noticeable annoyance (minor UI glitch, slow response, unclear text)
- low: Cosmetic/minor (alignment, color, wording preference)

### Blast radius
- all-users: Every user encounters this
- most-users: Majority of users in normal flow
- some-users: Specific subset (mobile-only, guest-only, etc.)
- edge-case: Rare conditions or specific device/browser

### Technical analysis
Read relevant source code to form a hypothesis about root cause:
- Check the affected routes in src/frontend/
- Check related backend code in src/backend/
- Look at recent git changes that might have introduced the issue

### Issue body (if shouldCreateIssue is true)
Write a complete GitHub issue body with:
- **Problem:** What users experience
- **Evidence:** Report count, affected user types, quotes
- **Blast radius:** Who's affected and how often
- **Technical hypothesis:** Likely root cause from code inspection
- **Acceptance criteria:** What "fixed" looks like

IMPORTANT: Set the "title" field in your response to EXACTLY: "${group.title}"

If the group is too vague to act on, or if you find evidence it's already been fixed in recent commits, set shouldCreateIssue=false with a reason.`,
        {
          label: `assess-${idx}-${group.title.slice(0, 25).replace(/\s+/g, "-").toLowerCase()}`,
          phase: "Assess",
          schema: ASSESSMENT_SCHEMA,
        },
      ),
  ),
);

// Pair assessments with their groups by index (parallel preserves order)
const paired = assessments
  .map((a, i) => (a ? { assessment: a, group: actionableGroups[i] } : null))
  .filter(Boolean);
const toCreate = paired.filter((p) => p.assessment.shouldCreateIssue);
const skipped = paired.filter((p) => !p.assessment.shouldCreateIssue);

if (skipped.length > 0) {
  log(
    `Skipping ${skipped.length} groups: ${skipped.map((s) => `"${s.assessment.title}" (${s.assessment.skipReason})`).join(", ")}`,
  );
}

if (toCreate.length === 0) {
  log("No groups warrant new issues. Cleaning up noise only.");

  // Still clean up noise/processed entries
  const allProcessedIds = [
    ...(grouping.discarded || []).map((d) => d.feedbackId),
    ...actionableGroups.flatMap((g) => g.feedbackIds),
  ];

  if (allProcessedIds.length > 0) {
    phase("Cleanup");
    await agent(
      `Delete these processed feedback entries (they've been triaged and none warrant issues):
${allProcessedIds.map((id) => `node scripts/feedback.mjs --delete ${id}`).join("\n")}

Run each delete command. Report how many succeeded.`,
      { label: "cleanup-no-issues" },
    );
    log(`Cleaned up ${allProcessedIds.length} processed feedback entries`);
  }

  return {
    status: "complete",
    issuesCreated: 0,
    feedbackProcessed: feedbackCount,
    skipped: skipped.map((s) => ({
      title: s.assessment.title,
      reason: s.assessment.skipReason,
    })),
  };
}

log(`${toCreate.length} groups will become issues. Checking for duplicates...`);

// --- Phase 4: Deduplicate against existing issues ---

phase("Deduplicate");

const dedupResults = await parallel(
  toCreate.map(
    (pair, idx) => () =>
      agent(
        `Check if a GitHub issue already exists for this problem:

## New issue to check
Title: "${pair.assessment.title}"
Category: ${pair.assessment.category}
Summary: ${pair.assessment.userImpact}

## Steps
1. Search open issues: gh issue list --state open --search "${pair.assessment.title.split(" ").slice(0, 4).join(" ")}" --json number,title,body --limit 10
2. Also search with keywords: gh issue list --state open --search "${pair.assessment.category} ${(pair.assessment.title.match(/\b\w{4,}\b/g) || []).slice(0, 3).join(" ")}" --json number,title,body --limit 10
3. Check if any existing issue covers the same root problem (even with different wording)

## Decision
- If an existing open issue covers this exactly: action="skip"
- If an existing issue is related but this adds new signal (more user reports, different angle): action="comment" (we'll add the reports as a comment)
- If no existing issue covers this: action="create"

Return your assessment.`,
        {
          label: `dedup-${idx}-${pair.assessment.title.slice(0, 20).replace(/\s+/g, "-").toLowerCase()}`,
          phase: "Deduplicate",
          schema: DEDUP_SCHEMA,
        },
      ),
  ),
);

// Pair assessments with dedup results
const createPlan = [];
const commentPlan = [];
const skipPlan = [];

for (let i = 0; i < toCreate.length; i++) {
  const { assessment, group } = toCreate[i];
  const dedup = dedupResults[i];

  if (!dedup || dedup.action === "create") {
    createPlan.push({ assessment, group });
  } else if (dedup.action === "comment") {
    commentPlan.push({
      assessment,
      group,
      existingIssue: dedup.existingIssueNumber,
    });
  } else {
    skipPlan.push({ assessment, group, reason: dedup.reason });
  }
}

if (skipPlan.length > 0) {
  log(
    `Skipping ${skipPlan.length} duplicates: ${skipPlan.map((s) => `"${s.assessment.title}"`).join(", ")}`,
  );
}

// --- Phase 5: Create issues and add comments ---

phase("Create");

const createdIssues = [];

// Create new issues
if (createPlan.length > 0) {
  const createResults = await parallel(
    createPlan.map(
      (plan) => () =>
        agent(
          `Create a GitHub issue:

Title: ${plan.assessment.title}
Labels: ${plan.assessment.category}, priority:${plan.assessment.priority}

Body (use heredoc):
gh issue create --title "${plan.assessment.title}" --body "$(cat <<'FBEOF'
${plan.assessment.issueBody}

---
_Created from ${plan.group ? plan.group.reportCount : 1} user feedback report(s) via triage-feedback workflow._
FBEOF
)" --label "${plan.assessment.category}" --label "priority:${plan.assessment.priority}"

Return the URL of the created issue.`,
          {
            label: `create-issue-${plan.assessment.title.slice(0, 25).replace(/\s+/g, "-").toLowerCase()}`,
            phase: "Create",
          },
        ),
    ),
  );

  createdIssues.push(
    ...createResults.filter(Boolean).map((r, i) => ({
      title: createPlan[i].assessment.title,
      priority: createPlan[i].assessment.priority,
      severity: createPlan[i].assessment.severity,
      blastRadius: createPlan[i].assessment.blastRadius,
      reportCount: createPlan[i].group ? createPlan[i].group.reportCount : 1,
    })),
  );
}

// Add comments to existing issues
if (commentPlan.length > 0) {
  await parallel(
    commentPlan.map(
      (plan) => () =>
        agent(
          `Add user feedback reports to existing issue #${plan.existingIssue}:

gh issue comment ${plan.existingIssue} --body "$(cat <<'FBCOMMENT'
**Additional user feedback (${plan.group ? plan.group.reportCount : 1} report(s)):**

${plan.group ? plan.group.userQuotes.map((q) => `> ${q}`).join("\n\n") : plan.assessment.userImpact}

_Severity: ${plan.assessment.severity} | Blast radius: ${plan.assessment.blastRadius} | Frequency: ${plan.assessment.frequency}_
FBCOMMENT
)"`,
          { label: `comment-${plan.existingIssue}`, phase: "Create" },
        ),
    ),
  );
  log(
    `Added feedback to ${commentPlan.length} existing issues: ${commentPlan.map((p) => `#${p.existingIssue}`).join(", ")}`,
  );
}

log(
  `Created ${createdIssues.length} new issues: ${createdIssues.map((i) => `"${i.title}" (${i.priority})`).join(", ")}`,
);

// --- Phase 6: Cleanup processed feedback ---

phase("Cleanup");

// Collect all feedback IDs that were processed (created, commented, skipped as dup, or noise)
const allProcessedIds = [
  ...(grouping.discarded || []).map((d) => d.feedbackId),
  ...createPlan.flatMap((p) => (p.group ? p.group.feedbackIds : [])),
  ...commentPlan.flatMap((p) => (p.group ? p.group.feedbackIds : [])),
  ...skipPlan.flatMap((p) => (p.group ? p.group.feedbackIds : [])),
  ...skipped.flatMap((s) => (s.group ? s.group.feedbackIds : [])),
];

if (allProcessedIds.length > 0) {
  await agent(
    `Delete these processed feedback entries (they've been triaged into issues or discarded):
${allProcessedIds.map((id) => `node scripts/feedback.mjs --delete ${id}`).join("\n")}

Run each delete command. It's OK if some fail (entry may already be gone). Report how many succeeded vs failed.`,
    { label: "cleanup-feedback" },
  );
  log(`Cleaned up ${allProcessedIds.length} processed feedback entries`);
} else {
  log("No feedback entries to clean up");
}

return {
  status: "complete",
  feedbackProcessed: feedbackCount,
  issuesCreated: createdIssues.length,
  issuesCommented: commentPlan.length,
  duplicatesSkipped: skipPlan.length,
  noiseDiscarded: noiseCount,
  issues: createdIssues,
};
