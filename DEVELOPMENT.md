# Development Guide

Read this before implementing anything in this project.

---

## Before You Code

1. **Check the execution plan** (`docs/execution-plan.md`) — know which phase you're in and what the current LLD covers.
2. **Read the relevant LLD** — if one exists for your work, follow it. If it doesn't exist yet, write it first.
3. **Follow the principles** — architecture and testing decisions are in `docs/architecture-principles.md` and `docs/testing-principles.md`. These are mandatory, not advisory.

---

## Development Workflow

### Personas

Each phase of work is handled by a different persona (defined in `.claude/agents/`). No single agent designs, implements, AND reviews its own work.

| Persona             | Role                                                | When                                                             |
| ------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| **CEO**             | Strategic decisions, priorities, vision alignment   | Deciding what to build, evaluating tradeoffs, changing direction |
| **Architect**       | Writes LLDs (low-level design docs)                 | Before implementation begins                                     |
| **Design Reviewer** | Reviews LLDs against principles and HLD             | After LLD is written, before implementation                      |
| **Implementer**     | Writes code and tests against an approved LLD       | After LLD is approved                                            |
| **Code Reviewer**   | Reviews implementation for correctness and security | After code is written                                            |
| **QA**              | Validates features against CX doc and user flows    | After implementation, before merge                               |

### How to Invoke Personas

Personas are invoked by name in conversation. Examples:

```
"Use the architect to write the LLD for the WebSocket layer"
"Use the design-reviewer to review docs/lld/03-websocket-layer.md"
"Use the implementer to build the Big2 engine from docs/lld/04-big2-engine.md"
"Use the code-reviewer to review the Big2 engine implementation"
"Use the qa to validate the game lobby against the CX doc"
"Use the ceo to decide what we should build next"
```

You (the developer) are the orchestrator. You decide when to invoke each persona and when to move to the next step.

### Communication Between Personas

Personas communicate through **files in the repo** — not through conversation memory. Each persona's output becomes the next persona's input.

```
CEO                         → docs/execution-plan.md (what to build next)
                                    ↓
Architect                   → docs/lld/NN-feature-name.md (design spec)
                                    ↓
Design Reviewer             → verdict in conversation (APPROVED or CHANGES REQUESTED)
                                    ↓ (if changes requested, back to Architect)
Implementer                 → src/ code + tests/ (implementation)
                                    ↓
Code Reviewer               → verdict in conversation (APPROVED or CHANGES REQUESTED)
                                    ↓ (if changes requested, back to Implementer)
QA                          → verdict in conversation (PASS or FAIL with issues)
                                    ↓ (if fail, back to Implementer)
Commit
```

**What each persona reads and writes:**

| Persona         | Reads                                                                                      | Writes                                  |
| --------------- | ------------------------------------------------------------------------------------------ | --------------------------------------- |
| CEO             | HLD, CX doc, execution plan, feedback/data                                                 | Updates to HLD, CX doc, execution plan  |
| Architect       | HLD, execution plan, architecture principles, existing code, **direct upstream LLDs**      | `docs/lld/*.md`                         |
| Design Reviewer | LLD under review, architecture + testing principles, HLD, CX doc, **direct upstream LLDs** | Verdict (approve/reject with specifics) |
| Implementer     | Approved LLD, DEVELOPMENT.md, existing code                                                | `src/` code, `tests/`, CHANGELOG.md     |
| Code Reviewer   | Implementation diff, LLD, architecture + testing principles                                | Verdict (approve/reject with specifics) |
| QA              | CX doc, running app or implementation code                                                 | QA report (pass/fail with specifics)    |

**Direct upstream LLDs** = only the LLDs listed in the "depends on:" field of the execution plan for the current work item. Not transitive — e.g., LLD 6 reads LLDs 3, 4, 5 but not also 1, 2. This keeps context bounded (typically 1–3 docs).

### Escalation Protocol

When a persona encounters something outside their domain, they report it rather than handling it themselves:

