export const meta = {
  name: "propose-features",
  description:
    "Brainstorm ONE high-value feature/improvement and open it as a review-gated proposal issue",
  whenToUse:
    "Run daily. Independent of user feedback — researches comparable card-game apps and critiques our own play/UX to propose ONE idea per run as a `proposal`-labeled GitHub issue for human review. Also refines existing proposals when a human leaves feedback comments. Approved proposals (human removes `proposal`, adds `triage:fix`) become eligible for ship-batch; rejected ones are closed.",
  phases: [
    {
      title: "Revise",
      detail:
        "Refine existing open proposals that have unaddressed human feedback",
    },
    {
      title: "Ideate",
      detail:
        "Generate candidate ideas via web/competitor research + play/UX critique",
    },
    {
      title: "Select",
      detail: "CEO picks the single best, novel, product-aligned idea",
      model: "opus",
    },
    {
      title: "Create",
      detail: "Dedup against the backlog, then open one proposal issue",
    },
  ],
};

// Headless permission matching is prefix-based and cannot decompose shell
// constructs: a `for n in ...; do gh issue view $n; done` loop does NOT start
// with "gh", so it fails to match the `Bash(gh *)` allow rule and gets denied
// mid-run. Individual `gh issue view <number>` calls match cleanly.
const GH_NO_LOOP =
  "IMPORTANT: issue these gh commands as SEPARATE, individual calls — one `gh issue view <number> ...` invocation per issue. Do NOT wrap them in a `for` loop or chain them with `&&`/`;`; loop-wrapped commands are denied by the headless permission gate and will fail.";

// Model for pure-mechanical "glue" agents that run a fixed gh command and make
// no judgment. Must be a fully-qualified Bedrock id (a bare alias 400s). Haiku
// uses the "-v1:0" suffix, NOT "[1m]". Mirrors ship-batch's MECH_MODEL.
const MECH_MODEL = "global.anthropic.claude-haiku-4-5-20251001-v1:0";

// Stable marker embedded (as an invisible HTML comment) in the proposal body
// and in every comment this workflow posts. Lets the Revise phase distinguish
// the workflow's own comments from a human's: if a proposal's LAST comment does
// NOT contain this marker, a human left unaddressed feedback → revise. After
// revising we post a marker comment, so the last comment is ours again and the
// proposal won't re-trigger until the human replies. Mirrors ship-batch's
// "last comment" unblock heuristic.
const MARKER = "<!-- propose-features-bot -->";

// Informational threshold only. The user chose "1 best idea per run" (not a
// backlog cap), so we always create one — but if unreviewed proposals are
// piling up (daily cron, no same-day-review guarantee), we LOG a nudge to
// review/close some. Flip WARN_ONLY to false if you later want it to actually
// skip generation when the backlog is full.
const PROPOSAL_BACKLOG_NUDGE = 5;
const WARN_ONLY = true;

// How many candidate ideas each generator should return.
const IDEAS_PER_GENERATOR = 3;

// --- Schemas ---

const IDEAS_SCHEMA = {
  type: "object",
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "Short, concrete, actionable feature/improvement title",
          },
          pitch: {
            type: "string",
            description: "1-2 sentences: what it is and the player value",
          },
          rationale: {
            type: "string",
            description:
              "Why it's worth doing — evidence from research or the observed UX friction it removes",
          },
          category: {
            type: "string",
            enum: ["feature-request", "improvement"],
          },
        },
        required: ["title", "pitch", "rationale", "category"],
      },
    },
  },
  required: ["ideas"],
};

const SELECTION_SCHEMA = {
  type: "object",
  properties: {
    picked: {
      type: "boolean",
      description:
        "True if a worthwhile, novel, product-aligned idea was selected; false if nothing cleared the bar this run",
    },
    title: { type: "string", description: "Final proposal title (if picked)" },
    body: {
      type: "string",
      description:
        "Full GitHub issue body (markdown): Proposal, Why it's valuable, Player experience, Rough scope, Open questions, Acceptance criteria. If picked.",
    },
    category: {
      type: "string",
      enum: ["feature-request", "improvement"],
    },
    priority: {
      type: "string",
      enum: ["high", "medium", "low"],
    },
    reasoning: {
      type: "string",
      description:
        "Why this idea over the others (or why nothing was picked this run)",
    },
  },
  required: ["picked", "reasoning"],
};

const DEDUP_SCHEMA = {
  type: "object",
  properties: {
    isDuplicate: {
      type: "boolean",
      description:
        "True if an existing open/closed issue or open proposal already covers this idea",
    },
    existingIssue: {
      type: "integer",
      description: "The number of the duplicate issue, if isDuplicate",
    },
    reason: { type: "string" },
  },
  required: ["isDuplicate", "reason"],
};

