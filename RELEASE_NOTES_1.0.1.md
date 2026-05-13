# pi-ide-desktop V1.0.1 发布说明

发布日期：2026-05-12
分支：`V1.0.1`

## 版本定位

V1.0.1 是基于 V1.0.0 的验收修订版本，主要用于汇总当前已完成的多会话状态修复、界面精简、黑灰配色以及重新打包产物。

## 本版本重点

- 基于当前最新代码重新打包安装包。
- 创建独立 `V1.0.1` 分支用于验收。
- 版本号升级到 `1.0.1`。
- 保留 V1.0.0 的整体功能说明文档。
- 提交对应安装包到仓库，方便直接下载验收。

## 主要能力继承

V1.0.1 继承 V1.0.0 的完整功能：

- Pi CLI 桌面终端承载。
- 多项目、多会话管理。
- 多行启动命令与 `.bat` 启动脚本。
- Windows Release 包无额外控制台窗口。
- 目录树、目录搜索、文件拖拽。
- 会话文件：AI 参考文件 / AI 输出文件。
- Pi `read/write/edit` 工具事件精确追踪。
- 黑灰中性风格界面。
- 顶部工具栏精简。

## 验收产物

本分支提交以下 Windows x64 产物：

```text
release/pi-ide-desktop.exe
release/pi-ide-desktop_1.0.1_x64-setup.exe
release/pi-ide-desktop_1.0.1_x64_en-US.msi
```

建议优先使用：

```text
release/pi-ide-desktop_1.0.1_x64-setup.exe
```

## 构建验证

本版本已执行：

```bash
npm run build
cargo check
npm run tauri:build
```
