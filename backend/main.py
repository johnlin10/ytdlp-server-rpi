"""
ytdlp-server-rpi
------------------------------------
Runs on a Raspberry Pi and serves a web UI on the local network:
paste a YouTube URL -> yt-dlp downloads an mp4 -> the file stays on the device
-> the history list lets you re-download it without calling yt-dlp again.
"""

import json
import mimetypes
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import time
import uuid
import zipfile
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
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
SETTINGS_PATH = DATA_DIR / "settings.json"
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
# clean them up after a failed download. `.pretranscode` is the original file we
# set aside while ffmpeg re-encodes it into the final mp4 (see maybe_transcode).
TEMP_SUFFIXES = (".part", ".ytdl", ".temp", ".pretranscode")

download_semaphore = threading.Semaphore(MAX_CONCURRENT_DOWNLOADS)

app = FastAPI(title="ytdlp-server-rpi")

# ---------- Encoding preferences ----------
# These control which video codec yt-dlp is asked to prefer, and whether a
# downloaded file whose codec Apple platforms can't play (VP9/AV1) is re-encoded
# into an iOS/macOS-friendly mp4. They live in settings.json on the DATA_DIR
# volume so edits made from the UI survive a restart, and so anyone running the
# project can tune it to their own needs (or edit the JSON directly).

# Codecs QuickTime / Safari / iOS play natively. A download already in one of
# these is kept as-is; anything else is a candidate for transcoding.
APPLE_COMPATIBLE_VCODECS = ("h264", "hevc")

# Our friendly codec names -> the token yt-dlp's `-S vcodec:...` sort expects.
CODEC_SORT_TOKEN = {"h264": "h264", "hevc": "h265", "vp9": "vp9", "av1": "av01"}

# ffmpeg encoder + container tag for each transcode target. The tag matters:
# `hvc1` (not the default `hev1`) is what QuickTime needs to recognise HEVC.
TRANSCODE_ENCODERS = {
    "h264": {"encoder": "libx264", "crf": "23", "tag": "avc1"},
    "hevc": {"encoder": "libx265", "crf": "28", "tag": "hvc1"},
}

DEFAULT_SETTINGS = {
    # Ordered by preference; the first entry is what yt-dlp is asked to prefer
    # when the source offers a choice. Default puts H.264 first for the widest
    # Apple compatibility, then falls back to whatever the source has.
    "video_codec_priority": ["h264", "hevc", "vp9", "av1"],
    # Re-encode a finished download into mp4 when its codec isn't Apple-friendly.
    "auto_transcode": True,
    # Target codec for that re-encode. h264 = fast on a Pi, widest support;
    # hevc = ~40% smaller but much slower to encode in software.
    "transcode_target": "h264",
    # Cap the downloaded resolution (px height). 0 = no limit.
    "max_height": 0,
}

_settings_lock = threading.Lock()


def _coerce_settings(raw: dict) -> dict:
    """Merge stored/user values onto the defaults, dropping anything invalid.

    Being lenient here means a hand-edited or older settings.json still loads:
    unknown keys are ignored and bad values fall back to the default.
    """
    s = dict(DEFAULT_SETTINGS)
    if not isinstance(raw, dict):
        return s

    codecs = raw.get("video_codec_priority")
    if isinstance(codecs, list):
        cleaned = [c for c in codecs if c in CODEC_SORT_TOKEN]
        # de-dup while preserving order
        seen = set()
        cleaned = [c for c in cleaned if not (c in seen or seen.add(c))]
        if cleaned:
            s["video_codec_priority"] = cleaned

    if isinstance(raw.get("auto_transcode"), bool):
        s["auto_transcode"] = raw["auto_transcode"]

    if raw.get("transcode_target") in TRANSCODE_ENCODERS:
        s["transcode_target"] = raw["transcode_target"]

    mh = raw.get("max_height")
    if isinstance(mh, int) and not isinstance(mh, bool) and mh >= 0:
        s["max_height"] = mh

    return s


def load_settings() -> dict:
    with _settings_lock:
        try:
            with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
                return _coerce_settings(json.load(f))
        except (OSError, json.JSONDecodeError):
            return dict(DEFAULT_SETTINGS)


def save_settings(new: dict) -> dict:
    """Validate, persist and return the effective settings."""
    coerced = _coerce_settings(new)
    with _settings_lock:
        tmp = SETTINGS_PATH.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(coerced, f, indent=2)
        tmp.replace(SETTINGS_PATH)  # atomic swap so a crash can't truncate it
    return coerced


