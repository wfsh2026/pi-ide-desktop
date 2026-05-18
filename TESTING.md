# Pi Agent Dock 测试步骤

## 快速冒烟测试

```bash
cd pi-agent-dock-desktop
pnpm install
pnpm tauri:dev
```

打开应用后依次测试：

1. 左侧 Pi 命令填 `pi`。
2. 点击“启动”。
3. 底部输入：

```text
hello
```

4. 按 `Enter`。
5. 可选：在输入框中按 `Ctrl/⌘ + Enter`，确认会插入换行而不是发送。
6. 确认右侧历史出现 `hello`。
7. 确认右侧会话树出现 `hello` 节点。
8. 点击“插入文件”，选一个文件，确认路径插入输入框。
9. 关闭应用重新打开，确认历史和会话树仍然存在。

## 数据文件检查

macOS / Linux：

```bash
cat ~/.pi-ide/history.json
cat ~/.pi-ide/sessions.json
```

Windows PowerShell：

```powershell
Get-Content $HOME\.pi-ide\history.json
Get-Content $HOME\.pi-ide\sessions.json
```
