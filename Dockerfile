FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=10000 \
    HOST=0.0.0.0 \
    YTDLP_BIN=/opt/yt-dlp/bin/yt-dlp \
    FFMPEG_BIN=/usr/bin/ffmpeg \
    STREAMDROP_TEMP_DIR=/tmp/streamdrop \
    MAX_DOWNLOAD_BYTES=800000000 \
    JOB_RETENTION_MS=900000 \
    RATE_WINDOW_MS=60000 \
    RATE_LIMIT_PER_IP=30 \
    DOWNLOADS_PER_IP_WINDOW=8 \
    DOWNLOADS_PER_USER_WINDOW=20 \
    MAX_CONCURRENT_PER_IP=2 \
    MAX_CONCURRENT_PER_USER=3

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade pip yt-dlp

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
RUN mkdir -p /tmp/streamdrop && chmod 700 /tmp/streamdrop

EXPOSE 10000

CMD ["npm", "start"]
