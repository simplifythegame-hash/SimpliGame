#!/usr/bin/env python3
"""SimpliGame AI Vision Phase 1 — local worker (runs on the owner's own machine).

Post-game ONLY, human-in-the-loop. The worker polls the SimpliGame server
for pending analysis jobs, downloads the game's video itself, runs the
local model on this machine, and POSTs candidate events back. The coach
confirms each candidate with one tap in the app's Review Queue — nothing
is published as AI-detected without a human yes.

Architecture (worker polls OUT — no inbound connection to this machine):
  server (Render)  <--poll--  this worker  --download-->  YouTube
  server (Render)  <--results--  this worker

The server never runs inference (Render has no GPU) and footage is never
uploaded anywhere: the video is downloaded here, processed here, and
deleted when the job finishes.

Setup:
  pip install yt-dlp            # video download (required)
  # The model itself is a TODO: run_model() below is a stub that returns
  # no candidates. Plug in the RF-DETR/YOLOX + OpenVINO pipeline there.
  # Our own weights, trained on our own footage — no one else's product.

Environment:
  SIMPLIGAME_API_URL  Base URL of the app (default https://simpligame.onrender.com)
  WORKER_KEY          Shared secret, must match WORKER_KEY in Render env vars.
                      The key is never logged.

Run:
  python3 worker/analyze.py                 # poll forever (60s interval)
  python3 worker/analyze.py --once          # one poll cycle, then exit
  python3 worker/analyze.py --interval 30   # poll every 30s

Privacy (youth sports — non-negotiable):
  - Only the coach's own team's footage is processed.
  - Footage is deleted after processing; nothing is uploaded anywhere.
  - Never use kids' video to train a shared/public model without
    explicit parent/guardian consent.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

API_URL = os.environ.get("SIMPLIGAME_API_URL", "https://simpligame.onrender.com").rstrip("/")
WORKER_KEY = os.environ.get("WORKER_KEY", "")
POLL_INTERVAL_SECONDS = 60


def log(msg: str) -> None:
    print(f"[analyze] {msg}", flush=True)


def api_request(method: str, path: str, body: dict | None = None) -> dict:
    """One JSON request to the server, authenticated with X-Worker-Key."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        API_URL + path,
        data=data,
        method=method,
        headers={
            "Content-Type": "application/json",
            # The key travels in a header, never in a URL or a log line.
            "X-Worker-Key": WORKER_KEY,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:300]
        raise RuntimeError(f"{method} {path} -> HTTP {e.code}: {detail}") from e


def run_model(video_path: str) -> list[dict]:
    """Run the local model on a downloaded game video.

    TODO (Phase 1): plug in the real pipeline here — RF-DETR/YOLOX
    detection + OpenVINO inference on CPU, rally segmentation +
    action spotting (serve / spike / block / dig / set / pass).

    Returns a list of candidate dicts:
      {
        "timestamp_sec": float,       # moment in the video
        "clip_start_sec": float,     # start of the 6s review clip
        "clip_end_sec": float,       # end of the 6s review clip
        "proposed_stat": str,        # e.g. "Kill", "Ace", "Block", "Dig"
        "proposed_player_id": str | None,  # best guess, or None
        "confidence": float,         # 0.0 - 1.0
      }

    Player identity is NEVER trusted from video alone — the coach
    confirms it in the Review Queue. Return [] until the model lands:
    an empty result is a valid "no candidates found" outcome.
    """
    # STUB — no model yet. Returning [] keeps the pipeline honest:
    # the job completes with zero candidates instead of fake data.
    _ = video_path
    return []


def download_video(video_id: str, dest_dir: str) -> str:
    """Download a YouTube video with yt-dlp. Returns the local path.

    Prefers the `yt-dlp` executable on PATH; falls back to
    `python -m yt_dlp` so the worker works even when the Python Scripts
    folder is not on PATH (common on Windows when "Add to PATH" was
    unchecked during the Python install).
    """
    if shutil.which("yt-dlp") is not None:
        cmd_base = ["yt-dlp"]
    else:
        cmd_base = [sys.executable, "-m", "yt_dlp"]
        try:
            probe = subprocess.run(
                cmd_base + ["--version"], capture_output=True, text=True, timeout=30
            )
            if probe.returncode != 0:
                raise RuntimeError(
                    "yt-dlp is not installed — run: py -m pip install yt-dlp"
                )
        except FileNotFoundError:
            raise RuntimeError(
                "yt-dlp is not installed — run: py -m pip install yt-dlp"
            )
    out_template = os.path.join(dest_dir, "game.%(ext)s")
    cmd = cmd_base + [
        "--format", "mp4/best[height<=720]/best",
        "--output", out_template,
        "--no-playlist",
        f"https://www.youtube.com/watch?v={video_id}",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
    if proc.returncode != 0:
        raise RuntimeError(f"yt-dlp failed: {proc.stderr.strip()[-300:]}")
    files = [f for f in os.listdir(dest_dir) if f.startswith("game.")]
    if not files:
        raise RuntimeError("yt-dlp finished but no video file was produced.")
    return os.path.join(dest_dir, files[0])


def process_job(job: dict) -> None:
    """Download, analyze, post results, delete the footage. Always."""
    job_id = job["id"]
    video_id = job.get("youtube_video_id")
    if not video_id:
        api_request("POST", f"/api/analysis/jobs/{job_id}/results",
                    {"status": "failed", "error": "Job has no video attached."})
        log(f"job {job_id}: failed (no video)")
        return
    tmpdir = tempfile.mkdtemp(prefix="simpligame-ai-")
    try:
        log(f"job {job_id}: downloading video {video_id}…")
        video_path = download_video(video_id, tmpdir)
        log(f"job {job_id}: running local model…")
        candidates = run_model(video_path)
        api_request("POST", f"/api/analysis/jobs/{job_id}/results",
                    {"candidates": candidates})
        log(f"job {job_id}: done, {len(candidates)} candidate(s)")
    except Exception as e:  # noqa: BLE001 - worker must report, not crash
        try:
            api_request("POST", f"/api/analysis/jobs/{job_id}/results",
                        {"status": "failed", "error": str(e)[:500]})
        except Exception as post_err:  # noqa: BLE001 - still log locally
            log(f"job {job_id}: could not report failure: {post_err}")
        log(f"job {job_id}: failed: {e}")
    finally:
        # Footage is deleted after processing — never kept, never uploaded.
        shutil.rmtree(tmpdir, ignore_errors=True)


def poll_once() -> int:
    """One poll cycle. Returns the number of jobs processed."""
    try:
        result = api_request("GET", "/api/analysis/jobs/pending")
    except Exception as e:  # noqa: BLE001 - retry next cycle
        log(f"poll failed (will retry): {e}")
        return 0
    jobs = result.get("jobs", [])
    for job in jobs:
        process_job(job)
    return len(jobs)


def main() -> int:
    parser = argparse.ArgumentParser(description="SimpliGame AI Vision local worker")
    parser.add_argument("--once", action="store_true", help="one poll cycle, then exit")
    parser.add_argument("--interval", type=int, default=POLL_INTERVAL_SECONDS,
                        help="poll interval in seconds (default 60)")
    args = parser.parse_args()

    if not WORKER_KEY:
        print("ERROR: WORKER_KEY is not set. Set it to match WORKER_KEY in Render, then retry.",
              file=sys.stderr)
        return 2
    log(f"polling {API_URL} every {args.interval}s (Ctrl-C to stop)")
    while True:
        poll_once()
        if args.once:
            return 0
        time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())
