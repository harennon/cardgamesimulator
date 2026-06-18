export const meta = {
  name: "ship-issue",
  description:
    "Take a GitHub issue through the full loop: design → review → implement → code review → QA → raise PR",
  whenToUse:
    "When you want to fully autonomously ship a GitHub issue end-to-end. Pass a GitHub issue number or a free-text description as args.",
  phases: [
    { title: "Gather", detail: "Fetch issue context and determine LLD number" },
    {
      title: "Setup",
      detail: "Create worktree and feature branch",
    },
    {
      title: "Frontend Design",
      detail:
        "Frontend architect produces component specs (skipped for backend-only)",
      model: "opus",
    },
    { title: "Design", detail: "Architect writes the LLD", model: "opus" },
    {
      title: "Design Review",
      detail: "Validate LLD against principles",
      model: "opus",
    },
    {
      title: "Implement",
      detail: "Build code and tests from the approved LLD",
      model: "sonnet",
    },
    {
      title: "Code Review",
      detail: "Check correctness, security, principle adherence",
      model: "opus",
    },
    {
      title: "QA",
      detail: "Verify feature matches CX doc and handles edge cases",
      model: "opus",
    },
    { title: "Ship", detail: "Commit, push, and raise the PR" },
  ],
};

// --- Schemas ---

const GATHER_SCHEMA = {
  type: "object",
  properties: {
    issueTitle: { type: "string" },
    issueBody: { type: "string" },
    nextLldNumber: { type: "integer" },
    lldSlug: {
      type: "string",
      description: "kebab-case slug for the LLD filename",
    },
    branchName: {
      type: "string",
      description: "git branch name for this work",
    },
    relevantFiles: {
      type: "array",
      items: { type: "string" },
      description: "Paths the architect should read",
    },
    hasFrontend: {
      type: "boolean",
      description:
        "True if this issue involves frontend/UI changes (Vue components, CSS, layouts, user-facing views)",
    },
    frontendDecision: {
      type: ["string", "null"],
      description:
        "If hasFrontend and a prior frontend design decision exists in issue comments, extract that text. null if no decision yet.",
    },
  },
  required: [
    "issueTitle",
    "issueBody",
    "nextLldNumber",
    "lldSlug",
    "branchName",
    "relevantFiles",
    "hasFrontend",
  ],
};

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["APPROVED", "CHANGES_REQUESTED"] },
    issues: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["verdict", "summary"],
};

const CODE_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["APPROVED", "CHANGES_REQUESTED"] },
    critical: { type: "array", items: { type: "string" } },
    important: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["verdict", "summary"],
};

const QA_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["APPROVED", "CHANGES_REQUESTED"] },
    issues: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["verdict", "summary"],
};

const SHIP_SCHEMA = {
  type: "object",
  properties: {
    prUrl: { type: "string" },
    commitMessage: { type: "string" },
    closesIssue: {
      type: "boolean",
      description: "True if the PR body contains Closes #N for the issue",
    },
  },
  required: ["prUrl", "commitMessage", "closesIssue"],
};

// --- Helpers ---

function issueIsNumber(input) {
  return (
    typeof input === "number" ||
    (typeof input === "string" && /^\d+$/.test(input))
  );
}

// --- Workflow ---

const input =
  typeof args === "object" && args !== null && args.issue ? args.issue : args;
const issueNum = issueIsNumber(input) ? Number(input) : null;

// Phase 1: Gather context
phase("Gather");
const context = await agent(
  `Prepare context for a development workflow.

${
  issueNum
    ? `Fetch GitHub issue #${issueNum} using: gh issue view ${issueNum}
     Extract the title and body.`
    : `The work to be done is described as: "${input}"
     Set issueTitle to a short summary and issueBody to the full description.`
}

Then:
1. Determine the next LLD number. Check BOTH:
   - ls docs/lld/ (files on disk in the current working tree)
   - git branch -a | grep -oP 'lld-\\K\\d+' (branches that may have uncommitted LLD files)
   Take the MAX of all numbers found and add 1.
2. Create a kebab-case slug from the issue title (e.g. "railway-sleep-on-idle")
3. Create a branch name: lld-{number}-{slug} (e.g. "lld-13-railway-sleep-on-idle")
4. Identify the most relevant source files the architect should read (check files referenced in the issue, or grep for relevant code). List 3-8 paths.
5. Determine hasFrontend: true if the issue involves UI/frontend changes (Vue components, CSS, layouts, user-facing views), false if backend-only.
6. If hasFrontend AND this is a GitHub issue, check the issue comments (gh issue view ${issueNum || "N/A"} --comments) for a comment containing "Frontend decision:". If found, extract the decision text into frontendDecision. If not found, set frontendDecision to null.

Return the structured result.`,
  { label: "gather-context", schema: GATHER_SCHEMA },
);

