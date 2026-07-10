"""
ytdlp-server-rpi
------------------------------------
Runs on a Raspberry Pi and serves a web UI on the local network:
paste a YouTube URL -> yt-dlp downloads an mp4 -> the file stays on the device
-> the history list lets you re-download it without calling yt-dlp again.
"""

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
DOWNLOAD_DIR = BASE_DIR / "downloads"
DB_PATH = BASE_DIR / "history.db"
FRONTEND_DIR = BASE_DIR.parent / "frontend"

DOWNLOAD_DIR.mkdir(exist_ok=True)

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


def get_job(job_id: str):
    with jobs_lock:
        return jobs.get(job_id)


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

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])

        filename = f"{video_id}.mp4"
        filepath = DOWNLOAD_DIR / filename
        filesize = filepath.stat().st_size if filepath.exists() else 0

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

        set_job(job_id, status="done", percent=100, filename=filename, video_id=video_id)
    except Exception as e:  # noqa: BLE001
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
    return FileResponse(
        path=filepath, filename=row["filename"], media_type="video/mp4"
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
