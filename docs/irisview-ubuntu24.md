# 从原工具包复现 Ubuntu 24.04 适配

GitHub 仓库保存 FocusPendant 源码、应用安装包和小型适配脚本，不重新分发商业版 IrisView 运行时。先取得赛事提供的 `IrisView-Developer-Kit-v1.0.0-LLVISION-v2.tar.gz` 并解压。

本次使用的原始归档 SHA256：

```text
2e13599014a7509f550aa33f4a9b6a9ddc87ce65070b397576b88cc47c4f3011
```

在 FocusPendant 仓库根目录执行：

```bash
python3 scripts/patch-irisview-ubuntu24.py /absolute/path/IrisView-Developer-Kit-v1.0.0
cd /absolute/path/IrisView-Developer-Kit-v1.0.0
sha256sum -c SHA256SUMS
```

脚本直接修改原工具包，不修改 `/etc/os-release` 或运行时二进制。它只接受这份工具包的已知原始文件或已完成补丁的文件；遇到其他版本/本地改动会在写入前退出。重复执行不会重复添加内容。

| 文件 | 修改 |
|---|---|
| `sdk/fusionui-app-sdk/developer_kit_host.py` | Ubuntu 支持列表加入 24.04 |
| `sdk/fusionui-app-sdk/developer-kit-tools/install-host-dependencies.sh` | 24.04 使用 t64 依赖包名，补上 xauth、xkbcomp 命令依赖 |
| `PATCH-UBUNTU24.md` | 记录适配范围 |
| 根 `SHA256SUMS` | 更新上述文件对应的校验项，保留其余项 |

安装系统依赖后仍使用原 `bin/irisview` 入口。回到 FocusPendant 目录：

```bash
bash scripts/setup-ubuntu24.sh --check
bash scripts/setup-ubuntu24.sh --install
bash scripts/iris-run.sh /absolute/path/IrisView-Developer-Kit-v1.0.0
```

适配保留 x86_64、共享库、图形显示和音频检查。正常交互需要桌面 X 会话或 WSLg；版本列表通过不代表模拟器窗口、麦克风、扬声器已完成本机验收。构建仍使用 Kit 要求的 Node.js 24.13.0。

本次验证：在全新解压的原包运行补丁，四个输出文件与已交付修订包逐字节一致；完整 SHA256 校验通过；第二次运行没有变化；未知源码被拒绝且未写入。