const PROPOSALS_SCHEMA = {
  type: "object",
  properties: {
    openCount: {
      type: "integer",
      description: "Total number of open issues carrying the 'proposal' label",
    },
    needsRevision: {
      type: "array",
      items: {
        type: "object",
        properties: {
          number: { type: "integer" },
          title: { type: "string" },
          feedback: {
            type: "string",
            description:
              "The human feedback text to incorporate (verbatim or summarized) from comments posted after the workflow's last marker comment",
          },
        },
        required: ["number", "title", "feedback"],
      },
      description:
        "Open proposals whose LAST comment is human feedback not yet addressed by the workflow",
    },
  },
  required: ["openCount", "needsRevision"],
};

const REVISION_SCHEMA = {
  type: "object",
  properties: {
    revisedBody: {
      type: "string",
      description: "The full rewritten issue body incorporating the feedback",
    },
    changeSummary: {
      type: "string",
      description: "1-3 sentences describing what changed and why",
    },
  },
  required: ["revisedBody", "changeSummary"],
};

// --- Helpers ---

// Read the product context every judgment agent needs, expressed as a reusable
// instruction block so the wording stays consistent across generators/selector.
const PRODUCT_CONTEXT = `## Product context — read before proposing
This is a hobby-scale multiplayer card-game simulator (Big2 shipped; Tonk in progress). Core principles: server-authoritative state, a pure/deterministic game engine, information hiding (never leak a player's hand), and "deploy cheap" (avoid new paid infra).
- Read docs/customer-experience.md for the intended user flows and wireframes.
- Read docs/execution-plan.md and docs/project-hld.md for scope, phase, and strategic direction.
- Skim src/frontend/component/ and src/frontend/component/game-ui/ to see what the UI actually does today.
Propose things that FIT this product and its principles — not generic SaaS features. Favor ideas that improve the actual card-game experience.`;

// --- Workflow ---

// =========================================================================
// Phase 1: Revise existing proposals that have unaddressed human feedback.
// This is the feedback loop — a human comments on a proposal, and the next
// run refines it in place (staying in `proposal`) rather than ignoring it.
// =========================================================================
phase("Revise");

const scan = await agent(
  `Find open GitHub issues labeled "proposal" that have unaddressed human feedback.

Step 1 — List open proposals:
  gh issue list --state open --label "proposal" --json number,title --limit 30

Step 2 — For EACH proposal, read its comments (most recent last):
  gh issue view <number> --json comments --jq '.comments'
  ${GH_NO_LOOP}

Step 3 — Decide which need revision:
  Every comment THIS workflow posts contains the exact marker string "${MARKER}" (an invisible HTML comment). A human's comment will NOT contain it.
  - A proposal NEEDS REVISION if its LAST comment is a human comment (does NOT contain "${MARKER}"). That means the human left feedback the workflow has not yet addressed.
  - If a proposal has no comments, or its LAST comment contains "${MARKER}" (the workflow already responded), it does NOT need revision — skip it.
  For each proposal that needs revision, set "feedback" to the human's feedback text (from all human comments posted after the workflow's most recent marker comment).

Also return openCount = the total number of open issues with the "proposal" label (from Step 1).

Do NOT edit or comment on anything. Only read and classify.`,
  { label: "scan-proposals", schema: PROPOSALS_SCHEMA },
);

const openProposalCount = scan ? scan.openCount || 0 : 0;
const needsRevision = scan ? scan.needsRevision || [] : [];

if (needsRevision.length > 0) {
  log(
    `Revising ${needsRevision.length} proposal(s) with new human feedback: ${needsRevision.map((p) => `#${p.number}`).join(", ")}`,
  );

  await parallel(
    needsRevision.map(
      (p) => () =>
        agent(
          `A human left feedback on proposal issue #${p.number} ("${p.title}"). Revise the proposal to incorporate it.

Human feedback:
"${p.feedback}"

Steps:
1. Read the current proposal in full: gh issue view ${p.number} --json title,body
2. ${PRODUCT_CONTEXT.split("\n")[0]}
3. Rewrite the issue body to address the feedback — sharpen scope, adjust direction, answer open questions, or add/remove sections as the feedback directs. Keep the same structure (Proposal, Why it's valuable, Player experience, Rough scope, Open questions, Acceptance criteria). Preserve the "${MARKER}" marker somewhere in the body.

Return the revised body and a short change summary.`,
          { label: `revise-${p.number}`, schema: REVISION_SCHEMA },
        ).then(async (rev) => {
          if (!rev) return;
          // Write the revised body and post a marker comment so this proposal
          // stops re-triggering until the human replies again.
          await agent(
            `Update proposal issue #${p.number} with a revised body, then comment.

1. Write the revised body (heredoc):
gh issue edit ${p.number} --body "$(cat <<'PROPBODY'
${rev.revisedBody}
PROPBODY
)"

2. Post a revision comment (heredoc):
gh issue comment ${p.number} --body "$(cat <<'PROPCOMMENT'
🤖 **Proposal revised per your feedback.**

${rev.changeSummary}

_Reply with more feedback to refine further · remove the \`proposal\` label and add \`triage:fix\` to approve for ship-batch · close to reject._
${MARKER}
PROPCOMMENT
)"`,
            { label: `apply-revision-${p.number}`, model: MECH_MODEL },
          );
        }),
    ),
  );
} else {
  log("No proposals need revision this run.");
}

