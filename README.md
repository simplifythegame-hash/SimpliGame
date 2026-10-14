# SimpliGame — Simplify the Game

One app for youth/club sports: live stat tagging, film review, video
linked to stats, highlights, and recruiting profiles. This repo is the
standalone codebase (foundation + core stat loop).

## Layout

```
simpligame/
  client/        React + TypeScript + Vite single-page app
  server/        Node + Express + TypeScript API (pg, no ORM)
  migrations/    Plain SQL schema (Neon-compatible)
  render.yaml    Render blueprint (free web service)
```

## Run locally

Prerequisites: Node 20+, a Postgres database (local Postgres or a free
Neon project).

```bash
npm install
cp .env.example .env          # set DATABASE_URL to your Postgres
# Run the migration against your database, e.g.:
# psql "$DATABASE_URL" -f migrations/001_initial_schema.sql
npm run dev                    # starts the API on http://localhost:4000
```

In a second terminal, start the client (proxies /api to the server):

```bash
npm run dev --workspace=@simpligame/client   # http://localhost:5173
```

## Deploy (free) — Render + Neon

1. Push this repo to GitHub under the owner's account.
2. Create a free Neon project; copy its connection string.
3. In Render: **New → Web Service** from this repo (or apply `render.yaml`
   as a Blueprint). Set `DATABASE_URL` to the Neon connection string.
   Render sets `PORT` automatically.
4. Run `migrations/001_initial_schema.sql` against the Neon database once,
   then restart the service.
5. Your URL: `https://simpligame.onrender.com` (or whatever Render assigns).

## Free-tier notes

- **Render free web service** sleeps after ~15 minutes idle; the first
  request after that takes ~1 minute (cold start). Fine for a pilot.
- **Neon free Postgres** is permanent (no card). This is deliberate:
  Render's own free Postgres is deleted 30 days after creation, so Neon
  is the database for this project.
- **A real `.com` domain** (~$12/yr) is the one non-free piece if you ever
  want one; the Render subdomain is free.

## What v1 does / does not do

**In scope (foundation + core stat loop):**
- One organization (single-owner v1), teams, rosters, games
- Live stat tagging: on-court lineup cards, tap player → tap stat
- Undo, running score kept in lockstep with the event log
- Game detail: event timeline, per-player box score
- YouTube link per game (any URL shape or bare ID), inline embed with a
  10-second load timeout and friendly error + Retry

**Explicitly NOT in v1:** real auth/multi-coach logins, payments, real SMS
(Twilio), real video rendering/clipping, AI stat analysis. Those arrive as
separate, scoped builds. The server is single-owner by design: when
multi-org auth lands, every query must scope by the caller's org — see
`server/src/db.ts`.
