# Pi IDE 性能与稳定性优化进度

更新时间：2026-05-13

## 目标

解决 Pi IDE 在长时间使用、长输出、长内容分析、多会话并发时出现的卡顿、崩溃、存储膨胀和高频 I/O 问题。优化原则是先止血，再逐步把结构化能力迁移到 Pi RPC 或 Pi extension。

## 成功标准

1. 长时间输出不会让 `localStorage` 无限增长。
2. 终端视图只加载可控长度的历史输出。
3. `.pi/pi-ide-events.jsonl` 不再被前端周期性全量读取和解析。
4. Pi extension 不再把高频流式文本重复写入事件文件。
5. debug 日志默认关闭，未开启时前后端不写入 debug 日志，入口按钮不可见。
6. 旧版本产生的异常缓存可以在设置中一键清理，且不删除 Pi 原生会话。
7. 构建、现有 JS 测试、Rust 后端检查通过。

## 优先级列表

| 优先级 | 编号 | 优化项 | 问题 | 方案 | 当前进度 | 验证方式 |
|---|---|---|---|---|---|---|
| P0 | P0-1 | 终端长输出存储拆分 | `session.output` 无限追加并写入 `localStorage`，长会话会卡顿或崩溃 | 后端按会话追加写入 `terminal.log`，前端只保存短预览 | 已完成，已通过验证 | 长输出后检查 `localStorage` 不再线性膨胀，构建通过 |
| P0 | P0-2 | 限制终端内存和历史回放 | xterm `scrollback` 过大，切换会话 replay 全量输出 | 降低并配置 scrollback，只读取后端日志尾部回放 | 已完成，已通过验证 | 切换长会话只回放尾部内容 |
| P0 | P0-3 | 事件读取改增量 | 每 1.2 秒全量读取 JSONL，事件文件越大越慢 | 后端记录文件 offset，只返回新增事件 | 已完成，已通过验证 | 连续轮询同一文件时第二次返回空新增 |
| P0 | P0-4 | 精简 Pi extension 高频事件 | `message_update` 和工具结果可能重复写入大文本 | 只记录 delta，最终文本和工具结果按配置截断 | 已完成，已通过验证 | 事件文件体积增长明显下降 |
| P0 | P0-5 | 旧版本异常缓存清理 | 旧版本用户已经积累大体积事件流、终端日志和 debug 日志 | 设置中增加“清理异常缓存”，清空 IDE 事件缓存、终端日志、debug 日志和本地终端预览；不删除 Pi 原生会话 | 已完成，已通过验证 | 设置触发后返回释放空间和清理文件数 |
| P1 | P1-1 | 评估 Pi RPC 主通道 | PTY 输出不适合作为结构化 UI 的主数据源 | 逐步改用 `pi --mode rpc` 获取 JSONL 事件 | 阶段 1 已完成，已通过验证 | 会话视图不依赖终端文本解析 |
| P1 | P1-2 | Pi 原生 session 对齐 | 桌面端重复维护大量会话内容 | 保存 UI 元数据，完整会话交给 Pi session JSONL | 阶段 1 已完成，已通过验证 | 重启后可以从 Pi session 恢复 |
| P1 | P1-3 | Pi extension 权限与工具治理 | bash/read/write/edit 缺少统一限制 | extension 拦截危险命令、大文件读取和大输出 | 阶段 1 已完成，已通过验证 | 危险命令可被拦截或确认 |
| P2 | P2-1 | 上下文 compaction UI | 长任务上下文成本不可见 | 显示上下文使用量，支持触发 compact | 未开始 | UI 能显示并触发压缩 |
| P2 | P2-2 | 会话视图虚拟化 | 长会话一次性渲染所有 turn | 只渲染可视区附近内容 | 已完成，已通过验证 | 长会话滚动不卡顿 |
| P2 | P2-3 | 目录树懒加载 | 当前目录树一次性读取固定深度 | 点击目录时再读取 children | 未开始 | 大项目打开目录树不卡顿 |
| P3 | P3-1 | debug 日志开关与入口屏蔽 | 高频 debug 放大 I/O 和磁盘占用，长时间使用可能加剧崩溃 | 默认关闭日志输出；通过全局或项目配置 `debug.enabled` 开启；按钮仅开启时显示 | 已完成，已通过当前验证 | 默认无 debug 写入；开启配置后按钮出现并可打开日志目录 |
| P3 | P3-2 | debug 日志按大小轮转 | 开启 debug 后日志文件仍可能持续增长 | 增加最大文件大小和轮转数量配置 | 未开始 | 日志文件大小受控 |

