# LLD 10: Deployment

## Scope

**Covers:**
- Hosting platform selection (one recommendation, with rationale)
- Production Docker image (single container: Express serving API + static frontend + WebSocket)
- Environment variable configuration for production
- Supabase cloud project setup
- CI/CD pipeline (GitHub Actions: test, build, deploy on push to main)
- Domain and TLS configuration
- Health check endpoint
- Monitoring and error logging basics
- Rollback strategy
- Cost estimate

**Does NOT cover:**
- Horizontal scaling, Redis pub/sub, load balancers (premature per architecture principle 10)
- CDN configuration (not needed for a small playtest group)
- Custom monitoring dashboards or alerting rules
- Database backups (handled by Supabase cloud)
- Mobile app distribution

---

## Hosting Options Comparison

### Pricing Models

| Provider | How They Charge | Min Cost (always-on) | Bandwidth Included | Deploy Experience | WebSocket Support |
|----------|----------------|---------------------|-------------------|-------------------|-------------------|
| **Fly.io** | Pure usage (per-second CPU/RAM). No subscription. | $3-5/mo | Pay per GB ($0.02) | CLI-based (`fly deploy`) | Full support, needs timeout config in `fly.toml` |
| **DO Droplet** | Flat rate per VM size | $4/mo | 500GB | Manual (SSH + scripts) | Perfect (raw VM, no proxy limits) |
| **Hetzner VPS** | Flat rate per VM size | ~$5/mo (EU) | 20TB (EU) / 1TB (US) | Manual (SSH + scripts) | Perfect (raw VM) |
| **DO App Platform** | Flat rate per container tier | $5/mo | 50GB | Auto from GitHub | Works, may need keepalive config |
| **Railway** | $5 subscription + metered CPU/RAM/bandwidth | $7-11/mo | $0.05/GB | Auto from GitHub | Native, no config needed |
| **Render** | Flat rate per tier | $7/mo | 5GB (!!) | Auto from GitHub | Works on paid tier |
| **Heroku** | Flat rate per dyno + add-ons | $7+/mo (realistically $15 with DB) | 2TB | Auto from GitHub | Works, 55s idle timeout |

### Key Considerations for WebSocket Games

- **Persistent connections generate continuous bandwidth** — Render's 5GB cap is a problem for WebSocket apps. The others are fine for 5-20 players.
- **Cold starts kill WebSocket connections** — any tier that sleeps on inactivity (Render free, Heroku Eco) is unsuitable.
- **Socket.IO's ping/pong (25s interval)** handles most proxy idle timeouts (typically 60s). No special config needed on most providers.
- **Single container = no sticky session concerns.** Multi-instance would require Redis adapter for Socket.IO.

### Ranked by Simplicity (for this project)

1. **Railway ($7-11)** — best DX (GitHub push = deployed), zero config for WebSocket, but variable billing
2. **DO App Platform ($5)** — similar DX, flat rate, but limited bandwidth (50GB)
3. **Fly.io ($3-5)** — cheapest managed option, but requires CLI + config file
4. **Hetzner/DO Droplet ($4-5)** — cheapest overall, maximum control, but you manage server + deploys

### Recommendation: TBD

No hosting platform is selected yet. The decision depends on:
- **Lowest cost** → Fly.io ($3-5) or Hetzner VPS ($5)
- **Simplest setup** → Railway ($7-11) or DO App Platform ($5)
- **Zero server management** → Railway, Render, or DO App Platform
- **Maximum control** → Hetzner or DO Droplet

For a playtest with 5-20 users, any of these work. The implementation sections below use generic Docker + environment variable patterns that work on all providers.

---