| Persona         | Escalates to    | When                                                          |
| --------------- | --------------- | ------------------------------------------------------------- |
| CEO             | Architect       | Needs technical feasibility check                             |
| CEO             | Design Reviewer | Needs to know if a decision violates principles               |
| Architect       | CEO             | CX flow is unclear, or decision requires strategic tradeoff   |
| Design Reviewer | CEO             | LLD conflicts with CX doc, or scope question undecided        |
| Implementer     | Architect       | LLD is ambiguous or seems wrong                               |
| Implementer     | Code Reviewer   | Security concern discovered during implementation             |
| Code Reviewer   | Architect       | LLD itself is flawed (code correctly implements a bad design) |
| Code Reviewer   | QA              | Spots a UX concern that needs CX validation                   |
| QA              | Implementer     | Feature doesn't match CX spec                                 |
| QA              | CEO             | CX doc itself seems wrong or incomplete                       |
| QA              | Code Reviewer   | Suspects security/information leakage                         |

In practice: when a persona escalates, they state what they found, who should handle it, and why it's outside their domain. You then invoke the relevant persona to resolve it.

### Workflow per Feature

```
1. CEO decides what to build next (references CX doc + execution plan)
       ↓
2. Architect writes LLD → saves to docs/lld/
       ↓
3. Design Reviewer validates LLD
       ↓ (approved or iterate with Architect)
4. Implementer codes against approved LLD → saves to src/ and tests/
       ↓
5. Code Reviewer checks implementation
       ↓ (approved or iterate with Implementer)
6. QA validates against CX doc and edge cases
       ↓ (pass or iterate with Implementer)
7. Commit + update CHANGELOG.md
```

### Separation of Concerns

No persona does another's job:

- The **CEO** does NOT write LLDs or code — they decide what and why, not how.
- The **Architect** does NOT write code — they write specifications.
- The **Implementer** does NOT make design decisions — if the LLD is ambiguous, it goes back to the Architect.
- The **Code Reviewer** does NOT rewrite code — they identify issues for the Implementer to fix.
- The **QA** does NOT fix issues — they report them. If the CX spec is wrong, they flag it for the CEO.

### Committing

Every commit must include an update to `CHANGELOG.md`. Add your entry under `[Unreleased]` in the appropriate category (Added/Changed/Fixed/Removed). This is not optional.

### Testing

- Engine logic: run `npm test` (Vitest, once configured)
- Build check: `npm run build` must pass with zero errors
- Lint: `npm run lint:fix` before committing
- Manual test: for UI changes, run `docker compose up` and verify in browser

### Iterating on Workflows

The orchestration workflows live in `.claude/workflows/` (`ship-batch`, `ship-issue`, `triage-feedback`).

**Gotcha when testing edits in an interactive session:** launching by name (`/ship-batch` or `Workflow({name: "ship-batch"})`) runs the version from the skill registry, which only refreshes on session start / skill reload — **not** on every launch. So edits you just made on disk may not run. When iterating within a session, launch by file path instead so the current file is always used:

```
Workflow({ scriptPath: "/absolute/path/to/.claude/workflows/ship-batch.js" })
```

The scheduled (cron) runs are unaffected: each `claude -p "/ship-batch"` invocation is a fresh session that reads the workflow files from disk at startup, so committed/working-tree edits are picked up automatically.

---

## Architecture Rules (Quick Reference)

These are non-negotiable. Full rationale in `docs/architecture-principles.md`.

| Rule                  | What it means                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------- |
| Server-authoritative  | ALL game logic on the server. Client renders and sends choices.                             |
| Pure engine           | Engine functions: `(state, action) → newState`. No I/O, no DB, no network.                  |
| Information hiding    | `getPlayerView()` physically excludes hidden data. Never send full state to a client.       |
| Injectable randomness | All randomness through a seeded PRNG. Never `Math.random()` in game logic.                  |
| In-memory cache       | Active games live in memory. DB is for durability, not hot-path reads.                      |
| validActions is law   | Client enables/disables UI based on `validActions`. Server rejects anything not in the set. |

---

## Testing Rules (Quick Reference)

Full rationale in `docs/testing-principles.md`.

