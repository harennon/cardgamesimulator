export const meta = {
  name: "ship-issue",
  description:
    "Take a GitHub issue through the full loop: design → review → implement → code review → QA → raise PR",
  whenToUse:
    "When you want to fully autonomously ship a GitHub issue end-to-end. Pass a GitHub issue number or a free-text description as args.",
  phases: [
    { title: "Gather", detail: "Fetch issue context and determine LLD number" },
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
      type: "string",
      description:
        "If hasFrontend and a prior frontend design decision exists in issue comments (look for a comment containing 'Frontend decision:'), extract that decision text. null if no decision yet.",
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
  },
  required: ["prUrl", "commitMessage"],
};

// --- Workflow ---

const input = args;
const issueRef =
  typeof input === "number" ||
  (typeof input === "string" && /^\d+$/.test(input))
    ? `GitHub issue #${input}`
    : input;

// Phase 1: Gather context
phase("Gather");
const context = await agent(
  `Prepare context for a development workflow.

${
  typeof input === "number" ||
  (typeof input === "string" && /^\d+$/.test(input))
    ? `Fetch GitHub issue #${input} using: gh issue view ${input}
     Extract the title and body.`
    : `The work to be done is described as: "${input}"
     Set issueTitle to a short summary and issueBody to the full description.`
}

Then:
1. List existing LLDs: ls docs/lld/ — find the highest number and add 1 for nextLldNumber
2. Create a kebab-case slug from the issue title (e.g. "railway-sleep-on-idle")
3. Create a branch name: lld-{number}-{slug} (e.g. "lld-13-railway-sleep-on-idle")
4. Identify the most relevant source files the architect should read (check files referenced in the issue, or grep for relevant code). List 3-8 paths.
5. Determine hasFrontend: true if the issue involves UI/frontend changes (Vue components, CSS, layouts, user-facing views), false if backend-only.
6. If hasFrontend AND this is a GitHub issue, check the issue comments (gh issue view ${typeof input === "number" || (typeof input === "string" && /^\d+$/.test(input)) ? input : "N/A"} --comments) for a comment containing "Frontend decision:". If found, extract the decision text into frontendDecision. If not found, set frontendDecision to null.

Return the structured result.`,
  { label: "gather-context", schema: GATHER_SCHEMA },
);

log(
  `Issue: ${context.issueTitle} → LLD ${context.nextLldNumber}, branch: ${context.branchName}`,
);

// Phase 1.5: Frontend Design (conditional — skipped for backend-only issues)
let frontendSpec = null;
if (context.hasFrontend) {
  phase("Frontend Design");

  if (context.frontendDecision) {
    // Decision already made on the issue — use it directly
    frontendSpec = context.frontendDecision;
    log("Frontend decision found in issue comments — skipping mockup phase");
  } else {
    // No decision yet — produce mockups, commit to branch, comment on issue, and stop
    const mockupBranch = `${context.branchName}-mockups`;

    await agent(
      `Design the frontend UI for:

**Title:** ${context.issueTitle}
**Description:**
${context.issueBody}

**Relevant files:** ${context.relevantFiles.join(", ")}

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
1. git checkout -b ${mockupBranch}
2. git add docs/mockups/
3. git commit -m "Add frontend mockups for ${context.issueTitle}"
4. git push -u origin ${mockupBranch}
5. Comment on GitHub issue #${input} with:
   - A summary of the design options/decisions proposed
   - A link to view the mockups on the branch (point to the file paths on GitHub)
   - Ask the user to reply with "Frontend decision: <their choice>" to proceed

Use: gh issue comment ${input} --body "..."`,
      {
        label: "frontend-architect",
        model: "opus",
        agentType: "frontend-architect",
      },
    );

    log(
      "Frontend mockups committed and issue commented — awaiting decision. Re-run this workflow after commenting 'Frontend decision: ...' on the issue.",
    );
    return {
      status: "awaiting-frontend-decision",
      issueTitle: context.issueTitle,
      branchName: mockupBranch,
      message:
        "Mockups pushed and issue commented. Reply on the issue with 'Frontend decision: <choice>' then re-run the workflow.",
    };
  }
}

// Phase 2: Architect writes the LLD
phase("Design");
const lldPath = `docs/lld/${String(context.nextLldNumber).padStart(2, "0")}-${context.lldSlug}.md`;

await agent(
  `Write an LLD for:

**Title:** ${context.issueTitle}
**Description:**
${context.issueBody}

**LLD number:** ${context.nextLldNumber}
**Save to:** ${lldPath}

**Files to examine for context:** ${context.relevantFiles.join(", ")}

Read DEVELOPMENT.md, docs/architecture-principles.md, docs/testing-principles.md, and docs/project-hld.md.
Then read the relevant files listed above.
Write the LLD following the standard structure (Scope, Approach, Interfaces/Types, State Model, Edge Cases, Dependencies, Test Requirements).
Keep it concise — enough to implement from, not a textbook.
${frontendSpec ? `\n**Frontend design (from frontend-architect — incorporate into the LLD):**\n${frontendSpec}` : ""}
Save the file to ${lldPath}.`,
  { label: "architect", model: "opus", agentType: "architect" },
);

