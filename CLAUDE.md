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

## Commit Requirements

Every commit must include an update to `CHANGELOG.md` under `[Unreleased]`. No exceptions.