| Rule                      | What it means                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------- |
| Pure function tests       | Test engine directly — no server, no DB, no WebSocket in engine tests.              |
| Control randomness        | Use seeded PRNG or disable shuffle. Tests must be deterministic.                    |
| Self-contained tests      | Each test creates its own state. No shared `beforeEach` game state.                 |
| Direct state manipulation | Use helpers to set preconditions. Don't replay 20 moves to reach a state.           |
| Test invalid actions      | Every valid action has a corresponding "rejected when invalid" test.                |
| Invariant checks          | Assert: total cards constant, no deadlocks, valid turn player — after every action. |
| Information leakage tests | Assert `getPlayerView(state, A)` never contains B's hand.                           |

---

## File Organization

```
src/
  backend/
    engine/          — Game engines (pure logic, no I/O)
    api/             — REST endpoint handlers
    websocket/       — Socket.IO layer (thin — routes messages, manages rooms)
    database/        — TypeORM entities and repository
    middleware/      — Auth verification, error handling
    service/         — Business logic services
  frontend/
    component/       — Vue components
    composables/     — Reactive state (useSocket, useGameState, useGameActions)
    service/         — API client services
  shared/            — Types and utilities shared between frontend and backend

docs/                — Design documentation (HLD, principles, CX, execution plan)
tests/               — Test files (mirrors src/ structure by concept)
```

---

## Key Conventions

- **Path aliases:** `@/*` → `src/*` for cross-module imports
- **Strict TypeScript:** `strict: true`, `alwaysStrict: true`, no `any` without justification
- **ESNext + NodeNext:** modern syntax, proper ESM resolution
- **No comments unless non-obvious:** code should be self-documenting. Comment the _why_, never the _what_.
- Backend uses TypeORM entities in `src/backend/database/entities.ts`
- Frontend components live in `src/frontend/component/`

---

## Commands

```bash
npm run build            # Build both frontend and backend
npm run build:frontend   # vue-tsc type-check + vite build
npm run build:backend    # tspc (ts-patch) compile
npm run start            # Clean, lint, build, then start backend
npm run dev              # Build backend + start backend & vite dev server (LAN-accessible)
npm run lint:fix         # ESLint with auto-fix (ts + vue)
docker compose up        # Run full stack with database
```

---

## Mobile Testing

### Setup

`npm run dev` starts both the backend and Vite dev server with `--host` (binds to `0.0.0.0`). Any device on the same network can access the app via `http://<machine-ip>:5173`.

If developing on a remote machine (e.g. Cloud Desktop), tunnel port 5173 to a machine on the same WiFi as your phone, then expose it on the LAN:

```powershell
# Windows — re-expose a localhost-bound tunnel on all interfaces
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=5173 connectaddress=127.0.0.1 connectport=5173
netsh advfirewall firewall add rule name="Vite Dev" dir=in action=allow protocol=TCP localport=5173
```

If Supabase auth is needed on the phone, also tunnel port 54321 and set `VITE_SUPABASE_URL=http://<lan-ip>:54321` in `.env`.

### Debug Overlay

Add `?debug` to any game URL to enable the on-screen debug overlay (dev builds only, tree-shaken from production).

```
http://<ip>:5173/game/<id>?debug
```

The overlay shows:
- **Current card selection state** — which indices are selected
- **Timestamped event log** (mm:ss.ms precision):
  - Pink = touch/click events (when the browser fired them)
  - Green = reactive state changes (when Vue updated)
  - Yellow = info events (turn changes)

Tap the "DBG" header to collapse/expand. Compare pink and green timestamps to diagnose animation timing issues.

---

## Environment Setup

### Local Development

```bash
# Install dependencies
npm install

# Start Supabase local stack
supabase start

# Start backend + frontend dev server
npm run dev

# Or run full stack via Docker
docker compose up
```

### Required Environment Variables

Copy `.env.example` to `.env` and fill in:

**Current (pre-migration):**

- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` — database credentials
- `BACKEND_PORT` — Express server port (default 3000)

**Post-migration (Supabase):**

- `SUPABASE_URL` — local: `http://localhost:54321`, prod: your Supabase project URL
- `SUPABASE_ANON_KEY` — from Supabase dashboard or `supabase status`
- `SUPABASE_SERVICE_ROLE_KEY` — for backend-only operations

---

## When in Doubt

1. Check if a principle doc answers your question
2. Check if the relevant LLD specifies an approach
3. If neither helps, prefer the simpler option that doesn't prevent future change
4. Ask before building something the principles would have to be updated to justify
