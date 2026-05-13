# 打包说明

本项目提供了一键打包脚本，会自动完成前端构建、测试、Rust 检查、Tauri 打包、复制产物和生成 SHA256。

## Windows 双击/命令行方式

在项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-release.ps1
```

或者：

```cmd
scripts\package-release.cmd
```

也可以用 npm script：

```bash
npm run package:release
```

## 可选参数

跳过 JS 测试：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-release.ps1 -SkipTests
```

跳过 `cargo check`：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-release.ps1 -SkipCargoCheck
```

两个都跳过：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-release.ps1 -SkipTests -SkipCargoCheck
```

## 输出产物

打包完成后，文件会复制到：

```text
release/
```

包括：

```text
release/pi-ide-desktop.exe
release/pi-ide-desktop_<version>_x64-setup.exe
release/pi-ide-desktop_<version>_x64_en-US.msi
release/SHA256SUMS-<version>.txt
```

其中 `<version>` 来自 `package.json`。
