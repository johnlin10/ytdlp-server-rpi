"""
ytdlp-server-rpi
------------------------------------
Runs on a Raspberry Pi and serves a web UI on the local network:
paste a YouTube URL -> yt-dlp downloads an mp4 -> the file stays on the device
-> the history list lets you re-download it without calling yt-dlp again.
"""

import mimetypes
import os
import shutil
import sqlite3
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import yt_dlp

# ---------- Paths ----------
BASE_DIR = Path(__file__).resolve().parent
# Where downloads and the history DB live. Defaults to the backend/ dir so a
# bare checkout works unchanged; set DATA_DIR (e.g. to a mounted volume) to keep
# state outside the code, which is how the Docker image persists data.
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR))
DOWNLOAD_DIR = DATA_DIR / "downloads"
DB_PATH = DATA_DIR / "history.db"
FRONTEND_DIR = BASE_DIR.parent / "frontend"

DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

# ---------- Config ----------
# How many downloads may run at once. On a small device (e.g. a Pi) firing off
# a large batch of URLs would otherwise spawn a yt-dlp/ffmpeg process per URL
# and saturate CPU, bandwidth and SD-card writes. Extra jobs wait their turn.
MAX_CONCURRENT_DOWNLOADS = max(1, int(os.environ.get("MAX_CONCURRENT_DOWNLOADS", "3")))

# How many finished (done/error) jobs to keep in the in-memory map before the
# oldest ones are dropped, so a long-running server doesn't grow unbounded.
MAX_FINISHED_JOBS = 100

# yt-dlp temp/partial suffixes: never treat these as the final media file, and
# clean them up after a failed download.
TEMP_SUFFIXES = (".part", ".ytdl", ".temp")

download_semaphore = threading.Semaphore(MAX_CONCURRENT_DOWNLOADS)

app = FastAPI(title="ytdlp-server-rpi")

# ---------- Database ----------
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS downloads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            video_id TEXT UNIQUE NOT NULL,
            title TEXT,
            url TEXT,
            filename TEXT,
            filesize INTEGER,
            thumbnail TEXT,
            downloaded_at TEXT
        )
        """
    )
    conn.commit()
    conn.close()


init_db()

# ---------- In-memory job state (download progress) ----------
jobs = {}
jobs_lock = threading.Lock()


def set_job(job_id: str, **kwargs):
    with jobs_lock:
        jobs.setdefault(job_id, {})
        jobs[job_id].update(kwargs)
        # Stamp terminal states so prune_jobs can drop the oldest ones first.
        if kwargs.get("status") in ("done", "error"):
            jobs[job_id].setdefault("finished_at", time.time())


def get_job(job_id: str):
    with jobs_lock:
        return jobs.get(job_id)


def prune_jobs():
    """Drop the oldest finished jobs so the in-memory map stays bounded."""
    with jobs_lock:
        finished = [
            (jid, job) for jid, job in jobs.items()
            if job.get("status") in ("done", "error")
        ]
        if len(finished) <= MAX_FINISHED_JOBS:
            return
        finished.sort(key=lambda kv: kv[1].get("finished_at", 0))
        for jid, _ in finished[: len(finished) - MAX_FINISHED_JOBS]:
            jobs.pop(jid, None)


# ---------- Models ----------
class DownloadRequest(BaseModel):
    url: str


# ---------- Helpers ----------
def extract_info(url: str):
    """Fetch video info only (title, id, thumbnail) without downloading."""
    opts = {"quiet": True, "skip_download": True, "noplaylist": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(url, download=False)


def find_existing(video_id: str):
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM downloads WHERE video_id = ?", (video_id,)
    ).fetchone()
    conn.close()
    return row


def find_downloaded_file(video_id: str):
    """Return the final media file for a video_id, or None.

    We can't assume `.mp4`: the `format` fallback may produce webm/mkv, so we
    look up whatever yt-dlp actually wrote under downloads/{video_id}.* and pick
    the largest real file (the merged output), ignoring temp/partial files.
    """
    candidates = [
        f
        for f in DOWNLOAD_DIR.glob(f"{video_id}.*")
        if f.is_file() and not f.name.endswith(TEMP_SUFFIXES)
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda f: f.stat().st_size)


def cleanup_temp_files(video_id: str):
    """Remove leftover .part/.ytdl/.temp files from an interrupted download."""
    for f in DOWNLOAD_DIR.glob(f"{video_id}.*"):
        if f.is_file() and f.name.endswith(TEMP_SUFFIXES):
            try:
                f.unlink()
            except OSError:
                pass


def do_download(job_id: str, url: str, video_id: str, title: str, thumbnail: str):
    """Run the actual yt-dlp download in a background thread."""

    def progress_hook(d):
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes", 0)
            percent = round(downloaded / total * 100, 1) if total else 0
            set_job(job_id, status="downloading", percent=percent)
        elif d["status"] == "finished":
            # Download finished; entering the merge/post-processing (ffmpeg) stage
            set_job(job_id, status="processing", percent=100)

    outtmpl = str(DOWNLOAD_DIR / f"{video_id}.%(ext)s")
    ydl_opts = {
        "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "merge_output_format": "mp4",
        "outtmpl": outtmpl,
        "progress_hooks": [progress_hook],
        "noplaylist": True,
        "quiet": True,
    }

    # Wait for a free download slot; extra jobs sit in "queued" until one opens.
    set_job(job_id, status="queued", percent=0)
    with download_semaphore:
        try:
            set_job(job_id, status="downloading", percent=0)
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([url])

            filepath = find_downloaded_file(video_id)
            if filepath is None:
                set_job(job_id, status="error", error="download produced no file")
                return

            filename = filepath.name
            filesize = filepath.stat().st_size

            conn = get_db()
            conn.execute(
                """
                INSERT OR REPLACE INTO downloads
                    (video_id, title, url, filename, filesize, thumbnail, downloaded_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    video_id,
                    title,
                    url,
                    filename,
                    filesize,
                    thumbnail,
                    time.strftime("%Y-%m-%d %H:%M:%S"),
                ),
            )
            conn.commit()
            conn.close()

            set_job(
                job_id, status="done", percent=100, filename=filename, video_id=video_id
            )
        except Exception as e:  # noqa: BLE001
            cleanup_temp_files(video_id)
            set_job(job_id, status="error", error=str(e))