log(`LLD written: ${lldPath}`);

// Phase 3: Design Review (with retry loop)
phase("Design Review");
let designApproved = false;
let designAttempts = 0;
const MAX_DESIGN_ATTEMPTS = 3;

while (!designApproved && designAttempts < MAX_DESIGN_ATTEMPTS) {
  designAttempts++;

  const review = await agent(
    `Review the LLD at ${lldPath}.

${designAttempts > 1 ? "This is a re-review after the architect addressed prior feedback. Check if the issues are resolved." : ""}

Return your verdict.`,
    {
      label: `design-review-${designAttempts}`,
      model: "opus",
      agentType: "design-reviewer",
      schema: REVIEW_SCHEMA,
    },
  );

  if (review.verdict === "APPROVED") {
    designApproved = true;
    log(`Design review: APPROVED`);
  } else {
    log(
      `Design review: CHANGES REQUESTED (attempt ${designAttempts}/${MAX_DESIGN_ATTEMPTS})`,
    );

    if (designAttempts < MAX_DESIGN_ATTEMPTS) {
      await agent(
        `The design reviewer found issues with your LLD at ${lldPath}:

${review.issues ? review.issues.join("\n") : review.summary}

Read the LLD, address the feedback, and update the file in place. Do not change the filename.`,
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
  return { status: "failed", phase: "design-review", lldPath };
}

// Phase 4: Implementation
phase("Implement");
await agent(
  `Implement the approved LLD at ${lldPath}.

Process:
1. Read the LLD thoroughly
2. Create the git branch from main: git checkout main && git pull && git checkout -b ${context.branchName}
3. Implement module by module, writing tests alongside
4. Run npm run build — fix any errors
5. Run npm test — fix any failures
6. Run npm run lint:fix
7. Update CHANGELOG.md under [Unreleased] with what was implemented`,
  { label: "implementer", model: "sonnet", agentType: "implementer" },
);

log("Implementation complete");

// Phase 5: Code Review (with retry loop)
phase("Code Review");
let codeApproved = false;
let codeAttempts = 0;
const MAX_CODE_ATTEMPTS = 3;

while (!codeApproved && codeAttempts < MAX_CODE_ATTEMPTS) {
  codeAttempts++;

  const codeReview = await agent(
    `Review the implementation of the LLD at ${lldPath}.

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
        `The code reviewer found issues:

${issues || codeReview.summary}

Fix these issues in the code. The LLD is at ${lldPath} — reference it if needed.
After fixing:
- Run npm run build (must pass)
- Run npm test (must pass)
- Run npm run lint:fix`,
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
  return { status: "failed", phase: "code-review", lldPath };
}

// Phase 6: QA (with retry loop back to implementer)
phase("QA");
let qaApproved = false;
let qaAttempts = 0;
const MAX_QA_ATTEMPTS = 3;

while (!qaApproved && qaAttempts < MAX_QA_ATTEMPTS) {
  qaAttempts++;

  const qaResult = await agent(
    `Validate the implementation of the LLD at ${lldPath}.

Check the changed files (run: git diff main --stat, then read relevant ones).

${qaAttempts > 1 ? "This is a re-check after the implementer addressed prior QA feedback. Verify the fixes." : ""}

Return your verdict.`,
    {
      label: `qa-${qaAttempts}`,
      model: "opus",
      agentType: "qa",
      schema: QA_SCHEMA,
    },
  );

  if (qaResult.verdict === "APPROVED") {
    qaApproved = true;
    log(`QA: APPROVED`);
  } else {
    log(`QA: CHANGES REQUESTED (attempt ${qaAttempts}/${MAX_QA_ATTEMPTS})`);

    if (qaAttempts < MAX_QA_ATTEMPTS) {
      await agent(
        `QA found issues with the feature:

${qaResult.issues ? qaResult.issues.join("\n") : qaResult.summary}

Fix these issues. The LLD is at ${lldPath} and the CX doc is at docs/customer-experience.md — reference them if needed.
After fixing:
- Run npm run build (must pass)
- Run npm test (must pass)
- Run npm run lint:fix`,
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
  return { status: "failed", phase: "qa", lldPath };
}

// Phase 7: Ship (commit, push, PR)
phase("Ship");
const shipResult = await agent(
  `Ship the implementation. The work is on branch ${context.branchName}.

Steps:
1. git add all changed/new files (be specific — don't use git add -A)
2. Commit with a good message following the project's style (see git log --oneline -5)
   - Format: short imperative summary + body explaining why
   - Reference the LLD number
3. Push: git push -u origin ${context.branchName}
4. Create PR: gh pr create --title "..." --body "..."
   - Title: short, under 70 chars
   - Body: ## Summary (3-5 bullets), ## Test plan (checklist)
   ${typeof input === "number" || (typeof input === "string" && /^\d+$/.test(input)) ? `- Include "Closes #${input}" in the body` : ""}

Return the PR URL and commit message.`,
  { label: "ship", schema: SHIP_SCHEMA },
);

log(`PR raised: ${shipResult.prUrl}`);

return {
  status: "success",
  issueTitle: context.issueTitle,
  lldPath,
  branchName: context.branchName,
  prUrl: shipResult.prUrl,
};
