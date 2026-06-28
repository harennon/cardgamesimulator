# CLAUDE.md

Multiplayer card game simulator — hosts preset card games (Big2 first, Tonk later).

## Project Structure

- `src/backend/` — Express 5 API + Socket.IO server (TypeScript, compiled with ts-patch)
- `src/frontend/` — Vue 3 SPA (TypeScript, built with Vite)
- `src/shared/` — Types and utilities shared between frontend and backend
- `supabase/migrations/` — SQL migrations applied by the Supabase CLI (`supabase start`)
- `docker-compose.yml` — nginx frontend + Express backend, joined to an external Supabase network (Postgres + Auth run via the Supabase CLI)

## Tech Stack (Current)

- **Backend:** Express 5, Socket.IO, Supabase (`@supabase/supabase-js` + Supabase Postgres), JWT auth (verifies Supabase-issued tokens via JWKS; guest tokens signed with `SUPABASE_JWT_SECRET`)
- **Frontend:** Vue 3, Vue Router, Vite, Axios, Socket.IO client
- **Shared:** TypeScript with path aliases (`@/*` → `./src/*`)
- **Infra:** Docker Compose (nginx reverse proxy, express) + Supabase (external network, started via the Supabase CLI)

**Migration complete:** Auth + DB are on Supabase and real-time is on Socket.IO (formerly TypeORM/standalone Postgres + SSE). See `docs/execution-plan.md`.

## Required Reading

- `DEVELOPMENT.md` — **Read before any implementation.** Commands, conventions, workflow, environment setup.
- `docs/architecture-principles.md` — Server-authoritative state, pure game engine, information hiding, in-memory caching, deploy cheap.
- `docs/testing-principles.md` — Pure function tests, controlled randomness, self-contained tests, invariant checks.
- `docs/project-hld.md` — High-level architecture and design decisions.
- `docs/execution-plan.md` — Phased work breakdown with dependencies.
- `docs/customer-experience.md` — User flows and wireframes.

## Agent Routing

**STOP. Before implementing any LLD, reviewing any design, or writing any code — check the routing table below. If the task matches a trigger, you MUST delegate immediately. Do not read source files, do not gather context, do not "understand first." Dispatch to the agent with the task description and acceptance criteria. The subagent will read what it needs.**

| Trigger                                                  | Agent                |
| -------------------------------------------------------- | -------------------- |
| Design / write an LLD                                    | `architect`          |
| Frontend UI design, layout, mockups, component specs     | `frontend-architect` |
| Review an LLD before implementation                      | `design-reviewer`    |
| Implement / build from an approved LLD                   | `implementer`        |
| Review code after implementation                         | `code-reviewer`      |
| Verify UX / test against CX doc                          | `qa`                 |
| Decide what to build next / prioritize / scope questions | `ceo`                |

Follow the workflow: **ceo → architect → design-reviewer → implementer → code-reviewer → qa**. Never do routable work inline.

**Frontend UI workflow:** For any LLD that changes visual UI, the `frontend-architect` must produce HTML mockups (served on port 8090) for user review **before** the LLD is finalized. The user approves the visual direction first, then the LLD is written to match, then implementation follows. Do not skip the mockup step and go straight to LLD text specs.

## Commit Requirements

Update `CHANGELOG.md` only for major milestones (LLD implementations, significant features). Not required for every commit.
