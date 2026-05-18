# Pi Agent Dock

<img width="1282" height="852" alt="image" src="https://github.com/user-attachments/assets/8c388592-e46e-4709-a43f-a6bc4e567623" />


中文名：Pi 智能体工作坞。

面向 [Pi Coding Agent](https://pi.dev/) 的 Windows 桌面智能体工作坞，基于 Tauri + React + xterm.js。

将 Pi CLI 包装为桌面应用，提供项目管理、会话管理、终端交互、会话视图、目录树、文件追踪等能力。

## 环境要求

| 依赖 | 版本要求 |
|---|---|
| Windows | x64 |
| Node.js | 18+ |
| Rust | stable |
| Pi CLI | >= 0.74.0（`@earendil-works/pi-coding-agent`） |

安装或更新 Pi CLI：

```bash
npm install -g --force @earendil-works/pi-coding-agent
```

旧包 `@mariozechner/pi-coding-agent` 已不推荐使用。

Subagent 展示由 Pi Agent Dock 原生支持，但不强制安装任何第三方扩展。应用会识别 `subagent` / `run_subagent` / `agent` 工具调用，并在会话视图中生成可展开的子 Agent 卡片；自定义 Pi 扩展也可以写入 `.pi/pi-ide-events.jsonl` 的 `kind: "subagent"` 事件来接入同一套展示。

## 核心功能

### Pi 终端

- Tauri PTY 承载 Pi CLI，原始终端渲染（ANSI 彩色、TUI 支持）
- 支持多行启动命令（设置环境变量后再启动 Pi）
- xterm viewport 原生滚动条

### 项目与会话

- 左侧项目列表，支持添加项目目录
- 每个项目下可创建多个 Pi 会话
- 会话间独立的 Pi 进程，切换会话不影响其他会话
- 会话右键菜单：重命名、归档
- 项目右键菜单：在资源管理器打开

### 增强输入

- 底部多行输入框，`Enter` 发送，`Ctrl/Cmd + Enter` 插入换行
- 支持“插入文件”选择文件路径
- 支持从系统文件管理器拖入文件
- 支持从右侧目录树拖入文件

### 会话视图

- 结构化展示用户消息、AI 回复、工具调用和结果
- Markdown 渲染：表格、代码高亮、列表
- 折叠展开工具执行详情
- AI 参考文件 / AI 输出文件追踪

### 目录树

- 右侧懒加载项目目录树
- 支持搜索文件或目录（文件名 / 路径匹配 + 高亮）
- 文件双击以系统默认程序打开
- 文件可拖动到会话框

### Pi 环境设置

- 点击顶部“环境设置”检测 Pi 安装状态和模型配置
- 支持一键安装 Pi CLI
- 显示 Pi 版本、模型数量、配置路径

### Pi 文件事件追踪

- IDE 启动 Pi 时自动注入项目级 extension
- 精确追踪 Pi `read` → AI 参考文件
- 精确追踪 Pi `write/edit` → AI 输出文件
- bash 变更通过 git diff 检测

## 快速开始

### 开发运行

```bash
cd pi-agent-dock-desktop
npm install
npm run tauri:dev
```

### 打包

```bash
npm run package:release
```

产物：

```text
release/pi-agent-dock-desktop_2.0.0_x64-setup.exe
release/pi-agent-dock-desktop_2.0.0_x64_en-US.msi
release/pi-agent-dock-desktop.exe
release/SHA256SUMS-2.0.0.txt
```

## 本地数据位置

```text
~/.pi-ide/
├─ config.json          # 全局配置
├─ projects.json        # 项目索引
├─ pi-sessions/         # 会话日志和终端输出
└─ launch-scripts/      # 启动脚本
```

项目级配置：

```text
项目目录/.pi.ide/config.json
```

## 界面概览

```text
┌────────────┬──────────────────────┬────────────┐
│  项目列表   │    终端 / 会话视图    │  工具面板   │
│            │                      │  目录树     │
│  项目 A    │   Pi 终端输出         │  会话文件   │
│  ├ 会话 1  │                      │            │
│  ├ 会话 2  │                      │            │
│  项目 B    │                      │            │
│            ├──────────────────────┤            │
│            │  增强输入框           │            │
│            │  [插入文件] [发送]    │            │
└────────────┴──────────────────────┴────────────┘
```

## 配置

全局配置 `~/.pi-ide/config.json` 和项目配置 `<project>/.pi.ide/config.json` 支持：

| 配置项 | 说明 | 默认值 |
|---|---|---|
| `pi.command` | Pi 启动命令 | `pi` |
| `pi.minVersion` | 最低 Pi 版本 | `0.74.0` |
| `piSession.backgroundIdleStopMinutes` | 后台空闲自动关闭 | `5` |
| `debug.enabled` | 调试日志开关 | `false` |
| `directoryTree.initialDepth` | 初始加载深度 | `0` |
| `directoryTree.maxEntriesPerDirectory` | 单层最大条目 | `160` |
| `storage.terminalPreviewChars` | 终端预览长度 | `256KB` |

## 目录结构

```text
pi-agent-dock-desktop/
├─ src/
│  ├─ App.jsx                         # 主应用
│  ├─ main.jsx                        # 入口
│  ├─ styles.css                      # 样式
│  ├─ projectStorageModel.js          # 项目存储模型
│  ├─ sessionTimelineModel.js         # 会话视图模型
│  ├─ sessionMarkdownTableModel.js    # 表格解析
│  ├─ piIdeEventMapper.js             # Pi 事件映射
│  └─ components/
│     ├─ PiTerminal.jsx               # 嵌入式终端
│     ├─ SessionTimeline.jsx          # 会话视图
│     └─ AppErrorBoundary.jsx         # 错误边界
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  └─ src/main.rs                     # Tauri 后端
├─ package.json
├─ vite.config.js
└─ scripts/
   └─ package-release.ps1             # Windows 打包脚本
```

## 已知限制

- 仅支持 Windows x64
- 若启动参数含 `--no-extensions`，文件精确追踪不生效
- `bash` 内部文件读写无法像 `read/write/edit` 一样 100% 结构化确认
- 当前中央区域以终端和会话视图切换为主，尚未实现完整结构化消息流
