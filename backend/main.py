"""
yt-dlp 家庭下載伺服器
------------------------------------
在 Raspberry Pi 上執行，於區域網路內提供網頁介面：
輸入 YouTube 網址 -> yt-dlp 下載 mp4 -> 原始檔保留在本機 -> 歷史紀錄可重新下載
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

# ---------- 路徑設定 ----------
BASE_DIR = Path(__file__).resolve().parent
DOWNLOAD_DIR = BASE_DIR / "downloads"
DB_PATH = BASE_DIR / "history.db"
FRONTEND_DIR = BASE_DIR.parent / "frontend"

DOWNLOAD_DIR.mkdir(exist_ok=True)

app = FastAPI(title="yt-dlp 家庭下載伺服器")

# ---------- 資料庫 ----------
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

# ---------- 記憶體中的工作狀態（下載進度）----------
jobs = {}
jobs_lock = threading.Lock()


def set_job(job_id: str, **kwargs):
    with jobs_lock:
        jobs.setdefault(job_id, {})
        jobs[job_id].update(kwargs)


def get_job(job_id: str):
    with jobs_lock:
        return jobs.get(job_id)


# ---------- 資料模型 ----------
class DownloadRequest(BaseModel):
    url: str


# ---------- 工具函式 ----------
def extract_info(url: str):
    """只取得影片資訊（標題、id、縮圖），不下載"""
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
    """在背景執行緒中實際呼叫 yt-dlp 下載"""

    def progress_hook(d):
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes", 0)
            percent = round(downloaded / total * 100, 1) if total else 0
            set_job(job_id, status="downloading", percent=percent)
        elif d["status"] == "finished":
            # 下載完成，進入合併/後處理（ffmpeg）階段
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
        raise HTTPException(status_code=400, detail=f"無法解析此網址：{e}")

    video_id = info.get("id")
    title = info.get("title") or video_id
    thumbnail = info.get("thumbnail") or ""

    # 已下載過 -> 直接回傳既有檔案資訊，不重跑 yt-dlp
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
        raise HTTPException(status_code=404, detail="找不到此工作")
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
        raise HTTPException(status_code=404, detail="找不到此紀錄")
    filepath = DOWNLOAD_DIR / row["filename"]
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="檔案已不存在於硬碟中")
    return FileResponse(
        path=filepath, filename=row["filename"], media_type="video/mp4"
    )


@app.delete("/api/history/{video_id}")
def delete_history(video_id: str):
    """刪除一筆歷史紀錄，並移除硬碟上的影片檔案"""
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM downloads WHERE video_id = ?", (video_id,)
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="找不到此紀錄")

    # 先刪檔案，再刪紀錄；檔案不存在時視為已清除，繼續刪紀錄
    filepath = DOWNLOAD_DIR / row["filename"]
    if filepath.exists():
        try:
            filepath.unlink()
        except OSError as e:  # noqa: BLE001
            conn.close()
            raise HTTPException(status_code=500, detail=f"刪除檔案失敗：{e}")

    conn.execute("DELETE FROM downloads WHERE video_id = ?", (video_id,))
    conn.commit()
    conn.close()
    return {"status": "deleted", "video_id": video_id}


# 靜態前端（放在最後掛載，避免蓋掉 /api 路由）
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
