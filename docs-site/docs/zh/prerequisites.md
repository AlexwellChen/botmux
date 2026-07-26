# 前置要求

装 botmux 之前，先确认这几样齐了——**90% 的「装完连不上 / 会话起不来」都是这里缺件**（Node 版本、CLI 没登录、PATH 里找不到）。

**适用**：任何要跑 botmux daemon 的机器（开发机 / devbox / 服务器）。
**不适用**：你只是在别人已部署好的群里 @ 机器人用——那不需要本机装任何东西。

## 运行环境

- **Node.js ≥ 22**（`node -v` 确认；低于 22 会有原生模块 / 语法报错）。
- **AI 编程 CLI / 本地 Agent 应用**：至少一种**已安装并完成认证**、可执行文件在 `PATH` 中：
  - `claude`（Claude Code）、`codex`、`cursor-agent`（Cursor）、`gemini`、`opencode`、`coco`（Trae / CoCo）、`agy`（Antigravity）、`hermes` 等（完整 `cliId` 见 [多 CLI 适配器](/adapters)）。
  - ⚠️ botmux 只是桥接层，不代管登录——**先在终端里手动跑一次该 CLI 确认能对话**，再接 botmux。
- **tmux ≥ 3.x**（可选，强烈推荐）：安装后自动启用会话常驻——daemon 重启不中断 CLI（见 [tmux 会话常驻](/tmux)）。

## 推荐部署形态

推荐部署在**常开的开发机 / devbox** 上（而非笔记本），这样 daemon 长期在线、tmux 会话常驻、随时手机遥控。配合 `botmux autostart enable` 实现重启自恢复。

## 常见失败

- `node -v` < 22 → 升级 Node（nvm / fnm 装 22+，注意让 botmux 所在 shell 的启动文件能读到）。
- CLI 没在 PATH / 没登录 → 会话起不来或首条消息无响应；先手动跑通 CLI，再看 [FAQ · 会话起不来](/faq)。
- 装了 CLI 但 botmux 找不到 → PATH 在非交互 shell 里没生效，见 [常见踩坑](/pitfalls)。

**下一步**：环境齐了就去 [5 分钟快速接入](/quickstart)。
