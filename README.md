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

<p align="center"><b>在飞书里遥控你的 AI 编程 CLI。</b>一条消息启动一个会话，每个会话一个独立 CLI 进程，实时流式回传——手机、电脑、终端三端同步。</p>

<p align="center">
  <a href="https://deepcoldy.github.io/botmux/"><b>📖 文档</b></a> ·
  <a href="#5-分钟接入"><b>🚀 快速接入</b></a> ·
  <a href="https://bytedance.larkoffice.com/wiki/UBOXwH01CixfxfkqxUpcKgvQnsg"><b>✨ 效果展示</b></a> ·
  <a href="README.en.md">English</a>
</p>

<p align="center">
  <img src="gif/fold&unfold.gif" width="640" alt="飞书流式卡片实时回传 CLI 输出">
</p>

---

Daemon 监听飞书消息，为每个新会话自动 spawn 一个独立的 AI 编程 CLI 进程，把 CLI 的输出实时流式回传成飞书卡片，并提供可交互的 Web 终端。它**不重造 Agent 能力**，而是直接桥接你已经在用的 CLI（`botmux` 内置 **24 种适配器**，见 [支持的 CLI](#支持的-cli)）。

## 它解决什么

- **Agent 收不到通知、手机控不了** — CLI 跑在开发机上，人在手机上。botmux 把每轮输出推成飞书卡片，随时随地查看 / 追问 / 打断，还能开可写 Web 终端直接操作。
- **CLI 不感知飞书上下文** — 把机器人拉进话题群 / oncall 群，@ 一句就在你本机的代码库里开跑；会话可以用 `/relay` 原样搬到另一个群，上下文一点不丢。
- **单个 Agent 不够用** — 同一个群里放多个不同 CLI 的机器人，@ 谁谁干活，让 Claude Code 和 Codex 一起 review 同一个 MR、各自独立分析、观点不同自动互怼。

## 5 分钟接入

> 扫码建应用 + 配权限走一遍，约 5 分钟。字节内部同学见 [一行命令接入](https://deepcoldy.github.io/botmux/quickstart)。

```bash
npm install -g botmux        # 需要 Node >= 22
botmux setup                 # 扫码建机器人 → 选 CLI → 选工作目录 → 扫码配权限
botmux start                 # 启动 daemon（botmux autostart enable 设开机自启）
```

然后私聊机器人、或 `botmux dashboard` 拉个群，直接开聊。完整步骤（含截图、内部一键接入、代理配置）见 **[5 分钟快速接入](https://deepcoldy.github.io/botmux/quickstart)**。

## 核心场景

- **[实时流式卡片](https://deepcoldy.github.io/botmux/cards)** — 每轮对话一张实时刷新的卡片，终端画面原样截图回传；一键显示/隐藏输出、翻屏、重启/关闭/接管会话。
- **[多机器人协作](https://deepcoldy.github.io/botmux/multi-bot)** — 同群多 bot @mention 路由，不同 CLI 背后不同模型，天然多样性；方案评审 / 代码 review / 技术选型让它们互相挑刺。
- **[多话题并行编排](https://deepcoldy.github.io/botmux/multi-topic)** — 给编排者一个大任务，它自动在群里种话题、拉各 bot 起独立会话跑流水线，飞书任务面板一眼看完所有子任务进度。
- **[可交互 Web 终端](https://deepcoldy.github.io/botmux/web-terminal)** — 不只是看输出，浏览器 / 手机直接操作 CLI，移动端带悬浮快捷键栏（Esc、Ctrl+C、方向键）。
- **[会话接入 & 接力](https://deepcoldy.github.io/botmux/adopt)** — 本地 tmux 里跑到一半，手机 `/adopt` 接管；`/relay` 把整个会话（原进程、原记忆）搬进团队群继续。
- **[定时任务 & Webhook](https://deepcoldy.github.io/botmux/schedule)** — 自然语言配周期任务（报警分析 / 群总结），或用 [Webhook / API](https://deepcoldy.github.io/botmux/webhook) 从外部系统编程式触发。
- **[Oncall 模式 & 语音总结](https://deepcoldy.github.io/botmux/oncall)** — 拉进 oncall 群，任何成员 @ 即在项目目录排查；每张卡片页脚一键 🔊 语音总结，让模型「说人话」。

更多：[角色与团队](https://deepcoldy.github.io/botmux/roles) · [文件沙盒](https://deepcoldy.github.io/botmux/sandbox) · [Dashboard 管控面](https://deepcoldy.github.io/botmux/dashboard) · [tmux 会话常驻](https://deepcoldy.github.io/botmux/tmux) · [飞书会议智能体](https://deepcoldy.github.io/botmux/voice)。

## 支持的 CLI

`bots.json` 里用 `cliId` 一键切换，进程完全隔离。内置 **24 种适配器**：

`claude-code` · `codex` · `codex-app` · `gemini` · `cursor` · `opencode` · `antigravity` · `copilot` · `grok` · `kimi` · `kiro-cli` · `pi` · `oh-my-pi` · `aiden` · `coco` · `traex` · `mtr` · `hermes` · `mira` · `mir` · `genius` · `seed` · `relay` · `riff`（云 agent）

详见 [多 CLI 适配器](https://deepcoldy.github.io/botmux/adapters)。

## 设计理念：直接桥接 CLI，不做 SDK wrapper

botmux 不重新实现记忆、上下文管理、工具调用、权限体系——这些能力 CLI 本身都在快速迭代。botmux 直接桥接完整的 CLI 进程，站在这个进化之上：**CLI 每次升级，botmux 零适配自动受益**。用户照常发人话，daemon 在后台把上下文封装成结构化 prompt 再喂给 CLI。

与基于 Agent SDK 重造一套的方案相比：

| 维度 | botmux | 基于 Agent SDK 的方案 |
|------|--------|----------------------|
| 底层架构 | 直接桥接完整 CLI 进程 | 基于 SDK 重新构建 |
| CLI 能力 | 完整运行时（hooks / memory / plan mode / MCP / `/` 命令） | SDK API 子集，缺失功能需手动补 |
| CLI 升级 | 零适配自动受益 | 需跟进 SDK 版本变更 |
| 记忆 / 上下文 | 直接复用 CLI 内建，随 CLI 迭代增强 | 需自建，与 CLI 原生能力重复 |
| 多 CLI | 24 种一键切换 | 通常绑定单一 SDK |
| 多机器人 | 同群多 bot @mention 路由 | 通常单机器人 |
| 终端直连 | `tmux attach` 进真进程，与本地开发一致 | 通常无法直接操作底层终端 |

## 文档 · 社区 · 贡献

- 📖 **完整文档**（命令 / 配置 / 最佳实践 / 排错）：**<https://deepcoldy.github.io/botmux/>**
- ✨ **效果展示**（图文 + 视频演示）：[《5 分钟创建一个真正好用的飞书助理》](https://bytedance.larkoffice.com/wiki/UBOXwH01CixfxfkqxUpcKgvQnsg)
- ❓ **常见问题 / 排错**：[FAQ](https://deepcoldy.github.io/botmux/faq) · [常见踩坑](https://deepcoldy.github.io/botmux/pitfalls)
- 🤝 **贡献**：欢迎 issue / PR。新增 CLI 适配器见 [多 CLI 适配器](https://deepcoldy.github.io/botmux/adapters)。
- 📄 **License**：[MIT](LICENSE)

<p align="center">好用的话，顺手点个 ⭐ Star 吧 → <a href="https://github.com/deepcoldy/botmux">deepcoldy/botmux</a></p>
