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
- Apple-friendly output: prefers an H.264 rendition when downloading, and automatically re-encodes anything QuickTime/iOS can't play (e.g. VP9/AV1 from Instagram Reels) into a playable mp4 — see [Encoding preferences](#encoding-preferences).
- Preferences panel: a settings page in the UI (codec priority, auto-transcode, transcode target, max resolution) that writes to `settings.json` on the data volume, so your choices survive a restart and anyone forking the project can tune it — or edit the JSON by hand.
- Optional auto-update: an opt-in schedule keeps yt-dlp current (a systemd timer, or a cron job for Docker) so downloads keep working without manual upkeep — see [Automatic yt-dlp updates](#automatic-yt-dlp-updates-opt-in).

## Architecture

- **Backend**: Python + FastAPI (`backend/main.py`), calling the `yt-dlp`
  package. Downloads run in background threads; progress is kept in an in-memory
  job map and polled by the frontend once per second.
- **Database**: SQLite (`backend/history.db`, created on first start), using
  `video_id` as a unique key to avoid duplicate downloads.
- **Preferences**: `settings.json` (on `DATA_DIR`, created on first save),
  holding the codec/transcode preferences so they survive a restart.
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
- `DATA_DIR` (default: the `backend/` directory): where `downloads/`,
  `history.db` and `settings.json` are stored. The Docker setup points this at
  the `/data` volume so state survives image rebuilds.

### Encoding preferences

Some sources (notably Instagram Reels) only offer **VP9** or **AV1** video.
yt-dlp will happily put those in an `.mp4`, but Apple platforms — QuickTime
Player, Safari, the iOS/macOS Photos app — can't decode them, so the file looks
broken even though it downloaded fine. To avoid that, the server:

1. **Prefers an H.264 rendition** when the source offers a choice, so most
   downloads need no re-encoding at all.
2. **Auto-transcodes** anything whose codec still isn't Apple-friendly into a
   playable mp4 (correct `avc1`/`hvc1` tag). While this runs, the job shows a
   `transcoding` status in the UI — on a Raspberry Pi this can take a while,
   since encoding is done in software.

These are adjustable and **persist across restarts** (they live in
`settings.json` on your `DATA_DIR`). Two ways to change them:

**From the UI** — open the `# preferences` panel at the top of the page, adjust,
and click *save*. Changes apply to the next download.

**By editing the file** — handy on a headless Pi or for version-controlling a
setup. Edit `settings.json` in your data directory (for Docker that's
`./data/settings.json`; for the systemd/venv setup it's
`backend/settings.json`, or wherever you pointed `DATA_DIR`):

```jsonc
{
  // Ordered by preference; the first entry is the codec yt-dlp is asked to
  // prefer. Allowed: "h264", "hevc", "vp9", "av1".
  "video_codec_priority": ["h264", "hevc", "vp9", "av1"],
  // Re-encode a finished download when its codec isn't Apple-friendly.
  "auto_transcode": true,
  // Target for that re-encode: "h264" (fast on a Pi, widest support) or
  // "hevc" (~40% smaller files, but much slower to encode in software).
  "transcode_target": "h264",
  // Cap the downloaded resolution in pixels of height. 0 = no limit.
  "max_height": 0
}
```

The file is read at the start of each download, so no restart is needed after a
hand edit. Invalid or unknown values are ignored and fall back to the defaults
above, so a typo can't break downloads. Delete the file to return to defaults.

> **Fixing a file you already downloaded** as broken VP9-in-mp4? Re-encode it in
> place with ffmpeg (this is exactly what the server now does automatically):
>
> ```bash
> ffmpeg -i broken.mp4 -c:v libx264 -crf 23 -tag:v avc1 -c:a aac -movflags +faststart fixed.mp4
> ```

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

Docker (yt-dlp is baked into the image, so rebuild it — the `YTDLP_REFRESH`
build arg forces the yt-dlp layer to rebuild instead of using a cached copy):

```bash
cd /home/pi/ytdlp-server-rpi
docker compose build --build-arg YTDLP_REFRESH=$(date +%s) && docker compose up -d
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

#### Automatic yt-dlp updates (opt-in)

This is **opt-in**: nothing auto-updates until you set up the timer or cron job
below. Once you do, yt-dlp is refreshed on a schedule so downloads keep working
without manual babysitting. Updating the app itself is deliberately left manual —
an unattended `git pull` could pull in breaking changes or conflict with local
edits.

Pick the one matching how you deployed:

Both examples below assume the `pi` user and `/home/pi/...` paths from the
install section — adjust them to match your own user and install path (the same
values you set in `ytdlp-server-rpi.service`).

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

**Docker:** schedule a weekly rebuild with cron — run `crontab -e` and add
(note the `\%`: cron treats a bare `%` as a newline and would truncate the
command there):

```cron
0 4 * * 0 cd /home/pi/ytdlp-server-rpi && docker compose build --build-arg YTDLP_REFRESH=$(date +\%s) && docker compose up -d
```

The `YTDLP_REFRESH` build arg busts only the yt-dlp layer, so the rebuild is
quick and actually pulls the latest yt-dlp. (A plain `docker compose build
--pull` would *not* update yt-dlp: the `pip install` layer stays cached unless
the base image digest happens to change that week.)

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
| GET    | `/api/status/{job_id}`    | Query download progress (`downloading` / `processing` / `transcoding` / `done`) |
| GET    | `/api/settings`           | Get encoding preferences plus the available options     |
| PUT    | `/api/settings`           | Update encoding preferences (partial updates allowed)   |
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