// Backlog nudge: always produce one idea per run (per the chosen policy), but
// surface a reminder when unreviewed proposals are stacking up.
if (openProposalCount >= PROPOSAL_BACKLOG_NUDGE) {
  log(
    `Heads up: ${openProposalCount} open proposals are awaiting your review — consider approving or closing some.`,
  );
  if (!WARN_ONLY) {
    log("WARN_ONLY is off — skipping new-idea generation this run.");
    return {
      status: "skipped-backlog-full",
      openProposals: openProposalCount,
      revised: needsRevision.map((p) => p.number),
    };
  }
}

// =========================================================================
// Phase 2: Ideate. Generate candidates from two lenses the user chose:
// (a) web/competitor research, (b) play-as-a-player UX critique. Ground both
// against the existing backlog so we don't re-propose known work.
// =========================================================================
phase("Ideate");

// Fetch existing issue + proposal titles once, to hand to every generator so
// they avoid re-proposing something already tracked.
const backlog = await agent(
  `Gather existing GitHub issue titles so we avoid proposing duplicates.
Run these and return a deduplicated list of titles (open and closed), plus the titles already carrying the "proposal" label:
  gh issue list --state all --json number,title,labels --limit 100
Return every issue as "number | title | comma-separated-labels".`,
  {
    label: "fetch-backlog",
    model: MECH_MODEL,
    schema: {
      type: "object",
      properties: {
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              number: { type: "integer" },
              title: { type: "string" },
              labels: { type: "array", items: { type: "string" } },
            },
            required: ["number", "title"],
          },
        },
      },
      required: ["issues"],
    },
  },
);

const backlogList = backlog && backlog.issues ? backlog.issues : [];
const backlogTitles =
  backlogList.map((i) => `#${i.number} ${i.title}`).join("\n") ||
  "(could not fetch — search before creating)";

// Two research lenses + two critique lenses. Each is blind to the others so the
// idea pool stays diverse (multi-modal sweep).
const GENERATORS = [
  {
    key: "web-social",
    prompt: `## Idea generator — competitor/web research (engagement & social)
Use WebSearch/WebFetch to research how comparable online card-game apps (Big2, Tonk, rummy, hearts, UNO-likes, poker-lite social apps) handle engagement, social play, replayability, and retention. Then propose ${IDEAS_PER_GENERATOR} concrete ideas ADAPTED to our product (not copied wholesale).`,
  },
  {
    key: "web-onboarding",
    prompt: `## Idea generator — competitor/web research (onboarding & clarity)
Use WebSearch/WebFetch to research how comparable online card-game apps handle onboarding, teaching rules, in-game clarity, spectating, and quality-of-life. Then propose ${IDEAS_PER_GENERATOR} concrete ideas ADAPTED to our product.`,
  },
  {
    key: "ux-ingame",
    prompt: `## Idea generator — play-as-a-player UX critique (in-game)
Do NOT web search. Reason as a player actually playing a hand. Walk the in-game flow (join → deal → take turns → round/game end). Name concrete friction, missing feedback, or quality-of-life gaps, and propose ${IDEAS_PER_GENERATOR} improvements that remove them.`,
  },
  {
    key: "ux-flow",
    prompt: `## Idea generator — play-as-a-player UX critique (lobby & meta)
Do NOT web search. Reason as a player around the game: creating/joining a lobby, waiting for players, matchmaking, post-game (rematch, stats, sharing). Name concrete friction and propose ${IDEAS_PER_GENERATOR} improvements.`,
  },
];

const generated = await parallel(
  GENERATORS.map(
    (g) => () =>
      agent(
        `${g.prompt}

${PRODUCT_CONTEXT}

## Avoid duplicates — these issues already exist (do NOT re-propose):
${backlogTitles}

Return ${IDEAS_PER_GENERATOR} distinct, concrete ideas. Each must be specific enough to act on (not "improve the UI"). Prefer ideas that respect "deploy cheap" (no new paid infra) and information hiding.`,
        { label: `ideate:${g.key}`, phase: "Ideate", schema: IDEAS_SCHEMA },
      ),
  ),
);

const allIdeas = generated.filter(Boolean).flatMap((r) => r.ideas || []);

