FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    DATA_ROOT=/data \
    PANEL_USERNAME=admin \
    PANEL_PASSWORD=admin

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       bash ca-certificates curl git python3 python3-pip python3-venv \
       ffmpeg sqlite3 tini tzdata procps netcat-openbsd \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --no-cache-dir --break-system-packages --upgrade pip setuptools wheel

WORKDIR /app
COPY package.json /app/package.json
COPY panel /app/panel

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "panel/server.js"]
