# CLAUDE.md

Multiplayer card game simulator — hosts preset card games (Big2 first, Tonk later).

## Project Structure

- `src/backend/` — Express 5 API server (TypeScript, compiled with ts-patch)
- `src/frontend/` — Vue 3 SPA (TypeScript, built with Vite)
- `src/shared/` — Types and utilities shared between frontend and backend
- `docker-compose.yml` — Full stack: nginx frontend, Express backend, PostgreSQL 17

## Tech Stack (Current)

- **Backend:** Express 5, TypeORM, PostgreSQL, JWT auth (argon2 for passwords)
- **Frontend:** Vue 3, Vue Router, Vite, Axios
- **Shared:** TypeScript with path aliases (`@/*` → `./src/*`)
- **Infra:** Docker Compose (nginx reverse proxy, express, postgres)

**Planned migration:** Auth + DB moving to Supabase, SSE replacing with Socket.IO. See `docs/execution-plan.md`.

## Required Reading

- `DEVELOPMENT.md` — **Read before any implementation.** Commands, conventions, workflow, environment setup.
- `docs/architecture-principles.md` — Server-authoritative state, pure game engine, information hiding, in-memory caching, deploy cheap.
- `docs/testing-principles.md` — Pure function tests, controlled randomness, self-contained tests, invariant checks.
- `docs/project-hld.md` — High-level architecture and design decisions.
- `docs/execution-plan.md` — Phased work breakdown with dependencies.
- `docs/customer-experience.md` — User flows and wireframes.

## Agent Routing

**STOP. Before implementing any LLD, reviewing any design, or writing any code — check the routing table below. If the task matches a trigger, you MUST delegate immediately. Do not read source files, do not gather context, do not "understand first." Dispatch to the agent with the task description and acceptance criteria. The subagent will read what it needs.**

| Trigger | Agent |
|---------|-------|
| Design / write an LLD | `architect` |
| Review an LLD before implementation | `design-reviewer` |
| Implement / build from an approved LLD | `implementer` |
| Review code after implementation | `code-reviewer` |
| Verify UX / test against CX doc | `qa` |
| Decide what to build next / prioritize / scope questions | `ceo` |

Follow the workflow: **ceo → architect → design-reviewer → implementer → code-reviewer → qa**. Never do routable work inline.

## Commit Requirements

Update `CHANGELOG.md` only for major milestones (LLD implementations, significant features). Not required for every commit.
