# Railway Linux Panel

A lightweight authenticated control panel for running small websites, APIs and bots inside one Railway container.

Default first login: `admin` / `admin`. Change both immediately from Settings. A Railway Volume mounted at `/data` is strongly recommended so credentials, files and app definitions survive redeploys.

This is not a full VPS or cPanel replacement. It manages the current container only, exposes a restricted terminal rooted at `/data`, and includes a small process manager for Node/Python apps.
