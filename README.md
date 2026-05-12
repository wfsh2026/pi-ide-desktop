# Pi IDE Desktop

<img width="1280" height="820" alt="image" src="https://github.com/user-attachments/assets/2895085c-6c81-4d9c-8c0c-a22f1dd6d573" />


这是一个给 https://pi.dev/ 的 Pi AI 开发工具准备的轻量桌面 IDE 容器。

它不是替代 Pi CLI，而是把 Pi CLI 包进一个更方便的桌面界面里：

- 嵌入式终端输出，支持 ANSI 彩色输出。
- 独立增强输入框，支持多行编辑、鼠标快速定位、复制粘贴、`Ctrl/⌘ + Enter` 执行。
- 支持拖拽文件到窗口，自动把文件路径插入输入框。
- 支持“插入文件”按钮选择文件路径。
- 命令历史保存到本地文件。
- 本地会话树保存到本地文件，每发送一条指令就生成一个节点。
- 支持 Windows 和 macOS，通过 Tauri 打包。

## 1. 前置环境

### 必需

1. Node.js 18+
2. Rust stable
3. pnpm 或 npm
4. 已安装 Pi CLI，并且终端里能执行：

```bash
pi --version
```

如果你的 Pi 命令不是 `pi`，可以在软件左侧的“Pi 命令”里填完整路径，例如：

```bash
/opt/homebrew/bin/pi
```

Windows 示例：

```powershell
C:\Users\你的用户名\AppData\Roaming\npm\pi.cmd
```

也可以通过环境变量指定：

```bash
export PI_IDE_PI_BIN="/your/path/pi"
```

## 2. 安装依赖

解压后进入目录：

```bash
cd pi-ide-desktop
pnpm install
```

没有 pnpm 时可用：

```bash
npm install
```

## 3. 开发运行

```bash
pnpm tauri:dev
```

或：

```bash
npm run tauri:dev
```

启动后：

1. 左侧确认 `Pi 命令` 是 `pi` 或你的 Pi CLI 路径。
2. 可选择工作目录。
3. 点击“启动”。
4. 在底部增强输入框输入任务。
5. 按 `Ctrl + Enter` / `⌘ + Enter` 或点击“发送”。

## 4. 打包

```bash
pnpm tauri:build
```

构建产物位置通常在：

```bash
src-tauri/target/release/bundle/
```

Windows 通常会生成 `.msi` 或 `.exe` 安装包。
macOS 通常会生成 `.app` 或 `.dmg`。

## 5. 本地数据位置

应用会自动创建：

```bash
~/.pi-ide/
```

包含：

```bash
~/.pi-ide/history.json
~/.pi-ide/sessions.json
```

软件左侧会显示本地存储目录，并提供复制按钮。

## 6. 测试清单

### A. Pi 启动测试

1. 打开应用。
2. 点击“启动”。
3. 终端区域应该显示 Pi 的启动输出或欢迎信息。

如果启动失败，先在系统终端中确认：

```bash
pi --version
pi
```

### B. 输入框测试

1. 在底部输入框输入多行文本。
2. 用鼠标点击中间任意位置，确认光标可快速定位。
3. 按 `Ctrl/⌘ + Enter` 执行。
4. 终端中应该出现你发送的命令。

### C. 文件拖拽测试

1. 从 Finder / Windows Explorer 拖一个文件到应用窗口。
2. 输入框中应该插入文件路径。
3. 也可以点击“插入文件”按钮选择文件。

### D. 命令历史测试

1. 连续发送几条命令。
2. 右侧“命令历史”应出现记录。
3. 点击历史项，命令会回填到底部输入框。
4. 关闭并重新打开应用，历史仍应存在。

### E. 会话树测试

1. 发送第一条命令，会生成根节点。
2. 点击某个会话节点，再发送新命令，会在该节点下生成子节点。
3. 点击顶部“发送 /tree”，会把 `/tree` 发送给 Pi CLI，同时本地会话树也会保存这个动作。
4. 关闭并重新打开应用，会话树仍应存在。

### F. 清空测试

点击顶部“清空历史/会话”，确认：

- 右侧历史为空。
- 右侧会话树为空。
- `~/.pi-ide/history.json` 与 `~/.pi-ide/sessions.json` 被清空为 `[]`。

## 7. 已知限制

- 这个版本是轻量 MVP，核心目标是把 Pi CLI 包进桌面 IDE 容器。
- 文件拖拽路径在部分浏览器/WebView 安全策略下可能只返回文件名；此时请使用“插入文件”按钮，它通过 Tauri 原生文件对话框获取完整路径。
- 会话树是本地辅助树，不等同于 Pi 内部的完整对话树；`/tree` 按钮会把 Pi 自己的 `/tree` 指令发送给 CLI。
- 目前没有内置自动安装 Pi CLI，需要你先按 pi.dev 的方式安装 Pi。

## 8. 目录结构

```text
pi-ide-desktop/
├─ src/
│  ├─ App.jsx
│  ├─ main.jsx
│  ├─ styles.css
│  └─ components/
│     ├─ PiTerminal.jsx
│     ├─ HistoryPanel.jsx
│     └─ SessionTree.jsx
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  ├─ build.rs
│  ├─ capabilities/default.json
│  └─ src/main.rs
├─ package.json
├─ vite.config.js
└─ README.md
```
