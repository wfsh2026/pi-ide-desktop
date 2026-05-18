# Pi Agent Dock 2.0.1 发布说明

发布日期：2026-05-18
分支：`main`

## 版本定位

V2.0.1 是 Pi Agent Dock 的改名发布版本，重点统一产品命名、应用显示名、包名、打包产物名和项目文档。

## 本版本重点

- 产品名和应用显示名统一为 `Pi Agent Dock`。
- 中文名统一为 `Pi 智能体工作坞`。
- 仓库和包名统一为 `pi-agent-dock-desktop`。
- Tauri 产品名、窗口标题、应用 identifier、Cargo 包名和 npm 包名同步更新。
- Windows 右键菜单显示为 `Open with Pi Agent Dock`。
- 打包脚本输出新的 release 产物名。
- README、测试说明、发布说明和优化文档同步更新。

## 兼容说明

为避免升级后丢失历史数据或破坏 Pi 事件桥，本版本继续保留以下内部兼容标识：

- `~/.pi-ide/`
- `<project>/.pi.ide/config.json`
- `.pi/pi-ide-events.jsonl`
- `.pi/pi-ide-file-events.jsonl`
- `PI_IDE_*`
- `pi-ide-*` 内部命令与事件源

启动时会清理旧的 `OpenWithPiDesktop` 右键菜单 key，避免升级后出现重复菜单。

## 构建产物

```text
release/pi-agent-dock-desktop.exe
release/pi-agent-dock-desktop_2.0.1_x64-setup.exe
release/pi-agent-dock-desktop_2.0.1_x64_en-US.msi
release/SHA256SUMS-2.0.1.txt
```

建议优先使用：

```text
release/pi-agent-dock-desktop_2.0.1_x64-setup.exe
```

## 验证

本版本已执行：

```bash
npm test
npm run build
cargo check
cargo test
```
