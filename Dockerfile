FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    MODE=web \
    START_CMD=""

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       bash ca-certificates curl git python3 python3-pip python3-venv \
       ffmpeg sqlite3 tini tzdata procps netcat-openbsd \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --no-cache-dir --break-system-packages --upgrade pip setuptools wheel

WORKDIR /app
COPY app/server.js /app/app/server.js
COPY entrypoint.sh /usr/local/bin/railway-entrypoint
COPY examples /app/examples
COPY package.json /app/package.json

RUN chmod +x /usr/local/bin/railway-entrypoint \
    && npm install --omit=dev --ignore-scripts --no-audit --no-fund

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/railway-entrypoint"]