def build_format_opts(settings: dict) -> dict:
    """Turn the codec preferences into yt-dlp format / sort options."""
    max_h = settings.get("max_height", 0)
    if max_h and max_h > 0:
        # Prefer streams within the cap, but keep a bare fallback so a source
        # that only offers a taller rendition still downloads.
        fmt = f"bv*[height<={max_h}]+ba/b[height<={max_h}]/bv*+ba/b"
    else:
        fmt = "bv*+ba/b"

    primary = settings["video_codec_priority"][0]
    # Prefer the chosen codec, then AAC audio; yt-dlp keeps its normal ordering
    # for everything else. (Only the head of the list can drive yt-dlp's pick;
    # the rest of the order is honoured by the transcode fallback below.)
    format_sort = [f"vcodec:{CODEC_SORT_TOKEN[primary]}", "acodec:aac"]
    return {"format": fmt, "format_sort": format_sort}

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


class VideoIdList(BaseModel):
    video_ids: list[str]


class SettingsUpdate(BaseModel):
    # All optional so the UI (or a curl) can send a partial update; unset fields
    # keep their current value. Validation/clamping happens in _coerce_settings.
    video_codec_priority: Optional[list[str]] = None
    auto_transcode: Optional[bool] = None
    transcode_target: Optional[str] = None
    max_height: Optional[int] = None


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


def probe_video_codec(path: Path):
    """Return the video stream's codec name (e.g. 'h264', 'vp9'), or None."""
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=codec_name",
                "-of", "default=nw=1:nk=1",
                str(path),
            ],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip() or None
    except (OSError, subprocess.CalledProcessError):
        return None


def probe_audio_codec(path: Path):
    """Return the audio stream's codec name (e.g. 'aac'), or None if no audio."""
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "a:0",
                "-show_entries", "stream=codec_name",
                "-of", "default=nw=1:nk=1",
                str(path),
            ],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip() or None
    except (OSError, subprocess.CalledProcessError):
        return None


