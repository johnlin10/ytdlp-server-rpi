FROM python:3.12-slim

# ffmpeg is required by yt-dlp to merge separate video/audio streams into mp4.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first so the layer is cached across code changes.
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ backend/
COPY frontend/ frontend/

# Run as a non-root user (uid/gid 1000, the default Raspberry Pi OS user) so
# files written to the mounted /data volume are owned by you on the host rather
# than root. If your host user isn't 1000, chown ./data to match after cloning.
RUN groupadd -g 1000 app \
    && useradd -u 1000 -g 1000 -m app \
    && mkdir -p /data \
    && chown -R app:app /data
USER app

# Keep downloads and the history DB on a mounted volume, outside the image.
ENV DATA_DIR=/data
VOLUME ["/data"]

WORKDIR /app/backend
EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