## Production Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │              Railway                         │
                    │                                             │
 Users ──HTTPS──▶  │  ┌───────────────────────────────────────┐  │
                    │  │  Docker Container (single process)     │  │
                    │  │                                        │  │
                    │  │  Express Server (:3000)                │  │
                    │  │  ├─ /              → static frontend   │  │
                    │  │  ├─ /api/*         → REST endpoints    │  │
                    │  │  ├─ /socket.io/*   → WebSocket (WS)    │  │
                    │  │  └─ /health        → health check      │  │
                    │  │                                        │  │
                    │  └───────────────────────────────────────┘  │
                    │                                             │
                    └─────────────────────────────────────────────┘
                              │                        │
                              │ (Postgres via          │ (Auth API
                              │  connection string)    │  calls)
                              ▼                        ▼
                    ┌──────────────────────────────────────────────┐
                    │            Supabase Cloud                     │
                    │  ┌────────────┐    ┌───────────────────────┐ │
                    │  │  Postgres  │    │  Auth (GoTrue)        │ │
                    │  │  (DB)      │    │  (JWT issuance)       │ │
                    │  └────────────┘    └───────────────────────┘ │
                    └──────────────────────────────────────────────┘
```

**Key design decision: single container, Express serves everything.**

In production, nginx is eliminated. Express serves the built frontend as static files and handles API + WebSocket in the same process. This avoids multi-container coordination and keeps the deployment simple.

---

## Environment Variables

### Production (set in Railway dashboard)

| Variable | Description | Example |
|----------|-------------|---------|
| `NODE_ENV` | Runtime mode | `production` |
| `PORT` | Railway injects this | (auto, typically 3000) |
| `SUPABASE_URL` | Cloud project API URL | `https://xxxx.supabase.co` |
| `SUPABASE_JWT_SECRET` | JWT verification secret (from Supabase project settings > API) | `super-secret-jwt-token-...` |
| `DB_HOST` | Supabase Postgres host | `db.xxxx.supabase.co` |
| `DB_PORT` | Supabase Postgres port | `5432` |
| `DB_USER` | Database user | `postgres` |
| `DB_PASSWORD` | Database password (from Supabase project settings > Database) | `your-db-password` |
| `DB_NAME` | Database name | `postgres` |
| `CORS_ORIGIN` | Allowed origin for Socket.IO | `https://cardgame.yourdomain.com` |
| `FEEDBACK_ADMIN_IDS` | Comma-separated Supabase user IDs for feedback admin access | `uuid1,uuid2` |

### Frontend (baked at build time via Vite)

| Variable | Description | Example |
|----------|-------------|---------|
| `VITE_SUPABASE_URL` | Supabase cloud URL | `https://xxxx.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Public anon key (safe to embed in frontend) | `eyJhbG...` |
| `VITE_API_BASE_URL` | Left empty — same origin in production | (empty string) |

**Note:** `VITE_API_BASE_URL` is empty in production because Express serves both the frontend and API from the same origin. The frontend Socket.IO client already handles this via `io(import.meta.env.VITE_API_BASE_URL || "", {...})`.

---

## Build & Deploy Pipeline

### CI/CD: GitHub Actions

Extend the existing `ci.yml` with a deploy job that runs only on `main` push (after tests pass).

```yaml
# .github/workflows/ci.yml — add this job after existing test jobs

  deploy:
    needs: [unit-tests, integration-tests, e2e-tests]
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install Railway CLI
        run: npm install -g @railway/cli
      - name: Deploy to Railway
        run: railway up --service cardgamesimulator
        env:
          RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}
```

**Workflow:**
1. Push to `main` (or merge PR)
2. CI runs: lint, build, unit tests, integration tests, e2e tests
3. All pass → deploy job triggers
4. Railway CLI pushes the repo; Railway builds the Docker image and deploys

**Secret required:** `RAILWAY_TOKEN` — generated from Railway dashboard > Account Settings > Tokens.

---

## Docker / Container Config

### Production Dockerfile: `Dockerfile.production`

A single multi-stage Dockerfile that produces one container serving everything.

```dockerfile
# Stage 1: Build
FROM node:22.14 AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .

# Frontend env vars must be available at build time
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_API_BASE_URL=

RUN npm run build

# Stage 2: Production runtime
FROM node:22.14-alpine
WORKDIR /app

RUN adduser -S -D -h /app cgs && chown -R cgs:nogroup .

# Copy package files and install production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy build artifacts
COPY --from=builder /app/build ./build

USER cgs

EXPOSE 3000

# Health check (Railway uses this)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "build/backend/index.js"]
```

**Differences from existing backend Dockerfile:**
- Includes frontend build output (`build/frontend/`)
- Uses `--omit=dev` to exclude dev dependencies (smaller image)
- Adds `HEALTHCHECK` instruction
- Does not use `DEBUG=express:*` (noisy in production)
- Runs as non-root user

### Static file serving in Express

The server must serve `build/frontend/` for non-API routes. Changes to `src/backend/server.ts`:

```typescript
import * as path from "path";
import express from "express";

// After all API routes, before error handler:
if (process.env.NODE_ENV === "production") {
  const frontendPath = path.resolve(__dirname, "../frontend");
  this.app.use(express.static(frontendPath));
  // SPA fallback — serve index.html for any unmatched route
  this.app.get("*", (_req, res) => {
    res.sendFile(path.resolve(frontendPath, "index.html"));
  });
}
```

This replaces the current `ServeAppHandler` and nginx proxy in production. In development, Vite's dev server still handles the frontend with its proxy config.

---

## Domain & TLS

**Railway provides TLS automatically for custom domains.**

### Setup steps:
1. Purchase a domain (or use an existing one). Suggested: `cardgame.yourdomain.com`
2. In Railway project settings > Networking > Custom Domains, add the domain
3. Railway provides a CNAME target (e.g., `xxxx.up.railway.app`)
4. Add a CNAME record in your DNS provider pointing your domain to Railway's target
5. Railway provisions a Let's Encrypt TLS certificate automatically (no certbot, no manual renewal)

**No `KEY_PATH` / `CERT_PATH` in production.** Railway terminates TLS at its edge proxy and forwards plain HTTP to the container on port 3000. The existing `createServer()` logic already handles this — when those env vars are absent, it creates an `http.Server`.

### WebSocket over TLS
Socket.IO connects over `wss://` automatically when the page is served over HTTPS. No additional configuration needed — Railway's proxy handles the `Upgrade` header correctly.

---

## Monitoring & Health Checks

### Health check endpoint

Add `GET /health` to the Express server. Returns 200 with basic status.

```typescript
// In server.ts, register before auth middleware:
this.app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});
```

Railway polls this endpoint to determine container health. If it fails 3 consecutive checks, Railway restarts the container.

### Error logging

**Approach:** Structured console logging. Railway captures stdout/stderr and provides log viewing in the dashboard with retention.

Production logging changes:
- Morgan format: `combined` (includes user-agent, referrer — useful for debugging)
- TypeORM logging: `["error"]` only (already configured via the `NODE_ENV === "production"` check)
- Unhandled rejection handler: log and continue (avoid silent crashes)

```typescript
// In index.ts:
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});
```

**No external logging service needed for playtest.** Railway's built-in log viewer with search is sufficient for a small user group. If playtesting reveals the need for structured alerting, add Sentry or similar in Phase 5B.

### Monitoring checklist (manual, via Railway dashboard):
- Container restart count (should be 0 in steady state)
- Memory usage (should stay well under 512 MB for this workload)
- Response times visible in Railway's metrics tab

---

## Supabase Cloud Setup

### Steps to configure Supabase cloud project:

1. **Create project:** Go to [supabase.com](https://supabase.com) > New Project. Choose region closest to Railway deployment (suggest `us-east-1` if Railway is on US East).

2. **Note credentials** from Settings > API:
   - Project URL (`SUPABASE_URL`)
   - `anon` public key (`VITE_SUPABASE_ANON_KEY`)
   - `service_role` key (not needed in this app currently)
   - JWT Secret (`SUPABASE_JWT_SECRET`)

3. **Note database credentials** from Settings > Database:
   - Host (`DB_HOST`)
   - Port: `5432` (`DB_PORT`)
   - Password (`DB_PASSWORD`)
   - Database name: `postgres` (`DB_NAME`)
   - User: `postgres` (`DB_USER`)

4. **Configure Auth:**
   - Settings > Auth > Site URL: set to production domain (e.g., `https://cardgame.yourdomain.com`)
   - Settings > Auth > Redirect URLs: add production domain
   - Email confirmations: disable for playtest (same as local config)

5. **Database schema:**
   TypeORM `synchronize: true` is disabled in production (the existing code checks `NODE_ENV !== "production"`). Run schema creation once:
   - Option A: Temporarily set `synchronize: true`, deploy, let TypeORM create tables, then redeploy with it off.
   - Option B (recommended): Run the equivalent SQL manually via Supabase SQL Editor:

   ```sql
   CREATE TABLE IF NOT EXISTS game (
     "gameId" VARCHAR PRIMARY KEY,
     "gameType" VARCHAR NOT NULL,
     "playerIds" JSONB NOT NULL DEFAULT '[]',
     "playerDisplayNames" JSONB NOT NULL DEFAULT '{}',
     "maxPlayers" INTEGER NOT NULL DEFAULT 4,
     "status" VARCHAR NOT NULL DEFAULT 'CREATED',
     "state" JSONB,
     "turnTimerSeconds" INTEGER,
     "version" INTEGER NOT NULL DEFAULT 1,
     "createdAt" TIMESTAMP DEFAULT NOW(),
     "updatedAt" TIMESTAMP DEFAULT NOW()
   );

   CREATE TABLE IF NOT EXISTS player_stats (
     "userId" VARCHAR PRIMARY KEY,
     "gamesPlayed" INTEGER NOT NULL DEFAULT 0,
     "gamesWon" INTEGER NOT NULL DEFAULT 0,
     "gamesLost" INTEGER NOT NULL DEFAULT 0,
     "totalScore" INTEGER NOT NULL DEFAULT 0,
     "lastPlayedAt" TIMESTAMP
   );

   CREATE TABLE IF NOT EXISTS feedback (
     "id" SERIAL PRIMARY KEY,
     "userId" VARCHAR NOT NULL,
     "userType" VARCHAR NOT NULL,
     "category" VARCHAR NOT NULL,
     "description" TEXT NOT NULL,
     "context" JSONB,
     "createdAt" TIMESTAMP DEFAULT NOW()
   );
   ```

6. **Connection pooling:** Enable Supavisor (Supabase's connection pooler) from Database Settings > Connection Pooling. Use the pooled connection string for `DB_HOST` to avoid exhausting Postgres connections under load.

---

## Rollback Strategy

**Railway supports instant rollback to any previous deployment.**

### Process:
1. Every push to `main` creates a numbered deployment in Railway
2. If a deploy is broken: Railway dashboard > Deployments > click the previous healthy deployment > "Rollback"
3. Rollback is instant (previous container image is cached)

### Database migrations:
- TypeORM `synchronize` is off in production — schema changes require explicit migration
- For this project's scale, schema changes are rare and additive (new columns, new tables)
- Strategy: always make schema changes backwards-compatible (add columns as nullable, don't rename/drop)
- If a rollback is needed after a schema change: the old code ignores new columns (they're nullable), so rollback is safe

### Emergency procedure:
1. Rollback deployment in Railway (30 seconds)
2. If DB schema was changed and is incompatible: restore from Supabase's point-in-time recovery (available on Pro plan) or manually revert the migration SQL

---

## Cost Estimate

Depends on hosting choice (see comparison above):

| Hosting Choice | Hosting Cost | Supabase | Domain | Total |
|----------------|-------------|----------|--------|-------|
| Fly.io | $3-5 | $0 (free tier) | ~$1 | **$4-6/mo** |
| DO Droplet / Hetzner | $4-5 | $0 (free tier) | ~$1 | **$5-6/mo** |
| DO App Platform | $5 | $0 (free tier) | ~$1 | **$6/mo** |
| Railway | $7-11 | $0 (free tier) | ~$1 | **$8-12/mo** |
| Render | $7 | $0 (free tier) | ~$1 | **$8/mo** |

**Scaling triggers (when to upgrade):**
- Supabase free tier: 500 MB database storage, 2 GB bandwidth/month. Upgrade to Pro ($25/month) if exceeded.
- For a playtest group of 5-20 people, the free tier will not be stressed.

---

## Dependencies

- All of Phase 1-4 must be implemented (the app must be functional to deploy)
- GitHub repository at `github.com/harennon/cardgamesimulator` (already exists)
- A Supabase cloud account (free)
- A hosting account (see comparison above — hosting platform TBD)
- A domain name (optional for initial playtest — most providers offer free subdomains with TLS)

---

## Implementation Checklist

The implementer should deliver these changes in order:

1. **Add health check endpoint** — `GET /health` in `server.ts`
2. **Add production static file serving** — Express serves `build/frontend/` when `NODE_ENV=production`
3. **Create `Dockerfile.production`** — single container with frontend + backend
4. **Update `BACKEND_PORT` to respect `PORT`** — most PaaS providers inject `PORT`, so `server.ts` should check `process.env.PORT || process.env.BACKEND_PORT || 3000`
5. **Add unhandled rejection handler** — in `index.ts`
6. **Extend CI workflow** — add deploy job to `.github/workflows/ci.yml`
7. **Configure Railway project** — via dashboard (not automated)
8. **Configure Supabase cloud** — via dashboard (not automated)
9. **Create production schema** — run SQL in Supabase SQL editor
10. **Verify WebSocket connectivity** — manual smoke test after first deploy

---

## Test Requirements

This LLD is primarily infrastructure. Testing is limited to:

**Unit:**
- Health endpoint returns 200 with expected JSON shape
- Static file middleware is only registered when `NODE_ENV=production`

**Integration (manual post-deploy checklist):**
- [ ] App loads at production URL (static frontend served)
- [ ] Can sign up / sign in via Supabase Auth
- [ ] Can create a game (registered user)
- [ ] Can share invite link and join as guest
- [ ] WebSocket connects (Socket.IO handshake succeeds)
- [ ] Can play a full game of Big2 with 2+ players
- [ ] Turn timer works
- [ ] Reconnection works after brief disconnect
- [ ] Feedback widget submits successfully
- [ ] Player stats are recorded after game completion

**Security:**
- `NODE_ENV=production` disables TypeORM `synchronize` (verified by existing code in `postgres.ts`)
- `NODE_ENV=production` disables the `/test/seed-state` endpoint (verified by existing code in `server.ts`)
- CORS origin is set to production domain only (not `*`)
- No secrets in Docker image layers (all injected via env vars at runtime)
- Frontend build only contains public keys (`VITE_SUPABASE_ANON_KEY` is designed to be public)
