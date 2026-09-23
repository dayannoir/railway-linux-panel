# Railway Universal Starter

A lightweight, production-minded starter for small websites, APIs, workers and bots on Railway.

> Railway is a container platform, not a full VPS. This template gives you a clean Linux container with Node.js, Python 3, Git, FFmpeg, SQLite and common utilities. It does not provide systemd, privileged Docker, a permanent public IP or a graphical desktop.

## Deploy

1. Upload this folder to a GitHub repository.
2. In Railway, choose **New Project → Deploy from GitHub Repo**.
3. Select the repository. Railway reads `railway.json` and builds the Dockerfile.
4. Deploy with no variables first. The built-in landing page and `/health` endpoint should work immediately.
5. Add a persistent Railway Volume mounted at `/data` only if the app needs files or SQLite to survive redeploys.

## Run your own app

Set these variables in Railway:

- `START_CMD`: the command to run, for example `node bot.js`, `python3 bot.py`, or `npm start`.
- `MODE`: `web` for a web app/API, or `worker` for a bot/background process.
- `SERVICE_NAME`: optional name shown by the built-in starter.

For a web app, the app must listen on `0.0.0.0` and use Railway's `PORT` variable. Examples:

```text
START_CMD=node examples/node-web/server.js
MODE=web
```

```text
START_CMD=python3 examples/python-web/main.py
MODE=web
```

For a bot:

```text
START_CMD=python3 bot.py
MODE=worker
```

## Python dependencies

The base image includes Python and pip. For a real project, add a `requirements.txt` and include installation in your start command, or extend the Dockerfile with a build step. Example:

```text
START_CMD=pip3 install --no-cache-dir -r requirements.txt && python3 bot.py
```

For production, baking dependencies into the image is faster and more reliable than installing them at every boot.

## Important limits

- Do not put secrets in the repository. Use Railway Variables.
- The container filesystem is ephemeral except for a mounted Volume.
- Small Railway services have limited CPU, memory and network resources; avoid heavy video processing or large databases.
- One service should normally run one main process. Railway already handles restarts.
- A web service must bind to `0.0.0.0:$PORT`; binding to `localhost` makes it unreachable.

## Included

- Node.js 22
- Python 3 + pip + virtualenv
- Git, curl, FFmpeg, SQLite, procps, netcat and tini
- Built-in web landing page
- JSON health endpoint at `/health`
- Examples for Node web, Python web and a worker/bot
- Graceful signal handling through `tini`
- Railway Docker build and deployment configuration