## 当前实现风险记录

- P0 已把终端完整输出从 `localStorage` 拆到后端会话日志，但当前仍保留短预览；预览长度需要继续保持可配置。
- P1 已减少本地项目/会话元数据体积，但完整的 Pi session 恢复仍依赖后续 RPC 或更完整的 JSONL 对齐。
- Pi extension 已增加危险命令和大输出治理，但后续还需要把策略暴露为项目级配置，避免只靠环境变量控制。
- P3-1 已关闭默认 debug 写入，但如果用户手动开启 debug，仍需要 P3-2 的大小轮转来限制磁盘增长。
- P0-5 清理入口只处理 IDE 额外缓存，不处理 `~/.pi/agent/sessions`，避免误删 Pi 原生会话事实源。

## P1-1 RPC 迁移评估

Pi 官方支持 RPC 模式，适合 IDE 或自定义 UI 作为结构化主通道；extension 文档也说明 RPC 模式可以承载 extension UI 子协议。当前项目仍以 PTY 为主，原因是它已经承担终端视图、交互输入和现有 Pi CLI 兼容路径，直接切换默认通道风险较高。

阶段 1 结论：

1. 默认通道继续使用 PTY，避免破坏已有用户流程。
2. 会话视图和文件追踪继续依赖 Pi extension JSONL，但事件读取和事件体积已在 P0 降成本。
3. 下一阶段应新增独立 `rpc` transport 实验开关，而不是替换 `start_pi_session`。
4. RPC 通道目标能力：`prompt`、`abort`、`get_state`、`get_messages`、模型切换和 extension UI 消息。
5. 验收标准：同一个会话能在 `pty` 与 `rpc` 两个通道中启动；会话视图使用 RPC 事件，不再解析终端文本。

参考：

- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md

## 可调配置

- `piIdeTerminalPreviewChars`：本地保存的终端输出预览长度，默认 `64 * 1024`。
- `piIdeSessionTextPreviewChars`：本地保存的单段 timeline 文本预览长度，默认 `128 * 1024`。
- `piIdeSessionTurnLimit`：本地保存的最近 turn 数量，默认 `50`。
- `piIdeSessionFileRecordLimit`：本地保存的文件记录数量，默认 `500`。
- `PI_IDE_READ_LIMIT`：Pi extension 自动给 `read` 工具补上的读取行数上限，默认 `1200`。
- `PI_IDE_TOOL_RESULT_TEXT_LIMIT`：Pi extension 返回给模型的单个工具结果文本上限，默认 `50000`。
- `<项目>/.pi.ide/config.json` 或 `~/.pi-ide/config.json` 的 `storage.eventMode`：事件持久化模式，默认 `compact`，可设为 `full` 或 `off`。
- `storage.eventTextLimit`：Pi IDE 事件写入的单段文本上限，默认 `51200`。
- `storage.projectEventMaxBytes`：项目级 `.pi/pi-ide-events.jsonl` 最大保留体积，默认 `5MB`，超过后自动清空。
- `storage.terminalLogMaxBytes`：单个 IDE 会话 `terminal.log` 最大保留体积，默认 `2MB`，设置为 `0` 表示不保留终端日志。
- `PI_IDE_DANGEROUS_COMMAND_PATTERN`：危险 shell 命令正则，默认拦截 `rm -rf`、`git reset --hard`、`git clean -f`、`del /s`、`format`、`mkfs`、递归 `Remove-Item`。
- `PI_IDE_PROTECTED_PATH_PATTERN`：受保护写入路径正则，默认保护 `.env*`、`.git`、`node_modules`。
- `~/.pi-ide/config.json` 的 `debug.enabled`：全局 debug 日志开关，默认 `false`。
- `<项目>/.pi.ide/config.json` 的 `debug.enabled`：项目 debug 日志开关，默认 `false`，项目配置优先。
- `PI_IDE_SUBAGENT_DEBUG`：Subagent 事件桥接调试开关，默认关闭；设为 `true` 时写入 `subagent_trace`，用于定位工具事件是否被 Pi 暴露。

## 进度日志