if (allIdeas.length === 0) {
  log("No ideas generated this run.");
  return { status: "no-ideas", openProposals: openProposalCount };
}

log(
  `Generated ${allIdeas.length} candidate ideas across ${GENERATORS.length} lenses.`,
);

// =========================================================================
// Phase 3: Select the single best idea (CEO lens — value + alignment).
// =========================================================================
phase("Select");

const selection = await agent(
  `You are choosing the SINGLE best idea to propose to the product owner for review. Only one will be created this run.

## Candidate ideas
${allIdeas
  .map(
    (idea, i) =>
      `${i + 1}. [${idea.category}] ${idea.title}\n   Pitch: ${idea.pitch}\n   Rationale: ${idea.rationale}`,
  )
  .join("\n\n")}

## Existing backlog (do NOT pick something already tracked)
${backlogTitles}

${PRODUCT_CONTEXT}

## How to choose
- Highest player value for the effort; aligned with the product's current direction and phase.
- Novel — not already in the backlog above and not a trivial restatement of one.
- Respects the principles (server-authoritative, information hiding, deploy cheap).
- Concrete enough that a human can judge it quickly and, if approved, an architect can design it.

Pick the best ONE. If NOTHING clears the bar (all weak, duplicative, or misaligned), set picked=false — it is fine to propose nothing this run.

If you pick one, write a complete GitHub issue body (markdown) with these sections:
- **Proposal** — what it is
- **Why it's valuable** — the player/product case
- **Player experience** — how it feels in use
- **Rough scope** — what building it roughly touches (not a full design)
- **Open questions** — what the reviewer should weigh in on
- **Acceptance criteria** — what "done" would look like

Set category and priority. Do NOT include the review-instructions footer or any marker — the workflow appends those.`,
  {
    label: "select-proposal",
    phase: "Select",
    model: "opus",
    agentType: "ceo",
    schema: SELECTION_SCHEMA,
  },
);

if (!selection || !selection.picked) {
  log(
    `Nothing proposed this run: ${selection ? selection.reasoning : "selection agent failed"}`,
  );
  return {
    status: "no-selection",
    reasoning: selection ? selection.reasoning : null,
    openProposals: openProposalCount,
    revised: needsRevision.map((p) => p.number),
  };
}

log(
  `Selected: "${selection.title}" (${selection.category}/${selection.priority}) — ${selection.reasoning}`,
);

// =========================================================================
// Phase 4: Dedup the winner against the backlog, then create ONE proposal.
// =========================================================================
phase("Create");

const dedup = await agent(
  `Check whether this proposed idea duplicates an existing issue before we create it.

## Proposed
Title: "${selection.title}"
Category: ${selection.category}

## Steps
1. gh issue list --state all --search "${selection.title.split(" ").slice(0, 5).join(" ")}" --json number,title,state,labels --limit 15
2. gh issue list --state all --search "${(selection.title.match(/\b\w{4,}\b/g) || []).slice(0, 3).join(" ")}" --json number,title,state,labels --limit 15
3. Decide: does an existing OPEN issue, recently-CLOSED issue, or existing "proposal" cover the SAME idea?

Return isDuplicate + the existing issue number (if any) + a one-line reason.`,
  { label: "dedup-proposal", phase: "Create", schema: DEDUP_SCHEMA },
);

if (dedup && dedup.isDuplicate) {
  log(
    `Skipping — duplicate of #${dedup.existingIssue || "?"}: ${dedup.reason}`,
  );
  return {
    status: "skipped-duplicate",
    duplicateOf: dedup.existingIssue || null,
    title: selection.title,
    openProposals: openProposalCount,
    revised: needsRevision.map((p) => p.number),
  };
}

const created = await agent(
  `Create a review-gated proposal issue.

gh issue create --title "${selection.title}" --body "$(cat <<'PROPBODY'
${selection.body}

---
🤖 **Auto-generated proposal — awaiting human review.**

This idea was generated by the \`propose-features\` workflow. It is **not** eligible for ship-batch until a human approves it.
- **Approve:** remove the \`proposal\` label and add \`triage:fix\` — it then enters the normal ship pipeline.
- **Refine:** reply with a comment; the next run will revise this proposal in place.
- **Reject:** close the issue.
${MARKER}
PROPBODY
)" --label "proposal" --label "${selection.category}" --label "priority:${selection.priority}"

Return the URL of the created issue.`,
  { label: "create-proposal", phase: "Create", model: MECH_MODEL },
);

log(`Created proposal: "${selection.title}"`);

return {
  status: "complete",
  title: selection.title,
  category: selection.category,
  priority: selection.priority,
  reasoning: selection.reasoning,
  createdRaw: created,
  openProposalsBefore: openProposalCount,
  revised: needsRevision.map((p) => p.number),
};