if (!context) {
  log("Gather agent failed. Stopping.");
  return { status: "failed", phase: "gather" };
}

log(
  `Issue: ${context.issueTitle} → LLD ${context.nextLldNumber}, branch: ${context.branchName}`,
);

// Phase 2: Create worktree and feature branch
phase("Setup");

const repoRoot = "/personal-workplace/neijurli/cardgamesimulator";
const wtPath = `${repoRoot}/../wt-${context.branchName}`;
const lldPath = `docs/lld/${String(context.nextLldNumber).padStart(2, "0")}-${context.lldSlug}.md`;

const SETUP_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ready", "failed"] },
    branch: { type: "string", description: "Current branch in worktree" },
    error: { type: "string", description: "Error message if failed" },
  },
  required: ["status"],
};

const setupResult = await agent(
  `Set up an isolated git worktree for this feature.

Run these commands in order from ${repoRoot}:

1. Ensure main is up to date:
   git -C ${repoRoot} fetch origin main

2. Remove stale worktree if it exists from a prior failed run:
   git -C ${repoRoot} worktree remove ${wtPath} --force 2>/dev/null || true

3. Create the worktree with feature branch (idempotent):
   Try creating new branch first, fall back to existing:
     git -C ${repoRoot} worktree add -b ${context.branchName} ${wtPath} origin/main 2>/dev/null || git -C ${repoRoot} worktree add ${wtPath} ${context.branchName}

4. Verify the worktree is on the correct branch:
   git -C ${wtPath} branch --show-current

5. Install dependencies in the worktree (needed for build/test):
   cd ${wtPath} && npm install --silent

Return status "ready" with the branch name, or "failed" with the error.`,
  { label: "setup-worktree", schema: SETUP_SCHEMA },
);

if (!setupResult || setupResult.status !== "ready") {
  log(
    `Worktree setup failed: ${setupResult ? setupResult.error : "agent returned null"}`,
  );
  return { status: "failed", phase: "setup", detail: setupResult };
}

log(
  `Worktree created at ${wtPath} on branch ${setupResult.branch || context.branchName}`,
);

// Preamble for all subsequent agents operating in the worktree
const WT_PREAMBLE = `**IMPORTANT: All commands must be run from the worktree directory.**
Before running ANY command, first: cd ${wtPath}
Your working directory is ${wtPath} (absolute path) — this is an isolated git worktree on branch "${context.branchName}".
Do NOT switch branches. Do NOT modify files outside this directory.`;

