# ytdlp-server-rpi

A self-hosted yt-dlp download server designed for the Raspberry Pi. It serves a
web UI on your local network: paste a YouTube URL and it downloads an mp4. The
downloaded file stays on the device and is recorded in a SQLite history, so you
can re-download an existing file later without calling yt-dlp again.

Although it is tuned for the Raspberry Pi (Pi 4 / Pi 5), this is a standard
Python application and runs on any Linux / macOS system with Python 3 and ffmpeg.

## Features

- Web UI: paste a URL, watch live download progress, and see finished files in the history list.
- Deduplication: keyed by the video's `video_id`, so an already-downloaded video is returned from disk instead of being downloaded again.
- Parallel downloads: submit several URLs at once; each runs in its own background thread with its own progress card.
- Auto-save: when a download finishes, the browser is prompted to save the mp4 to your device.
- History: SQLite stores the title, original URL, filename, size, thumbnail and download time, with one-click delete (record + file).
- No build step: the frontend is plain HTML/CSS/JS served directly by FastAPI, well suited to running for long periods on a Pi.

## Architecture

- **Backend**: Python + FastAPI (`backend/main.py`), calling the `yt-dlp`
  package. Downloads run in background threads; progress is kept in an in-memory
  job map and polled by the frontend once per second.
- **Database**: SQLite (`backend/history.db`, created on first start), using
  `video_id` as a unique key to avoid duplicate downloads.
- **File storage**: `backend/downloads/{video_id}.mp4`
- **Frontend**: plain HTML/CSS/JS (`frontend/`), mounted at the root by FastAPI.

## Requirements

- Python 3.9+, plus `python3-venv` and `python3-pip`
- `ffmpeg` (required): yt-dlp needs it to merge separate video/audio streams into mp4

## Installation & Deployment

The steps below assume Raspberry Pi OS (user `pi`) and install the project to
`/home/pi/ytdlp-server-rpi`. If you use a different user or path, adjust the
settings in `ytdlp-server-rpi.service` accordingly.

### 1. Install system dependencies

```bash
sudo apt update
sudo apt install -y git python3-venv python3-pip ffmpeg
```

### 2. Get the project and create a virtual environment

```bash
cd /home/pi
git clone https://github.com/johnlin10/ytdlp-server-rpi.git
cd ytdlp-server-rpi
python3 -m venv venv
source venv/bin/activate
pip install -r backend/requirements.txt
```

### 3. Test it manually

```bash
cd backend
../venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
```

On a device on the same local network, open `http://<device-lan-ip>:8000`
(find the IP with `hostname -I`). Confirm that you can paste a URL, see the
download progress, and that finished files appear in the history list. Press
`Ctrl+C` to stop the test server.

### 4. Run automatically at boot (systemd)

```bash
sudo cp /home/pi/ytdlp-server-rpi/ytdlp-server-rpi.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ytdlp-server-rpi
```

Common management commands:

```bash
sudo systemctl status ytdlp-server-rpi    # check status
sudo systemctl restart ytdlp-server-rpi   # restart
journalctl -u ytdlp-server-rpi -f         # follow live logs
```

## Maintenance

### Keep yt-dlp up to date

YouTube changes its interface often, which breaks older versions of yt-dlp.
Update it periodically:

```bash
source /home/pi/ytdlp-server-rpi/venv/bin/activate
pip install -U yt-dlp
sudo systemctl restart ytdlp-server-rpi
```

### Storage

mp4 files accumulate in `backend/downloads/`, so keep an eye on free space on
the SD card or external drive. If you delete a file manually, also remove its
row from `history.db` — otherwise re-downloading it from the history list fails.
The delete button in the UI removes both the file and the record together.

### Security

This service has no authentication and is designed for local network use only,
relying on your router's NAT to block outside connections. Do not expose port
8000 to the public internet via port forwarding, or anyone could use it to
download videos and reach your device. To access it from outside, use a VPN
(such as Tailscale) to connect back to your home network rather than exposing
the service directly.

## API

| Method | Path                      | Description                                              |
|--------|---------------------------|---------------------------------------------------------|
| POST   | `/api/download`           | Send `{ "url": "..." }`; starts a download or returns an existing record |
| GET    | `/api/status/{job_id}`    | Query download progress                                 |
| GET    | `/api/history`            | Get the download history list                           |
| GET    | `/api/file/{video_id}`    | Download / re-download an existing mp4 file              |
| DELETE | `/api/history/{video_id}` | Delete a history record and remove the video file       |

## License

This project is intended for downloading lawful content on your own devices for
personal use. Please respect YouTube's Terms of Service, your local laws, and
the copyright of content creators.
