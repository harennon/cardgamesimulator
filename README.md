# Card Game Simulator

Multiplayer card game simulator — hosts preset card games (Big2 first, more to follow).

## Tech Stack

- **Frontend:** Vue 3, TypeScript, Vite
- **Backend:** Express 5, TypeScript, Socket.IO (real-time)
- **Database:** PostgreSQL via Supabase (auth + RLS)
- **Infra:** Docker Compose (nginx, express, postgres)

## Quick Start

```bash
# Install dependencies
npm install

# Start Supabase local stack
npx supabase start

# Start backend + frontend dev server
npm run dev
```

The app will be available at `http://localhost:5173`. For mobile device testing, it's also accessible on your LAN.

## Further Reading

- [DEVELOPMENT.md](DEVELOPMENT.md) — commands, conventions, workflow, mobile testing & debug overlay
- [docs/architecture-principles.md](docs/architecture-principles.md) — server-authoritative state, pure game engine, information hiding
- [docs/testing-principles.md](docs/testing-principles.md) — pure function tests, controlled randomness, invariant checks
- [docs/project-hld.md](docs/project-hld.md) — high-level architecture and design decisions
- [docs/execution-plan.md](docs/execution-plan.md) — phased work breakdown
- [docs/customer-experience.md](docs/customer-experience.md) — user flows and wireframes