// Phase 3: Frontend Design (conditional — skipped for backend-only issues)
let frontendSpec = null;
if (context.hasFrontend) {
  phase("Frontend Design");

  if (context.frontendDecision) {
    frontendSpec = context.frontendDecision;
    log("Frontend decision found in issue comments — skipping mockup phase");
  } else if (issueNum) {
    // No decision yet — produce mockups, commit to worktree, comment on issue, and stop
    await agent(
      `${WT_PREAMBLE}

Design the frontend UI for:

**Title:** ${context.issueTitle}
**Description:**
${context.issueBody}

**Relevant files (read from main repo):** ${context.relevantFiles.join(", ")}

Read docs/customer-experience.md for user flows and wireframes.
Read the relevant frontend files listed above.

Produce:
1. Component tree and hierarchy
2. Layout strategy (CSS Grid/Flexbox decisions, responsive breakpoints)
3. State management approach (props, composables, stores)
4. Interaction model (user actions, visual feedback, transitions)

Save HTML mockup(s) to docs/mockups/${context.lldSlug}.html (and variants if proposing multiple options).
The mockup(s) should demonstrate the visual layout and key states.

Then:
1. git add docs/mockups/
2. git commit -m "Add frontend mockups for ${context.issueTitle}"
3. git push -u origin ${context.branchName}
4. Comment on GitHub issue #${issueNum} with:
   - A summary of the design options/decisions proposed
   - A link to view the mockups on the branch (point to the file paths on GitHub)
   - Ask the user to reply with "Frontend decision: <their choice>" to proceed

Use: gh issue comment ${issueNum} --body "$(cat <<'MOCKUPEOF'
## Frontend Design Mockups

[Summary of design options]

View mockups: docs/mockups/${context.lldSlug}.html on branch \`${context.branchName}\`

Please reply with **Frontend decision: <your choice>** to proceed with implementation.
MOCKUPEOF
)"`,
      {
        label: "frontend-architect",
        model: "opus",
        agentType: "frontend-architect",
      },
    );

    log(
      "Frontend mockups committed and issue commented — awaiting decision. Re-run this workflow after commenting 'Frontend decision: ...' on the issue.",
    );
    // Clean up worktree — branch is pushed, re-run will re-create from remote
    await agent(
      `Remove the worktree: git -C ${repoRoot} worktree remove ${wtPath} --force 2>/dev/null || true`,
      { label: "cleanup-worktree" },
    );
    return {
      status: "awaiting-frontend-decision",
      issueTitle: context.issueTitle,
      branchName: context.branchName,
      message:
        "Mockups pushed and issue commented. Reply on the issue with 'Frontend decision: <choice>' then re-run the workflow.",
    };
  }
}

// Phase 4: Architect writes the LLD
phase("Design");

