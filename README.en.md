# botmux

<p align="center">
  <img src="cover.svg" alt="botmux" width="760">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/botmux"><img src="https://img.shields.io/npm/v/botmux.svg" alt="npm"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node >= 22">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT"></a>
  <a href="https://github.com/deepcoldy/botmux"><img src="https://img.shields.io/github/stars/deepcoldy/botmux.svg?style=social" alt="Stars"></a>
</p>

<p align="center"><b>Drive your AI coding CLI from Lark (Feishu).</b> One message starts a session, each session runs its own isolated CLI process, streamed back in real time — synced across phone, desktop, and terminal.</p>

<p align="center">
  <a href="https://deepcoldy.github.io/botmux/en/"><b>📖 Docs</b></a> ·
  <a href="#5-minute-setup"><b>🚀 Quickstart</b></a> ·
  <a href="https://bytedance.larkoffice.com/wiki/UBOXwH01CixfxfkqxUpcKgvQnsg"><b>✨ Showcase</b></a> ·
  <a href="README.md">中文</a>
</p>

<p align="center">
  <img src="gif/fold&unfold.gif" width="640" alt="Lark streaming card relaying CLI output in real time">
</p>

---

A daemon watches Lark messages and spawns an isolated AI coding CLI process for each new session, streaming the CLI's output back as live Lark cards and offering an interactive web terminal. It **doesn't reimplement agent capabilities** — it bridges the CLIs you already use directly (`botmux` ships **24 built-in adapters**, see [Supported CLIs](#supported-clis)).

## What it solves

- **The agent can't reach you, and you can't drive it from your phone** — the CLI runs on a dev box, you're on your phone. botmux pushes every turn as a Lark card so you can view / follow up / interrupt anywhere, and open a writable web terminal to operate it directly.
- **The CLI is blind to your Lark context** — pull a bot into a topic group / on-call group and one @ runs it right in your local repo; a session can be moved to another group with `/relay`, keeping its full context.
- **A single agent isn't enough** — put several bots backed by different CLIs in one group, @ whoever should act, and have Claude Code and Codex review the same MR — each analyzing independently and pushing back when they disagree.

## 5-Minute Setup

> Scanning to create the app + granting permissions takes about 5 minutes. ByteDance-internal users: see [one-command setup](https://deepcoldy.github.io/botmux/en/quickstart).

```bash
npm install -g botmux        # requires Node >= 22
botmux setup                 # scan to create a bot → pick a CLI → pick a working dir → scan to grant permissions
botmux start                 # start the daemon (botmux autostart enable for auto-start on boot)
```

Then DM the bot, or run `botmux dashboard` to create a group, and start chatting. Full steps (screenshots, internal one-command setup, proxy config) are in the **[5-Minute Quickstart](https://deepcoldy.github.io/botmux/en/quickstart)**.

## Core Scenarios

- **[Live streaming cards](https://deepcoldy.github.io/botmux/en/cards)** — one live-updating card per turn, relaying the terminal screen verbatim as a screenshot; one tap to show/hide output, scroll, or restart/close/adopt the session.
- **[Multi-bot collaboration](https://deepcoldy.github.io/botmux/en/multi-bot)** — multi-bot @mention routing in one group; different CLIs mean different models and natural diversity — have them critique each other on design reviews, code reviews, tech-stack choices.
- **[Multi-topic orchestration](https://deepcoldy.github.io/botmux/en/multi-topic)** — hand an orchestrator a big task and it seeds topics in the group, spins up an isolated session per bot to run a pipeline, and the Lark task board shows every subtask's progress at a glance.
- **[Interactive web terminal](https://deepcoldy.github.io/botmux/en/web-terminal)** — not just viewing output: drive the CLI directly from a browser / phone, with a floating shortcut bar on mobile (Esc, Ctrl+C, arrow keys).
- **[Adopt & relay sessions](https://deepcoldy.github.io/botmux/en/adopt)** — running halfway in local tmux, `/adopt` it from your phone; `/relay` moves the whole session (same process, same memory) into a team group to continue.
- **[Scheduled tasks & Webhook](https://deepcoldy.github.io/botmux/en/schedule)** — configure recurring tasks in natural language (alert analysis / group summaries), or trigger programmatically from external systems via [Webhook / API](https://deepcoldy.github.io/botmux/en/webhook).
- **[On-call mode & voice summary](https://deepcoldy.github.io/botmux/en/oncall)** — pull it into an on-call group and any member's @ triggers a probe in the project dir; a one-tap 🔊 voice summary on every card footer makes the model "speak plainly".

More: [Roles & teams](https://deepcoldy.github.io/botmux/en/roles) · [File sandbox](https://deepcoldy.github.io/botmux/en/sandbox) · [Dashboard](https://deepcoldy.github.io/botmux/en/dashboard) · [tmux persistence](https://deepcoldy.github.io/botmux/en/tmux) · [VC meeting agent](https://deepcoldy.github.io/botmux/en/voice).

## Supported CLIs

Switch with `cliId` in `bots.json`; processes are fully isolated. **24 built-in adapters**:

`claude-code` · `codex` · `codex-app` · `gemini` · `cursor` · `opencode` · `antigravity` · `copilot` · `grok` · `kimi` · `kiro-cli` · `pi` · `oh-my-pi` · `aiden` · `coco` · `traex` · `mtr` · `hermes` · `mira` · `mir` · `genius` · `seed` · `relay` · `riff` (cloud agent)

See [CLI Adapters](https://deepcoldy.github.io/botmux/en/adapters).

## Design Philosophy: Bridge the CLI Directly, No SDK Wrapper

botmux doesn't reimplement memory, context management, tool calls, or permission systems — the CLIs iterate on all of that themselves. botmux bridges the complete CLI process and rides that evolution: **every CLI upgrade benefits botmux with zero adaptation**. You keep talking in plain language; the daemon wraps context into structured prompts behind the scenes before feeding the CLI.

Compared with approaches that rebuild everything on an Agent SDK:

| Dimension | botmux | Agent-SDK-based approach |
|------|--------|--------------------------|
| Architecture | Bridges the complete CLI process | Rebuilt on an SDK |
| CLI capabilities | Full runtime (hooks / memory / plan mode / MCP / `/` commands) | A subset of the SDK API; missing features hand-built |
| CLI upgrades | Benefit automatically, zero adaptation | Must track SDK version changes |
| Memory / context | Reuses the CLI's built-in, improves as the CLI iterates | Must be self-built, duplicating native CLI capabilities |
| Multi-CLI | 24 switchable in one line | Usually bound to a single SDK |
| Multi-bot | Multi-bot @mention routing in one group | Usually single-bot |
| Direct terminal | `tmux attach` into the real process, same as local dev | Usually can't operate the underlying terminal |

## Docs · Community · Contributing

- 📖 **Full docs** (commands / config / best practices / troubleshooting): **<https://deepcoldy.github.io/botmux/en/>**
- ✨ **Showcase** (illustrated + video): [*Create a really useful Feishu assistant in 5 minutes*](https://bytedance.larkoffice.com/wiki/UBOXwH01CixfxfkqxUpcKgvQnsg)
- ❓ **FAQ / troubleshooting**: [FAQ](https://deepcoldy.github.io/botmux/en/faq) · [Common Pitfalls](https://deepcoldy.github.io/botmux/en/pitfalls)
- 🤝 **Contributing**: issues / PRs welcome. To add a CLI adapter, see [CLI Adapters](https://deepcoldy.github.io/botmux/en/adapters).
- 📄 **License**: [MIT](LICENSE)

<p align="center">If it's useful, drop a ⭐ Star → <a href="https://github.com/deepcoldy/botmux">deepcoldy/botmux</a></p>