# ---------- API ----------
@app.post("/api/download")
def start_download(req: DownloadRequest):
    try:
        info = extract_info(req.url)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Unable to parse this URL: {e}")

    video_id = info.get("id")
    title = info.get("title") or video_id
    thumbnail = info.get("thumbnail") or ""

    # Already downloaded -> return the existing file info, skip yt-dlp
    existing = find_existing(video_id)
    if existing:
        filepath = DOWNLOAD_DIR / existing["filename"]
        if filepath.exists():
            return {
                "status": "exists",
                "video_id": video_id,
                "title": existing["title"],
                "filename": existing["filename"],
            }

    prune_jobs()
    job_id = str(uuid.uuid4())
    set_job(job_id, status="pending", percent=0, video_id=video_id, title=title)

    thread = threading.Thread(
        target=do_download,
        args=(job_id, req.url, video_id, title, thumbnail),
        daemon=True,
    )
    thread.start()

    return {"status": "started", "job_id": job_id, "title": title}


@app.get("/api/status/{job_id}")
def status(job_id: str):
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/api/storage")
def storage():
    """Report how much space the downloads use and the state of the disk."""
    # Sum the sizes of the files we actually have on disk (not the DB column,
    # which can drift if a file was removed out of band).
    downloads_bytes = 0
    for f in DOWNLOAD_DIR.glob("*"):
        if f.is_file() and not f.name.endswith(TEMP_SUFFIXES):
            try:
                downloads_bytes += f.stat().st_size
            except OSError:
                pass

    usage = shutil.disk_usage(DOWNLOAD_DIR)
    return {
        "downloads_bytes": downloads_bytes,
        "disk_total": usage.total,
        "disk_used": usage.used,
        "disk_free": usage.free,
    }


@app.get("/api/history")
def history():
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM downloads ORDER BY downloaded_at DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.get("/api/file/{video_id}")
def get_file(video_id: str):
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM downloads WHERE video_id = ?", (video_id,)
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Record not found")
    filepath = DOWNLOAD_DIR / row["filename"]
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="File no longer exists on disk")
    media_type, _ = mimetypes.guess_type(filepath.name)
    return FileResponse(
        path=filepath,
        filename=row["filename"],
        media_type=media_type or "application/octet-stream",
    )


@app.delete("/api/history/{video_id}")
def delete_history(video_id: str):
    """Delete a history record and remove the video file from disk."""
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM downloads WHERE video_id = ?", (video_id,)
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Record not found")

    # Remove the file first, then the record; a missing file is treated as
    # already cleared, and we still delete the record.
    filepath = DOWNLOAD_DIR / row["filename"]
    if filepath.exists():
        try:
            filepath.unlink()
        except OSError as e:  # noqa: BLE001
            conn.close()
            raise HTTPException(status_code=500, detail=f"Failed to delete file: {e}")

    conn.execute("DELETE FROM downloads WHERE video_id = ?", (video_id,))
    conn.commit()
    conn.close()
    return {"status": "deleted", "video_id": video_id}


# Static frontend (mounted last so it doesn't shadow the /api routes)
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