await agent(
  `${WT_PREAMBLE}

Write an LLD for:

**Title:** ${context.issueTitle}
**Description:**
${context.issueBody}

**LLD number:** ${context.nextLldNumber}
**Save to:** ${lldPath}

**Files to examine for context:** ${context.relevantFiles.join(", ")}

Read DEVELOPMENT.md, docs/architecture-principles.md, docs/testing-principles.md, and docs/project-hld.md.
Then read the relevant files listed above.
Write the LLD following the standard structure (Scope, Approach, Interfaces/Types, State Model, Edge Cases, Dependencies, Test Requirements).
${frontendSpec ? `\nInclude a **## Frontend Design** section in the LLD that incorporates these frontend architecture decisions:\n${frontendSpec}` : ""}
Keep it concise — enough to implement from, not a textbook.

Save the file to ${lldPath}.
Then commit it immediately:
  git add ${lldPath}
  git commit -m "Add LLD ${context.nextLldNumber}: ${context.issueTitle}"`,
  { label: "architect", model: "opus", agentType: "architect" },
);

log(`LLD written and committed: ${lldPath}`);

// Phase 5: Design Review (with retry loop)
phase("Design Review");
let designApproved = false;
let designAttempts = 0;
const MAX_DESIGN_ATTEMPTS = 3;

while (!designApproved && designAttempts < MAX_DESIGN_ATTEMPTS) {
  designAttempts++;

  const review = await agent(
    `${WT_PREAMBLE}

Review the LLD at ${lldPath}.

Read the file, then evaluate it against docs/architecture-principles.md and docs/testing-principles.md.

${designAttempts > 1 ? "This is a re-review after the architect addressed prior feedback. Check if the issues are resolved." : ""}

Return your verdict.`,
    {
      label: `design-review-${designAttempts}`,
      model: "opus",
      agentType: "design-reviewer",
      schema: REVIEW_SCHEMA,
    },
  );

  if (!review) {
    log(`Design review agent failed on attempt ${designAttempts}`);
    continue;
  }

  if (review.verdict === "APPROVED") {
    designApproved = true;
    log(`Design review: APPROVED`);
  } else {
    log(
      `Design review: CHANGES REQUESTED (attempt ${designAttempts}/${MAX_DESIGN_ATTEMPTS})`,
    );

    if (designAttempts < MAX_DESIGN_ATTEMPTS) {
      await agent(
        `${WT_PREAMBLE}

The design reviewer found issues with your LLD at ${lldPath}:

${review.issues ? review.issues.join("\n") : review.summary}

**Original issue context:**
Title: ${context.issueTitle}
Description: ${context.issueBody}
Relevant files: ${context.relevantFiles.join(", ")}

Read the LLD, address the feedback, and update the file in place. Do not change the filename.
Then commit:
  git add ${lldPath}
  git commit -m "Revise LLD ${context.nextLldNumber} per review feedback"`,
        {
          label: `architect-revision-${designAttempts}`,
          model: "opus",
          agentType: "architect",
        },
      );
    }
  }
}

if (!designApproved) {
  log(`Design review failed after ${MAX_DESIGN_ATTEMPTS} attempts. Stopping.`);
  await agent(
    `Clean up the worktree: git worktree remove ${wtPath} --force 2>/dev/null || true`,
    { label: "cleanup-worktree" },
  );
  return { status: "failed", phase: "design-review", lldPath };
}

// Phase 6: Implementation
phase("Implement");
await agent(
  `${WT_PREAMBLE}

Implement the approved LLD at ${lldPath}.

Process:
1. Read the LLD thoroughly
2. Implement module by module, writing tests alongside
3. Run npm run build — fix any errors
4. Run npm test — fix any failures
5. Run npm run lint:fix
6. Update CHANGELOG.md under [Unreleased] with what was implemented
7. Stage and commit:
   - Run git status to see what changed
   - Stage ONLY source files you created/modified (src/**, tests/**, CHANGELOG.md, package.json, etc.)
   - Do NOT stage .env, .env.*, credentials, secrets, node_modules, build/, or dist/
   - git add <specific files>
   - git commit -m "Implement LLD ${context.nextLldNumber}: ${context.issueTitle}"

You are already on branch ${context.branchName}. Do NOT create or switch branches.`,
  { label: "implementer", model: "sonnet", agentType: "implementer" },
);

log("Implementation complete");

// Phase 7: Code Review (with retry loop)
phase("Code Review");
let codeApproved = false;
let codeAttempts = 0;
const MAX_CODE_ATTEMPTS = 3;

while (!codeApproved && codeAttempts < MAX_CODE_ATTEMPTS) {
  codeAttempts++;

  const codeReview = await agent(
    `${WT_PREAMBLE}

Review the implementation of the LLD at ${lldPath}.

Run these commands first:
- git diff main --stat (to see what files changed)
- npm run build (verify it compiles)
- npm test (verify tests pass)

${codeAttempts > 1 ? "This is a re-review after the implementer addressed prior feedback. Verify fixes are correct." : ""}

Return your verdict.`,
    {
      label: `code-review-${codeAttempts}`,
      model: "opus",
      agentType: "code-reviewer",
      schema: CODE_REVIEW_SCHEMA,
    },
  );

  if (!codeReview) {
    log(`Code review agent failed on attempt ${codeAttempts}`);
    continue;
  }

  if (codeReview.verdict === "APPROVED") {
    codeApproved = true;
    log(`Code review: APPROVED`);
  } else {
    log(
      `Code review: CHANGES REQUESTED (attempt ${codeAttempts}/${MAX_CODE_ATTEMPTS})`,
    );

    if (codeAttempts < MAX_CODE_ATTEMPTS) {
      const issues = [
        ...(codeReview.critical || []).map((i) => `CRITICAL: ${i}`),
        ...(codeReview.important || []).map((i) => `IMPORTANT: ${i}`),
      ].join("\n");

      await agent(
        `${WT_PREAMBLE}

The code reviewer found issues:

${issues || codeReview.summary}

**Original context:**
- LLD: ${lldPath}
- Issue: ${context.issueTitle}
- Description: ${context.issueBody}

Fix these issues in the code. Reference the LLD if needed.
After fixing:
- Run npm run build (must pass)
- Run npm test (must pass)
- Run npm run lint:fix
- Stage only the files you modified (no .env, secrets, node_modules, build/)
- Commit: git add <your changed files> && git commit -m "Address code review feedback (round ${codeAttempts})"`,
        {
          label: `implementer-fix-${codeAttempts}`,
          model: "sonnet",
          agentType: "implementer",
        },
      );
    }
  }
}

if (!codeApproved) {
  log(`Code review failed after ${MAX_CODE_ATTEMPTS} attempts. Stopping.`);
  await agent(
    `Clean up the worktree: git worktree remove ${wtPath} --force 2>/dev/null || true`,
    { label: "cleanup-worktree" },
  );
  return { status: "failed", phase: "code-review", lldPath };
}

// Phase 8: QA (with retry loop back to implementer)
phase("QA");
let qaApproved = false;
let qaAttempts = 0;
const MAX_QA_ATTEMPTS = 3;

while (!qaApproved && qaAttempts < MAX_QA_ATTEMPTS) {
  qaAttempts++;

  const qaResult = await agent(
    `${WT_PREAMBLE}

Validate the implementation of the LLD at ${lldPath}.

Check the changed files (run: git diff main --stat, then read relevant ones).
Cross-reference with docs/customer-experience.md for expected user flows.

${qaAttempts > 1 ? "This is a re-check after the implementer addressed prior QA feedback. Verify the fixes." : ""}

Return your verdict.`,
    {
      label: `qa-${qaAttempts}`,
      model: "opus",
      agentType: "qa",
      schema: QA_SCHEMA,
    },
  );

  if (!qaResult) {
    log(`QA agent failed on attempt ${qaAttempts}`);
    continue;
  }

  if (qaResult.verdict === "APPROVED") {
    qaApproved = true;
    log(`QA: APPROVED`);
  } else {
    log(`QA: CHANGES REQUESTED (attempt ${qaAttempts}/${MAX_QA_ATTEMPTS})`);

    if (qaAttempts < MAX_QA_ATTEMPTS) {
      await agent(
        `${WT_PREAMBLE}

QA found issues with the feature:

${qaResult.issues ? qaResult.issues.join("\n") : qaResult.summary}

**Original context:**
- LLD: ${lldPath}
- Issue: ${context.issueTitle}
- CX doc: docs/customer-experience.md

Fix these issues. Reference the LLD and CX doc if needed.
After fixing:
- Run npm run build (must pass)
- Run npm test (must pass)
- Run npm run lint:fix
- Stage only the files you modified (no .env, secrets, node_modules, build/)
- Commit: git add <your changed files> && git commit -m "Address QA feedback (round ${qaAttempts})"`,
        {
          label: `implementer-qa-fix-${qaAttempts}`,
          model: "sonnet",
          agentType: "implementer",
        },
      );
    }
  }
}

if (!qaApproved) {
  log(`QA failed after ${MAX_QA_ATTEMPTS} attempts. Stopping.`);
  await agent(
    `Clean up the worktree: git worktree remove ${wtPath} --force 2>/dev/null || true`,
    { label: "cleanup-worktree" },
  );
  return { status: "failed", phase: "qa", lldPath };
}

// Phase 9: Ship (push and PR)
phase("Ship");
const shipResult = await agent(
  `${WT_PREAMBLE}

Ship the implementation. You are on branch ${context.branchName}.

Steps:
1. Verify you are on the correct branch:
   git branch --show-current (must output "${context.branchName}")

2. Push: git push -u origin ${context.branchName}

3. Create PR: gh pr create --title "..." --body "$(cat <<'PREOF'
## Summary
[3-5 bullets describing what was implemented and why]

## LLD
LLD ${context.nextLldNumber}: ${lldPath}

${issueNum ? `Closes #${issueNum}` : ""}

## Test plan
[Bulleted markdown checklist of how to verify]
PREOF
)"

   - Title: short, under 70 chars, imperative mood
   - IMPORTANT: ${issueNum ? `The body MUST contain "Closes #${issueNum}" to auto-close the issue on merge.` : "No issue to close."}

4. Verify the PR was created successfully and return the URL.

Return the PR URL, commit message summary, and confirm closesIssue is ${issueNum ? "true" : "false"}.`,
  { label: "ship", schema: SHIP_SCHEMA },
);

if (!shipResult) {
  log("Ship agent failed. Branch is pushed but PR may not exist.");
  await agent(
    `Clean up the worktree: git worktree remove ${wtPath} --force 2>/dev/null || true`,
    { label: "cleanup-worktree" },
  );
  return { status: "failed", phase: "ship", branchName: context.branchName };
}

if (issueNum && !shipResult.closesIssue) {
  log(
    `WARNING: PR may not auto-close issue #${issueNum}. Verify the PR body contains "Closes #${issueNum}".`,
  );
}

log(`PR raised: ${shipResult.prUrl}`);

// Clean up worktree
await agent(
  `Remove the worktree now that the PR is up:
git worktree remove ${wtPath} --force 2>/dev/null || true`,
  { label: "cleanup-worktree" },
);

return {
  status: "success",
  issueTitle: context.issueTitle,
  lldPath,
  branchName: context.branchName,
  prUrl: shipResult.prUrl,
};