def maybe_transcode(video_id: str, filepath: Path, settings: dict, job_id: str):
    """Re-encode a download into an Apple-friendly mp4 when needed.

    If auto_transcode is on and the file's video codec isn't one QuickTime/iOS
    can play, run ffmpeg to produce `{video_id}.mp4` with the target codec.
    Returns the path to use going forward (the new file, or the original when no
    transcode was needed). Raises on ffmpeg failure so the caller reports it.
    """
    if not settings.get("auto_transcode", True):
        return filepath

    vcodec = probe_video_codec(filepath)
    # Unknown codec (probe failed) -> leave the file alone rather than risk a
    # pointless/broken re-encode.
    if vcodec is None or vcodec in APPLE_COMPATIBLE_VCODECS:
        return filepath

    target = settings.get("transcode_target", "h264")
    spec = TRANSCODE_ENCODERS.get(target, TRANSCODE_ENCODERS["h264"])
    set_job(job_id, status="transcoding", percent=100, target=target)

    # Set the source aside under a temp suffix (ignored by find_downloaded_file
    # and cleaned up on failure) so the output can take the final .mp4 name.
    src = filepath.with_name(f"{filepath.name}.pretranscode")
    filepath.replace(src)
    out = DOWNLOAD_DIR / f"{video_id}.mp4"

    acodec = probe_audio_codec(src)
    # Keep AAC audio as-is (already Apple-friendly); re-encode anything else.
    audio_args = ["-c:a", "copy"] if acodec == "aac" else ["-c:a", "aac", "-b:a", "160k"]

    cmd = [
        "ffmpeg", "-y", "-i", str(src),
        "-c:v", spec["encoder"], "-crf", spec["crf"], "-preset", "medium",
        "-tag:v", spec["tag"],
        *audio_args,
        "-movflags", "+faststart",
        str(out),
    ]
    try:
        subprocess.run(cmd, capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError) as e:
        # Roll back to the original download so the user still has a playable-
        # somewhere file, then surface the failure.
        if out.exists():
            out.unlink(missing_ok=True)
        if src.exists() and not filepath.exists():
            src.replace(filepath)
        stderr = getattr(e, "stderr", "") or ""
        raise RuntimeError(f"transcode to {target} failed: {stderr[-500:] or e}")

    src.unlink(missing_ok=True)
    return out


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

    settings = load_settings()
    outtmpl = str(DOWNLOAD_DIR / f"{video_id}.%(ext)s")
    ydl_opts = {
        **build_format_opts(settings),
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

            # Re-encode into an Apple-friendly mp4 if the codec needs it. This
            # may take a while on a Pi, hence the separate "transcoding" status.
            filepath = maybe_transcode(video_id, filepath, settings, job_id)

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


# ---------- Batch zip download ----------
# Downloading several files at once by triggering many browser downloads is
# unreliable (permission prompts, and iOS Safari usually drops all but the
# first). Instead we stream a single .zip so the browser sees one download.

_UNSAFE_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def safe_zip_name(title: str, suffix: str, used: set) -> str:
    """A filesystem-safe, de-duplicated entry name from a video's title."""
    base = _UNSAFE_NAME.sub("_", (title or "video")).strip().strip(".")
    base = re.sub(r"\s+", " ", base)[:100] or "video"
    name = f"{base}{suffix}"
    n = 2
    while name in used:  # e.g. two videos share a title
        name = f"{base} ({n}){suffix}"
        n += 1
    used.add(name)
    return name


class _ZipSink:
    """A write-only, non-seekable buffer so ZipFile streams (data descriptors)
    instead of seeking back to patch headers — lets us yield bytes as we go and
    never hold a whole archive (or a temp file) in memory / on the SD card."""

    def __init__(self):
        self._buf = bytearray()

    def write(self, data):
        self._buf.extend(data)
        return len(data)

    def flush(self):
        pass

    def drain(self) -> bytes:
        chunk = bytes(self._buf)
        self._buf.clear()
        return chunk


def zip_stream(files, chunk_size=64 * 1024):
    """Yield a ZIP (stored, no recompression) of (arcname, path) pairs."""
    sink = _ZipSink()
    # ZIP_STORED: mp4s are already compressed, so skip CPU-heavy deflate and
    # just bundle them — fast even on a Pi.
    with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
        for arcname, path in files:
            with zf.open(arcname, "w") as dest, open(path, "rb") as src:
                while True:
                    block = src.read(chunk_size)
                    if not block:
                        break
                    dest.write(block)
                    data = sink.drain()
                    if data:
                        yield data
            data = sink.drain()
            if data:
                yield data
    data = sink.drain()
    if data:
        yield data


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


@app.get("/api/settings")
def get_settings():
    """Return the current preferences plus the option lists the UI renders."""
    return {
        "settings": load_settings(),
        "options": {
            "video_codecs": list(CODEC_SORT_TOKEN.keys()),
            "transcode_targets": list(TRANSCODE_ENCODERS.keys()),
        },
        "defaults": DEFAULT_SETTINGS,
    }


@app.put("/api/settings")
def put_settings(update: SettingsUpdate):
    """Merge the provided fields over the current settings and persist them."""
    current = load_settings()
    incoming = {k: v for k, v in update.model_dump().items() if v is not None}
    current.update(incoming)
    saved = save_settings(current)
    return {"status": "saved", "settings": saved}


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


@app.get("/api/download-zip")
def download_zip(ids: str = Query(..., description="comma-separated video_ids")):
    """Stream the selected videos as a single videos.zip.

    A GET (rather than a fetch+blob) so the browser downloads it natively —
    streamed to disk, shown in the download manager, and reliable on iOS.
    """
    wanted = [v for v in (ids.split(",") if ids else []) if v]
    if not wanted:
        raise HTTPException(status_code=400, detail="No video ids given")

    conn = get_db()
    rows = {
        r["video_id"]: r
        for r in conn.execute("SELECT * FROM downloads").fetchall()
    }
    conn.close()

    files = []
    used_names: set = set()
    for vid in wanted:
        row = rows.get(vid)
        if not row:
            continue
        path = DOWNLOAD_DIR / row["filename"]
        if not path.is_file():
            continue
        files.append((safe_zip_name(row["title"], path.suffix, used_names), path))

    if not files:
        raise HTTPException(status_code=404, detail="No downloadable files found")

    return StreamingResponse(
        zip_stream(files),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="videos.zip"'},
    )


@app.post("/api/history/delete")
def batch_delete(req: VideoIdList):
    """Delete several history records and their files in one request."""
    deleted, missing, failed = [], [], []
    conn = get_db()
    for vid in req.video_ids:
        row = conn.execute(
            "SELECT * FROM downloads WHERE video_id = ?", (vid,)
        ).fetchone()
        if not row:
            missing.append(vid)
            continue
        filepath = DOWNLOAD_DIR / row["filename"]
        if filepath.exists():
            try:
                filepath.unlink()
            except OSError:
                failed.append(vid)
                continue
        conn.execute("DELETE FROM downloads WHERE video_id = ?", (vid,))
        deleted.append(vid)
    conn.commit()
    conn.close()
    return {"deleted": deleted, "missing": missing, "failed": failed}


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