- 2026-05-13：创建优化进度文档，开始 P0 优化。
- 2026-05-13：完成 P0-1。新增后端 `append_terminal_log`、`read_terminal_log_tail`、`clear_terminal_log` 命令；前端 `session.output` 改为可配置短预览，完整终端输出由后端 PTY reader 直接写入会话日志文件，避免额外高频 IPC。
- 2026-05-13：完成 P0-2。xterm `scrollback` 改为可配置默认值，终端视图和会话切换改为读取后端终端日志尾部。
- 2026-05-13：完成 P0-3。`load_pi_ide_events` 和 legacy 文件事件读取改为后端 offset 增量读取，避免运行期间重复全量解析 JSONL。
- 2026-05-13：完成 P0-4。Pi bridge extension 的 `message_update` 不再重复写完整消息；工具参数、工具结果和最终文本通过 `PI_IDE_EVENT_TEXT_LIMIT` 控制最大写入长度。
- 2026-05-13：验证通过：`npm run build`、`node src/sessionTimelineModel.test.mjs`、`node src/piIdeEventMapper.test.mjs`、`cargo check`。仍存在 Vite 单 chunk 超过 500 kB 的提示，后续通过代码拆分处理。
- 2026-05-13：完成 P1-1 阶段 1。记录 RPC 迁移评估：默认仍保留 PTY，后续以独立 transport 实验开关接入 RPC。
- 2026-05-13：完成 P1-2 阶段 1。新增 `projectStorageModel.js`，本地项目持久化只保留可配置长度的 timeline、turn 和文件记录预览。
- 2026-05-13：完成 P1-3 阶段 1。Pi bridge extension 新增危险命令拦截、受保护路径写入拦截、`read` 工具 limit 自动补齐、工具结果大文本截断。
- 2026-05-13：P1 验证通过：`npm run build`、`node src/projectStorageModel.test.mjs`、`node src/sessionTimelineModel.test.mjs`、`node src/piIdeEventMapper.test.mjs`、`cargo check`。
- 2026-05-13：完成 P3-1。新增 `debug.enabled` 配置默认值和旧配置迁移；前端、终端组件和后端 PTY 生命周期日志都按配置开关写入；未开启时隐藏“调试日志”按钮。
- 2026-05-13：P3-1 验证通过：`npm run build`、`node src/projectStorageModel.test.mjs`、`node src/sessionTimelineModel.test.mjs`、`node src/piIdeEventMapper.test.mjs`、`cargo check`。仍存在 Vite 单 chunk 超过 500 kB 的提示，属于后续代码拆分项。

## 2026-05-13 增量进度：Pi 实例生命周期控制

- 完成右键会话“关闭 Pi”入口：只关闭目标会话对应的 Pi 实例，不影响其他项目或会话。
- 完成后台会话自动关闭：后台运行且无活动的 Pi 会话按配置自动停止；当前正在使用的会话窗口不参与自动关闭。
- 默认后台空闲关闭时间为 5 分钟，配置项为 `piSession.backgroundIdleStopMinutes`；项目配置 `<项目>/.pi.ide/config.json` 优先，全局配置 `~/.pi-ide/config.json` 兜底；设置为 `0` 可关闭自动回收。
- 完成延迟启动策略：切换项目或会话不再自动启动 Pi，用户发送任务或在终端输入时才启动。
- 完成模型选择解耦：未启动 Pi 时优先从 `~/.pi/agent/settings.json` 和 `~/.pi/agent/models.json` 读取默认模型和候选模型；未运行时选择模型会记录为待应用，发送任务启动 Pi 后再应用。
- 完成顶部入口清理：移除“停止全部 Pi”和“原生终端”切换按钮；终端视图固定支持直接输入，下方输入框仍可发送任务。
- 完成目录树懒加载落地：P2-3 当前已实现，打开/切换项目时不自动读取目录树；只有用户点击右侧“目录树”工具时才加载根节点，展开目录时再按需读取 children，并由 `.pi.ide/config.json` 的 `directoryTree` 配置控制单层条目上限。
- 验证通过：`node src/projectStorageModel.test.mjs`、`node src/sessionTimelineModel.test.mjs`、`node src/piIdeEventMapper.test.mjs`、`npm run build`、`cargo check`。

## 2026-05-13 增量进度：会话视图输出与滚动优化

