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
- Parallel / batch downloads: paste several URLs at once separated by commas (or newlines); each runs in its own background thread with its own progress card.
- Storage gauge: the history view shows how much space your downloads use against the total disk, with a terminal-style usage bar.
- Responsive UI: the layout adapts to phones and narrow screens.
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

### 4. Run with Docker (alternative)

If you prefer containers, a `Dockerfile` and `docker-compose.yml` are included;
the image bundles `ffmpeg` so there are no host dependencies beyond Docker
itself. Downloads and `history.db` persist in a `./data` directory next to the
compose file.

```bash
docker compose up -d --build
```

The UI is then on `http://<device-lan-ip>:8000`. To update yt-dlp, rebuild the
image (`docker compose build --pull && docker compose up -d`). Verified on a
Raspberry Pi 4 (64-bit / arm64) as well as x86 hosts. If you use Docker you can
skip the systemd step below.

The container runs as a non-root user (uid/gid `1000`, the default Raspberry Pi
OS user), so downloaded files under `./data` are owned by you and manageable
without `sudo`. If your host account isn't uid 1000, run
`sudo chown -R 1000:1000 data` once after cloning.

### 5. Run automatically at boot (systemd)

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

## Configuration

- `MAX_CONCURRENT_DOWNLOADS` (default `3`): how many downloads may run at once.
  Extra URLs in a batch wait in a `queued` state until a slot frees up, which
  keeps a large batch from saturating a small device. Set it in the environment
  (e.g. add `Environment=MAX_CONCURRENT_DOWNLOADS=2` under `[Service]` in the
  systemd unit).
- `DATA_DIR` (default: the `backend/` directory): where `downloads/` and
  `history.db` are stored. The Docker setup points this at the `/data` volume so
  state survives image rebuilds.

## Maintenance

### Updating

Two things need to stay current: **yt-dlp** (often, since YouTube's frequent
changes break older versions) and the **app itself** (occasionally). yt-dlp is
what actually breaks downloads, so if a download suddenly starts failing, update
that first.

Your `downloads/`, `history.db` and `./data` are git-ignored, so `git pull`
never touches your files or history.

#### Update yt-dlp

systemd / venv:

```bash
source /home/pi/ytdlp-server-rpi/venv/bin/activate
pip install -U yt-dlp
sudo systemctl restart ytdlp-server-rpi
```

Docker (yt-dlp is baked into the image, so rebuild it):

```bash
cd /home/pi/ytdlp-server-rpi
docker compose build --pull && docker compose up -d
```

#### Update the app

systemd / venv:

```bash
cd /home/pi/ytdlp-server-rpi
git pull
source venv/bin/activate
pip install -U -r backend/requirements.txt
sudo systemctl restart ytdlp-server-rpi
```

Docker:

```bash
cd /home/pi/ytdlp-server-rpi
git pull
docker compose up -d --build
```

#### Automatic yt-dlp updates (optional)

Updating yt-dlp on a schedule keeps downloads working without manual babysitting.
Updating the app itself is deliberately left manual — an unattended `git pull`
could pull in breaking changes or conflict with local edits.

**systemd:** add a timer that updates yt-dlp weekly and restarts the service.
Create `/etc/systemd/system/ytdlp-update.service`:

```ini
[Unit]
Description=Update yt-dlp for ytdlp-server-rpi

[Service]
Type=oneshot
# runuser keeps the venv files owned by pi; the restart needs root.
ExecStart=/usr/sbin/runuser -u pi -- /home/pi/ytdlp-server-rpi/venv/bin/pip install -U yt-dlp
ExecStartPost=/bin/systemctl restart ytdlp-server-rpi
```

and `/etc/systemd/system/ytdlp-update.timer`:

```ini
[Unit]
Description=Weekly yt-dlp update

[Timer]
OnCalendar=Sun 04:00
Persistent=true

[Install]
WantedBy=timers.target
```

Then enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ytdlp-update.timer
sudo systemctl list-timers ytdlp-update.timer   # confirm the next run time
```

**Docker:** schedule a weekly rebuild (which re-pulls the latest yt-dlp) with
cron — run `crontab -e` and add:

```cron
0 4 * * 0 cd /home/pi/ytdlp-server-rpi && docker compose build --pull && docker compose up -d
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
| GET    | `/api/storage`            | Report downloads size and disk total/used/free          |
| GET    | `/api/file/{video_id}`    | Download / re-download an existing mp4 file              |
| DELETE | `/api/history/{video_id}` | Delete a history record and remove the video file       |

## License

Released under the [MIT License](LICENSE) — you are free to use, modify, and
fork it.

### Disclaimer

This project is intended for downloading lawful content on your own devices for
personal use. Please respect YouTube's Terms of Service, your local laws, and
the copyright of content creators.
