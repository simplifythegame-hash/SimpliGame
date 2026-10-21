# Mini-PC transfer day — SimpliGame moves home

The day the mini-PC arrives, this checklist takes SimpliGame from
Render + Neon onto the box. The app keeps running on Render the whole
time — nothing switches until step 8 verifies the box end-to-end.

**What the box runs** (all from `docker-compose.yml` at the repo root):

| Service | What it is | Replaces |
|---|---|---|
| `app` | The SimpliGame server + built client (Dockerfile) | Render web service |
| `db` | Postgres 16, data in the `db_data` volume | Neon |
| `minio` | MinIO object storage, data in the `minio_data` volume | *(future Phase 2 — running, not yet used by the app)* |

**Ports on the box (all localhost-only):** app `127.0.0.1:4000`,
MinIO API `127.0.0.1:9000`. Postgres publishes no port (internal
network only). The MinIO console is not published anywhere.

---

## 0. Before the day

- [ ] Mini-PC picked: Intel CPU (an i5 micro-PC — Dell OptiPlex Micro
      / Lenovo ThinkCentre Tiny class), 16 GB RAM if possible, SSD.
- [ ] You have, somewhere safe (NOT in chat): the current Render env
      values — `WORKER_KEY`, `GOOGLE_OAUTH_CLIENT_ID`,
      `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`,
      and the Twilio trio if set. You'll copy them from the Render
      dashboard into the box's `.env` by hand.
- [ ] Decide the tunnel: **Tailscale Funnel** (address like
      `https://simpligame.<tailnet>.ts.net`) or **Cloudflare Tunnel**
      (needs a domain). The chosen public address becomes
      `PUBLIC_URL`.

## 1. Install Ubuntu Server

- [ ] Install Ubuntu Server LTS from a USB stick; create your user;
      enable SSH if you want to administer from the Dell.
- [ ] `sudo apt update && sudo apt upgrade -y`
- [ ] Set the box to never sleep (server install won't by default)
      and to power back on after an outage (BIOS "Restore on AC
      Power Loss" if offered).

## 2. Install Docker

- [ ] Install Docker Engine + the Compose plugin (Docker's official
      Ubuntu instructions), then:
      `sudo usermod -aG docker $USER` and log out/in.
- [ ] `docker compose version` prints a version.

## 3. Get the code + secrets onto the box

- [ ] `git clone https://github.com/simplifythegame-hash/SimpliGame.git`
- [ ] `cd SimpliGame && cp .env.box.example .env`
- [ ] Edit `.env` (on the box, never pasted through chat):
  - [ ] `POSTGRES_PASSWORD` — new, long, URL-safe (letters/numbers/`-_.`)
  - [ ] `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` — new, strong
  - [ ] `PUBLIC_URL` — the tunnel address from step 0 (or leave
        `http://localhost:4000` until the tunnel is up in step 5)
  - [ ] `WORKER_KEY`, `GOOGLE_OAUTH_*`, Twilio trio — copied from
        the Render dashboard

## 4. First boot (empty database)

- [ ] `docker compose up -d --build` — the app waits for Postgres to
      pass its healthcheck before starting.
- [ ] `docker compose ps` — `db` healthy, `app` and `minio` up.
- [ ] `curl http://localhost:4000/api/health` → `{"ok":true}`
- [ ] On a **fresh** box (no data move), create the schema by running
      every migration in order:
      `for f in migrations/*.sql; do docker compose exec -T db psql -U simpligame -d simpligame < "$f"; done`
      If you're moving the live data (step 6), SKIP this — the dump
      brings the schema with it.

## 5. Tunnel + public address

- [ ] Bring the tunnel up (Tailscale Funnel on port 4000, or
      Cloudflare Tunnel → `http://localhost:4000`).
- [ ] Set `PUBLIC_URL` in `.env` to the tunnel's public address,
      then `docker compose up -d app` to restart just the app.
- [ ] Open the public address on your phone (off Wi-Fi): the app
      loads.
- [ ] Google OAuth: in Google Cloud → the OAuth client → add the
      new redirect URI `<PUBLIC_URL>/api/auth/google/callback`
      (keep the old onrender.com one too until step 8 finishes).

## 6. Move the data (Neon → box)

Do this in a quiet window — stats tagged on Render after the dump
won't be in it.

- [ ] On any machine with `pg_dump` (or Neon's SQL/console export):
      `pg_dump "<NEON_DATABASE_URL>" -Fc -f simpligame-backup.dump`
      (the Neon URL is in the Render dashboard / Neon console —
      handle it like a password).
- [ ] Copy the dump to the box; restore into the compose Postgres:
      `docker compose exec -T db pg_restore -U simpligame -d simpligame --clean --if-exists < simpligame-backup.dump`
- [ ] Apply any migration NEWER than what's in the dump (check
      `migrations/` against what production has run — e.g. 013):
      `docker compose exec -T db psql -U simpligame -d simpligame -f ...`
      (pipe the file in with `<` as in step 4).
- [ ] Keep `simpligame-backup.dump` — it's also your first backup
      of the box.

**What does NOT move:** imported videos. They live in each user's
own Google Drive, not in the database — the library rows move with
the dump and the files keep working untouched. (Per-user Drive
connections survive too: the refresh tokens are user rows.)

## 7. Verify the box

- [ ] `curl http://localhost:4000/api/health` → `{"ok":true}`
- [ ] Log in as owner (your existing account — it moved with the data).
- [ ] HOME shows your teams/players/games with the right counts.
- [ ] Open a published game's **watch page** via the public tunnel
      address (logged out / private tab) — score + stream load.
- [ ] Open a published **recruiting profile** the same way.
- [ ] Connect Google Drive (Account) and play one imported video —
      proves the new OAuth redirect URI works.
- [ ] Run one Sheets export (or CSV) on a game.
- [ ] If the worker runs: point the Dell worker at the box
      (`SIMPLIGAME_API_URL=<PUBLIC_URL>`, same `WORKER_KEY`) and run
      `py analyze.py --once`.

## 8. Switch over

- [ ] Tell coaches/parents the new address (watch/profile links
      already shared keep the old onrender.com address — re-share
      from the box for anything ongoing).
- [ ] Leave Render + Neon running untouched for a week as the
      fallback; if anything's wrong on the box, the old address
      still works (but data written on the box after step 6 won't be
      there — treat Render as read-only history from switch-over).
- [ ] After a clean week: pause the Render service; keep the Neon
      project (free, and it's a second copy of the data).

## 9. After the move (first week)

- [ ] Backup habit: nightly external-drive copy of both volumes /
      a fresh `pg_dump` — one box is one copy until this exists
      (roadmap Phase 1).
- [ ] Optional tidiness: pin the MinIO image tag
      (`docker images minio/minio`) in `docker-compose.yml` so
      restarts are reproducible.
- [ ] MinIO console (if ever needed): it is deliberately not
      published. On the box itself, temporarily add
      `"127.0.0.1:9001:9001"` to the minio ports, `docker compose up
      -d minio`, browse `http://localhost:9001`, then remove it.