- 修复会话级 `output_files` 兜底总是挂到最新 turn 的问题：未绑定到结构化 timeline 的输出文件固定归属到最近一个已完成 turn，开启新一轮对话后不会继续停留在底部。
- 优化会话视图自动滚动：仅当用户原本位于底部附近时跟随新增输出；用户手动滚动查看历史内容后，新增文本不再强制把滚动条拉到底。
- 验证通过：`node src/projectStorageModel.test.mjs`、`node src/sessionTimelineModel.test.mjs`、`node src/piIdeEventMapper.test.mjs`、`npm run build`。
- 2026-05-13：针对打开项目卡顿风险进一步收紧目录树加载规则：移除切换项目时自动加载目录树的 effect，`get_directory_tree` 首次只返回根节点且不预扫描 preview lines；用户展开目录时再调用 `get_directory_children`。验证通过：`npm run build`、`node src/projectStorageModel.test.mjs`、`node src/sessionTimelineModel.test.mjs`、`node src/piIdeEventMapper.test.mjs`、`cargo check`。
- 2026-05-13：继续优化默认启动内容：项目打开/切换时不再自动执行 Pi 环境检测，只重置环境状态并等待用户点击“环境设置”或发送任务时检测；配置 ensure 延迟执行；非终端视图切换会话时延迟读取终端日志尾部。
- 2026-05-13：完成会话切换体验修复和终端滚动方案重构。会话视图移除最近记录窗口限制，恢复完整 turn 渲染，并新增 Markdown 表格渲染支持；终端视图移除自定义滚动条和 wheel 事件拦截，改为完全信任 xterm 原生 viewport 滚动，同时停止过滤 ANSI 控制序列；Pi IDE bridge 事件文本上限提升到 10000000。

## 2026-05-14 增量进度：存储降噪与异常缓存清理

- 默认存储策略改为 `compact`：Pi IDE bridge 不再持久化高频 `message_update` 和 `tool_execution_update` 事件，减少 `.pi/pi-ide-events.jsonl` 增长速度；如需完整事件，可通过 `storage.eventMode` 调整。
- 新增存储配置默认值：事件文本上限 `51200`、工具结果文本上限 `51200`、项目事件文件上限 `5MB`、单会话终端日志上限 `2MB`。
- 新增后端清理命令 `clean_pi_ide_cache`：清空 IDE debug 日志、`~/.pi-ide/pi-sessions/**/terminal.log`、已知项目的 `.pi/pi-ide-events.jsonl` 和 `.pi/pi-ide-file-events.jsonl`；明确不删除 `~/.pi/agent/sessions`。
- 新增“环境设置 -> 清理缓存”入口：用户可一键清理旧版本异常缓存，并看到释放空间和清理文件数；同时清空本地 `session.output` 终端预览缓存。
- 已同步清理异常文件内容：`F:\SausageProject\B-SplitProject\.pi\pi-ide-events.jsonl` 已从 103MB 清理到受控范围，`~/.pi-ide/pi-sessions` 下历史 `terminal.log` 已裁剪到默认上限范围。
- 验证通过：`node src/projectStorageModel.test.mjs`、`node src/sessionTimelineModel.test.mjs`、`node src/piIdeEventMapper.test.mjs`、`node src/sessionMarkdownTableModel.test.mjs`、`npm run build`、`cargo test config_tests -- --nocapture`、`cargo check`。
- 修复 Pi IDE bridge 对 `message.content` 类型的错误假设：`textContent`、`messageContentSummary` 和 `compactToolContent` 现在统一兼容字符串、数组和对象，避免 `content.map is not a function` 扩展运行时报错；已同步更新当前项目的 `.pi/extensions/pi-ide-file-tracker.ts`。
- 修复 `localStorage` 配额满导致消息无法发送的问题：项目缓存写入失败时自动降级为瘦身快照，仍失败则只保留内存态并提示，不再中断 `sendCommand` 到 Pi 的发送链路；默认本地缓存上限同步收紧。

## 2026-05-15 增量进度：Subagent 记录兼容与调试

- 对照 `pi.dev` 与 `nicobailon/pi-subagents`：开源最新版通过 `pi.registerTool({ name: "subagent" })` 暴露原生 `subagent` 工具；Agent 定义文件位于 `.pi/agents/**/*.md`，可选通过 `pi-intercom` 做父子会话协调。
- 本地运行环境的 `pi-subagents 0.24.0` 中 `pi.registerTool(tool)` 被注释，当前会话实际只暴露 `read/bash/edit/write/intercom` 等工具，因此右侧 Subagent 不能只依赖 `toolName: "subagent"`。
- IDE 事件映射新增兼容路径：原生 `subagent/run_subagent/agent` 工具事件继续记录；`.pi/agents/*.md` 的 `write/edit` 记录为“子 Agent 已定义”；`intercom` 工具记录为跨会话子 Agent 委托。
- Pi IDE bridge 新增 `subagent_trace` 调试事件，默认不写入；只有 `debug.enabled` 或 `PI_IDE_SUBAGENT_DEBUG` 开启时记录工具名、阶段、识别结果和输入字段。
- 前端只在调试开启时写入 Subagent trace/debug 日志；默认状态不增加日志 I/O。
- 验证通过：`node src/piIdeEventMapper.test.mjs`、`node src/subagentSummary.test.mjs`。
