# Dashboard Control Panel

The `botmux dashboard` command produces a one-time token URL for unified control across all daemons / bots in the browser.

```bash
botmux dashboard
# Output: http://<lan-ip>:7891/?t=<token>
```

> Each run rotates a new token, and the old URL is invalidated immediately — a one-time, one-secret way of fetching the link (sharing the URL = sharing a one-shot login). Default port `7891`, overridable via `BOTMUX_DASHBOARD_PORT`.

![Dashboard Groups panel](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780033300739_dash-groups.png)
<p class="cap">Groups panel: a chat × bot matrix that shows at a glance which bots are in which groups</p>

## Features

- **Sessions**: lists active + closed sessions across all bots, filterable by CLI / status / adopt / text. Open a detail view to copy various IDs, close sessions, and multi-select batch close; "locate topic" has the bot post an **@-mention of the session owner** in the original topic (a bare @, no other text) to help you jump back to the context. Chat-scope session rows also carry a Lark group AppLink straight to the chat.
- **Schedules**: lists all scheduled tasks, with Run now / Pause / Resume.
- **Groups**: one-click create a new group (auto @-notifies the invited user), add bots to a group, and auto-transfer group ownership; disband groups and have bots leave groups (associated sessions are cleaned up automatically).
- **Team / Roles / Bot Defaults**: the Team panel handles [cross-deployment collaboration](/en/roles) (invite someone else's deployment into your team, create cross-deployment groups); Roles manages each bot's per-group persona; Bot Defaults (Bot configuration) sets default behaviors (new-group on-call, card signature, **default role**, etc.).
- **Workflows control panel**: Run List polling; Run Detail shows the summary / dangling red zone / node-activity / event timeline / concurrent-execution timeline; you can **cancel a run** directly.

> **Two things live outside the Dashboard**: a v3 workflow's **humanGate approve / reject** happens on a **Lark approval card** (not clicked in the Dashboard); triggering a workflow with parameters currently goes through the **connector (Webhook)** path (see [Connectors](/en/webhook)) — there is no "Workflow Catalog + parameterized trigger" page in the Dashboard. The Dashboard's Workflows panel focuses on observation and cancel.

## Deployment details

The dashboard runs as a separate pm2 process `botmux-dashboard`, starting and stopping together with the daemon. Each daemon exposes an internal IPC on `127.0.0.1` (local only), and the dashboard process acts as a reverse proxy + HMAC auth: the secret file `~/.botmux/.dashboard-secret` (mode 0600) is the internal daemon↔dashboard signing key and is **never sent down to the browser** (the browser gets a separate one-time token).
