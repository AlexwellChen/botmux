# CLI 适配器

每种 CLI 一个文件，实现 `types.ts` 里的 `CliAdapter` 接口。

## 添加新 CLI 适配器

1. 本目录下创建新文件，实现 `CliAdapter` 接口
2. `types.ts` 的 `CliId` 联合类型中添加新 ID
3. `registry.ts` 添加 import、switch case、export
4. `src/worker.ts` 的 `CLI_DISPLAY_NAMES` 添加显示名
5. `src/im/lark/card-builder.ts` 的 `cliDisplayNames` 添加显示名
6. `src/setup/bot-config-editor.ts` 的 `CLI_ID_CHOICES`（序号映射，**新 CLI 一律追加到尾部**——历史序号是脚本化 setup 的稳定接口，插位会让老脚本静默选错）+ `CLI_DISPLAY_LABELS`（dashboard 添加机器人下拉的展示名，缺了会回退显示 id）。setup 级联菜单、dashboard 下拉与 sessions 页 CLI 过滤器均从 `CLI_OPTIONS` 派生，自动跟随，无需另改
7. `README.md`、`README.en.md` 更新 CLI 列表

## 文件沙盒（`sandbox: true`）适配三项必查

新 CLI 若要支持文件沙盒，务必逐项核对（经验来自 #356/#357…，即 codex/opencode/mtr/traex/coco 的踩坑）。当前沙盒模型是 **fresh tmpfs 根 + 按 policy 逐条 `--bind`**（`fs-policy.ts` 编译 bwrap：`--tmpfs /` 起底，只把 allow 规则的真实宿主路径直接 bind 进来，deny 用 mode-000 空 tmpfs 遮罩）——**不再是** overlayfs/upper 模型。`authPaths` 列出的路径以真实可写 `--bind` 暴露：

1. **CLI 是否在 `$HOME` 下放 SQLite/DB？** tmpfs 根下若不 bind 该目录，CLI 连自己的状态目录都看不到；且一个非真实 bind（如遮罩/tmpfs）无法承载 SQLite 需要的 POSIX fcntl 字节范围锁，CLI 会连接池超时（~57s）后 exit 1 起不来。→ 把整个状态目录（而非单个 `auth.json`）加进 `authPaths`，让它以真实宿主 `--bind` 暴露、锁可用、状态持久。
2. **daemon 的 transcript bridge 是否按真实路径读该 CLI 的会话/事件文件？** 窄 carve-out 下该目录未被 bind，bridge 在真实路径读不到 → 回复桥断链。claude 系有 `sandboxedClaudeDataDir`/BOT_HOME 重定向兜底，其它 CLI 没有。→ 让 bridge 读的目录也真实 `--bind`（如 coco 的 `~/.cache/coco`）。
3. **`authPaths` 是目录级还是单文件？** 单文件 carve-out 在该文件尚不存在时会被存在性过滤整段跳过（bwrap 无法 bind 不存在的源，沙盒内首次登录无处落盘），也覆盖不到同目录的 sibling 状态。→ 优先目录级 bind。

⚠️ 注意与「读隔离/重定向」的交互：claude 家族 + codex 若 `supportsReadIsolation`，沙盒开启时 CLI 数据会被重定向到 BOT_HOME（`CLAUDE_CONFIG_DIR`/`CODEX_HOME`），此时 worker 会把落在**宿主原数据根之内**的 `authPaths` 丢弃（见 `authPathsSurvivingCliDataRedirect`）——避免把 CLI 根本不读的宿主目录（如整个 `~/.codex` 的 history/sessions）暴露进沙盒；落在数据根之外的登录源（如 Seed/Relay 的 `~/.local/share/bytedcli`）才保留。新增声明 `authPaths` 的 claude 家族适配器需想清这条。

验证手段：用 `prepareSandbox` 生成真实 bwrap argv + `node-pty` 拉起真 CLI 跑 ≥90s，观察是否崩、并核对写入是否落到真实目录（见 `test/sandbox.test.ts` 的 symlink 回归用例）。
