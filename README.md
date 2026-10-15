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
4. Run each migration in `migrations/` against the Neon database in order
   (001, then 002, …), then restart the service. New migrations are applied
   the same way: paste the SQL into the Neon SQL Editor, run it, restart.
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
- One organization (single-owner v1), teams, rosters, games; org rename from the header
- Live stat tagging: on-court lineup cards, tap player → tap stat
- Lineup subs on the live screen (bench player in, on-court player out, same slot; recorded in the event timeline)
- Undo, running score kept in lockstep with the event log
- Game detail: event timeline, per-player box score
- YouTube link per game (any URL shape or bare ID), inline embed with a
  10-second load timeout and friendly error + Retry
- Public watch links: per-game publish/unpublish/regenerate, unlisted
  token-only `/watch/<token>` page (live score, stream, event feed, box
  score — nothing else); bad/revoked/unpublished tokens all get the same
  generic 404
- Recruiting profiles: per-player bio + measurables (coach-editable),
  auto-aggregated career stats + per-game breakdown + highlight events
  with video-timestamp links, publish/unpublish/regenerate, unlisted
  token-only `/profile/<token>` page with Print / Save as PDF
- Reel Studio: highlight reels from game events with video timestamps —
  pick highlights, reorder clips, trim (start/end), per-clip transition
  (cut/fade), text overlays, slow-motion toggle, placeholder music track
  selection, preview (clips in sequence via YouTube embeds jumping to
  each clip's timestamp), mock export (honestly labeled — no real MP4
  yet). Projects persist server-side.
- Auto Reel: one-tap on a game — builds a draft reel from that game's
  scoring highlights best-first (Kills/Aces/Blocks, then Assists/Digs)
  with a preset (transitions + overlays + placeholder music), opens in
  Reel Studio for tweaking
- Game status: draft → live ("Go Live") → final ("End Game") on the Live
  screen and Game Detail; transitions are recorded in the event timeline.
  A final game can't change status, and a draft must go live first.
- Sub-undo: undoing a Substitution reverses the lineup swap (out-player
  returns to the slot, in-player returns to the bench) in the same
  transaction as removing the event. Subs recorded before migration 005
  fall back to deleting the event only.
- PWA installability: manifest + brand icons, install prompt (native
  install where the browser offers it, Share → Add to Home Screen
  instructions on iPhone), service worker (cache-first app shell +
  static assets, network-first API). Offline stat tagging: stat events
  that fail because the device is offline are queued in localStorage and
  retried automatically on reconnect, with a visible queued count. Only
  stat events queue — subs and other mutations need a connection.
- Family SMS: per-player self-enrollment links — families enter their own
  numbers and opt in/out (the coach never types in anyone's number);
  coach views show masked numbers only (•••-•••-1234). The watch link is
  texted the moment the coach taps Go Live (published games only — never
  30 minutes before), plus a coach-triggered highlights-ready alert.
  Per-game delivery log with masked numbers. Real sending uses Twilio
  when configured; with no Twilio credentials the app runs in log-only
  mode (every attempt recorded as 'logged', never claimed sent).

## Family SMS (Twilio)

Family text alerts send through Twilio when configured, and run in
log-only mode (every attempt recorded, nothing claimed sent) when the
Twilio env vars are absent:

  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
  PUBLIC_URL — base URL used in texted links (defaults to
  https://simpligame.onrender.com)

Set them as Render environment variables, then restart the service.
Twilio trial accounts can only text numbers verified in the Twilio
console — verify family numbers there during the trial, or use a paid
number for full sending.

**Explicitly NOT in v1:** real auth/multi-coach logins, payments,
real video rendering/clipping, AI stat analysis. Those arrive as
separate, scoped builds. The server is single-owner by design: when
multi-org auth lands, every query must scope by the caller's org — see
`server/src/db.ts`.
