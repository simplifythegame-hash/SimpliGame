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
  worker/        Python local worker — AI Vision Phase 1 (owner's own machine)
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
- Google Sheets export: per-game **Export to Google Sheets** builds a
  real Sheet (Box Score + Timeline tabs) from the game's real events,
  records the export, and lists past exports with links. With no Google
  credentials the button reports "not configured" honestly — and
  **Download CSV** (same data, built client-side) always works.
- Assisted post-game analysis: per-game **Post-Game Analysis** shows a
  rule-based overview computed from the game's real recorded data (final
  score, stat totals, top contributors, key moments, completeness) — no
  AI, no invented numbers. Each section carries a confidence label (High
  confidence / Estimated / Missing) derived from the data itself. The
  coach checks each section and signs it off (Verified, optionally with
  a correction/note); only Verified sections count as official. Overall
  status: unreviewed / partially verified / verified.
- Coach logins: email + password accounts (owner, head coach, assistant,
  stat crew). Passwords are scrypt hashes only; sessions are opaque
  tokens in an HttpOnly cookie (30 days). The owner sees everything and
  manages coaches; a coach sees only their assigned teams — enforced
  server-side on every query, so a guessed ID still 404s. Public watch /
  profile / enroll links stay public (token-only, no login).
- Sidebar navigation (prototype tabs): **HOME** (org overview — teams,
  live / upcoming / recent games, quick links), **Live** (games list +
  New Game + entry into live tagging), **Team** (all rosters, per-team
  roster management + that team's games), **Player Management**
  (head_coach+; every player across teams, opening the full recruiting
  profile), **Highlight Builder** (head_coach+; Auto Reel automated
  builds + reel library + Reel Studio), **Coaches** (owner only).
  Game Detail stays reachable from Live or Team; the sidebar collapses
  to a horizontal tab row on phones.

## Coach logins

No env vars needed. First run migration 009, then restart.

1. Open the app — with zero users it shows a one-time **setup form**.
   Create the owner account there (name, email, password 8+ characters).
   Setup refuses once the first user exists, so it can never be re-run
   to hijack the org. The owner sets their own password via this form —
   never in chat, never hardcoded.
2. Log in with that account. The header shows the signed-in user + Logout.
3. Owner-only **Coaches** section (nav): add a coach with a role
   (head coach / assistant / stat crew) + team checkboxes, change a
   coach's role/teams, remove a coach. Removing a coach deletes their
   sessions too.
4. **Permissions** — enforced server-side on every write endpoint via a
   single `requirePermission(action)` helper (a 403 never reveals
   whether the resource exists: the role check runs before any
   lookup). The client hides buttons the role may not use; the server
   still enforces everything. Team scoping is unchanged: unassigned
   teams still 404.

   | Action | stat_crew | assistant | head_coach | owner |
   |---|:---:|:---:|:---:|:---:|
   | View assigned teams / games / profiles | ✅ | ✅ | ✅ | ✅ |
   | Tag stats, undo | ✅ | ✅ | ✅ | ✅ |
   | Subs | — | ✅ | ✅ | ✅ |
   | Go Live / End Game | — | ✅ | ✅ | ✅ |
   | Analysis verify / unverify | — | ✅ | ✅ | ✅ |
   | Game creation | — | — | ✅ | ✅ |
   | Roster changes (add players) | — | — | ✅ | ✅ |
   | Publish / unpublish (watch + profiles) | — | — | ✅ | ✅ |
   | Exports (Sheets + CSV) | — | — | ✅ | ✅ |
   | Profile bio / measurables edits | — | — | ✅ | ✅ |
   | Reels (create / edit / Auto Reel) | — | — | ✅ | ✅ |
   | Family-notify sends (highlights alerts) | — | — | ✅ | ✅ |
   | YouTube attach, enroll links, remove family contacts | — | — | ✅ | ✅ |
   | Team creation, org rename, coach management | — | — | — | ✅ |

   Notes: Go Live still texts families the watch link for whoever goes
   live (assistant included) — that SMS is a side effect of going live,
   not the separate highlights-notify button, which is head_coach+.
   The owner is the only role that can manage coaches or rename the org.
5. **Passwords:** any logged-in user can change their own password from
   the header ("Change password" — verifies the current password and
   signs out their other sessions). The owner can reset a coach's
   password from the Coaches screen ("Reset password") — this signs the
   coach out everywhere; share the new password with them out-of-band.
   There is no email-based reset. A fully locked-out owner (no working
   password, no other owner session) needs DB access: in the Neon SQL
   Editor, delete all rows from `users` (sessions and coach assignments
   cascade) — the one-time setup form re-opens only when zero users
   exist. Then recreate the owner account and re-add any coaches.
   Keep a written-down password in a safe place to avoid this.

## Google Sheets export (service account)

Game exports build a real Google Sheet via a service account — no
per-coach OAuth in this round. With the env vars absent, the Export
button reports "not configured" and the CSV download still works:

  GOOGLE_SERVICE_ACCOUNT_EMAIL
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY (PEM key; keep the literal \n
    escapes — the server converts them to real newlines)
  GOOGLE_SHARE_EMAIL (optional — Sheet is shared with this email as a
    writer; without it the Sheet is anyone-with-link reader)

Setup (Google Cloud, signed in with the app's Google account):
1. Create a project (or reuse one) → enable the **Google Sheets API**
   and the **Google Drive API**.
2. IAM & Admin → Service Accounts → Create service account → Create
   key (JSON) → download it once.
3. From the JSON key, copy `client_email` → GOOGLE_SERVICE_ACCOUNT_EMAIL
   and `private_key` → GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY. Set both as
   Render environment variables, then restart the service.
4. Never paste the private key in chat. If a key is ever exposed,
   delete it in Google Cloud and make a new one.

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

**Explicitly NOT in v1:** payments, real video rendering/clipping.
Coach logins are built (see below). AI Vision Phase 1 scaffolding is
built (job API + Review Queue + local worker) — the model itself is
still a stub in `worker/analyze.py`.

## AI Vision Phase 1 — AI Review Queue (post-game, human-in-the-loop)

The app does NOT watch video and auto-score. The honest version:
post-game AI proposes candidate plays, and the coach confirms each
with one tap in the Review Queue. Confirmed candidates become normal
stat events (same pipeline as a manual tap). Nothing is published as
AI-detected without a human yes.

**Architecture — worker polls out, no inbound connection:**
the owner's own machine runs `worker/analyze.py`, which polls the
server for pending jobs, downloads the game's video itself, runs the
local model, and POSTs candidates back. The server only stores jobs
+ candidates and serves the Review Queue. NO inference runs on
Render (it has no GPU). Footage is processed locally on the owner's
machine and deleted when the job finishes — never uploaded anywhere.

**Our own model:** the model is our own weights, trained on our own
footage — no competitor's product, no hosted AI API. The pipeline
starts from a free open architecture (RF-DETR / YOLOX, Apache-2.0)
and our own training data. `run_model()` in the worker is a stub
returning `[]` until the real pipeline lands.

**Setup (owner):**
1. Run `migrations/010_ai_analysis.sql` in the Neon SQL Editor, then
   restart Render (same pattern as every migration).
2. Set `WORKER_KEY` in Render env vars (any long random string —
   generate one, never reuse a password) and restart. The key is
   never logged.
3. On the owner's machine (the Dell): `pip install yt-dlp`, set the
   same `WORKER_KEY` env var, then run:
   `python3 worker/analyze.py`
   (`--once` for a single poll cycle, `--interval 30` to poll faster.)
4. In the app: finish a game with a video attached → **Analyze video**
   (Game Detail, Live tab Final list, or Highlight Builder) → run the
   worker → open the **Review Queue** → Confirm / Correct / Skip each
   candidate.

**Endpoints:** `POST /api/games/:id/analysis-job` (head_coach+),
`GET /api/games/:id/analysis-job`, `GET /api/analysis/jobs`
(head_coach+), `GET /api/analysis/jobs/pending` (worker key),
`POST /api/analysis/jobs/:id/results` (worker key),
`POST /api/analysis/candidates/:id/confirm|skip` (head_coach+).

**Youth-privacy rules:** only the coach's own team's footage is
processed; footage is deleted after processing; never use kids'
video to train a shared/public model without explicit
parent/guardian consent.
