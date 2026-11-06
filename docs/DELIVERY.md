# FocusPendant v0.4.0 交付说明

交付日期：2026-11-07（北京时间）。目标环境：Ubuntu 24.04 x86_64／Windows + WSLg、电脑内置摄像头、本地中文语音模型。

v0.4.0 新增远程 Agent 工作台 `/remote.html`，原注意力、摄像头与语音能力继续保留。远程部署按 [REMOTE.md](REMOTE.md) 执行；本页保留原功能的安装和实机验收说明。

## 交付范围

| 路径 | 用途 |
|---|---|
| `core/` | 全天记录、25/5 计时、来源融合、修正、复盘、导出及本地服务接口 |
| `core/remote/` | 本机任务桥接、SQLite 事件与命令回执、SWA／托管 CLI／OpenCode 适配、只读镜像 |
| `web/` | 电脑控制台、时间线、摄像头取景与裁剪、录音、转写和朗读 |
| `web/remote.*`、`scripts/remote.mjs` | 手机工作台、设备配对与撤销、本机配置和显式启动命令 |
| `iris-app/src/` | IrisView 三行 HUD、导航、录音、独立 Lite 和本地 TTS 播放 |
| `iris-app/FocusPendant-1.0.0.fuiapp` | 已构建的 IrisView 应用；应用清单版本与项目版本分别管理 |
| `collectors/` | Windows／Linux X11 窗口采集、本地 CLIP 视觉服务和可选云端视觉接口 |
| `speech/` | Whisper small CPU int8 转写、Piper 中文朗读、模型准备与验证脚本 |
| `scripts/` | Ubuntu 依赖检查、模型准备、启动和 IrisView 构建入口 |
| `docs/verification.md`、`docs/acceptance.md` | 已完成的验证证据与目标电脑验收步骤 |

仓库不包含商业 IrisView Kit 完整包、模型权重、Python 虚拟环境、个人录音及运行数据。Kit 需自行取得赛事提供的版本并解压，再执行以下命令。补丁更新支持列表和依赖脚本，保留图形与共享库检查；版本校验与回退见 [Kit 适配说明](irisview-ubuntu24.md)。

```bash
python3 scripts/patch-irisview-ubuntu24.py /absolute/path/IrisView-Developer-Kit-v1.0.0
```

## 按顺序启动

从仓库开始：

```bash
git clone https://github.com/songconmaisaix31-design/FocusPendant.git
cd FocusPendant
```

以下命令均在项目根目录执行。准备 Node.js 24、Python 3.12，并启用桌面会话或 WSLg；主服务没有 npm 依赖，无需先执行 `npm install`。

**1. 检查系统依赖。** `--install` 会安装缺失的系统包，普通用户可能需要输入 sudo 密码。

```bash
bash scripts/setup-ubuntu24.sh --check
bash scripts/setup-ubuntu24.sh --install
```

**2. 准备本地语音模型。** 首次需要联网下载约 525 MiB 权重，Python 依赖和下载缓存另占空间；完成后可离线运行，无需 API Key。

```bash
bash scripts/prepare-local-speech.sh
```

**3. 如需 Vision，准备视觉依赖和权重。** 这是独立下载，不包含在语音模型体积内。

```bash
python3 -m venv .venv-vision
.venv-vision/bin/python -m pip install -r collectors/requirements-vision.txt
.venv-vision/bin/python collectors/download_model.py
```

**4. 启动主服务和已准备的本地模型服务。** 打开 `http://localhost:7788`；该终端按 Ctrl+C 会停止本次启动的服务。只运行 `npm start` 则仅启动主服务。

```bash
bash scripts/start-local.sh
```

若已执行 `npm run remote -- init`，本地启动脚本从远程配置加载电脑令牌，原网页需输入该令牌；单独启动采集器时也需设置相同 `FOCUS_TOKEN`。手机远程工作台使用配对码和设备令牌，具体见 [远程部署](REMOTE.md)。

**5. 另开终端启动 IrisView。** 将路径替换为已完成 24.04 补丁的 Kit 目录；模拟器终端按 Ctrl+C 停止。

```bash
bash scripts/iris-run.sh /absolute/path/IrisView-Developer-Kit-v1.0.0
```

网页选择 Vision，再手动开启内置摄像头，检查预览并选择完整／下半部／中央区域。纸笔必须进入镜头视野；裁剪不能补出视野外物体。每 20 秒采样，三次有效一致结果后才确认场景，通常至少需要 40–60 秒。

Flow 在 Windows PowerShell 中运行 `powershell -ExecutionPolicy Bypass -File .\collectors\windows.ps1`；原生 Linux X11 使用 `python3 collectors/linux-x11.py`。采集端需单独 Ctrl+C 停止。WSL 内无法直接采集 Windows 前台窗口，Wayland 未适配。

## 使用与数据

- 录音最长 60 秒，保存后自动本地转写；模型失败时保留原音频，可在同一打卡上重试。
- 复盘朗读可选择电脑或眼镜。眼镜文本 `/read` 请求朗读，`/stop` 停止；浏览器朗读不会同步触发眼镜播放。
- `data/state.json` 保存历史，`data/voice/` 保存录音，`data/speech/` 保存生成音频。备份前停止服务并复制整个 `data/`；这些文件不提交 Git。
- 摄像头关闭后停止采样；服务重启后默认关闭摄像头，进行中的计时恢复为暂停。来源过期后自动降低有效模式。
- 手动纠正保留原始证据。窗口、视觉、自报和计时各保留来源；未观测时间不推断为分心。
- 远程配置、设备授权、事件与交接卡也保存在 `data/`，不提交 Git；初始化默认配对仅有 `read`。远程控制的本机 CLI 仍使用各自模型和账户，不能据此宣称所有 Agent 推理都在本地。

## 验收状态

v0.4.0 本次 Node 全套 103 项通过，其中原功能 25 项、新增远程与 HUD 78 项；视觉与本地语音组件 14 项通过。新增远程功能的执行命令与现场边界见 [REMOTE.md 验证章节](REMOTE.md#7-验证与目标设备验收)。

| 项目 | 已验证 | 仍需目标电脑验证 |
|---|---|---|
| 核心与接口 | 25 项测试通过；计时、跨日、落盘、降级、语音队列与重试 | 一整天实际使用的记录覆盖 |
| 视觉 | 8 项组件测试；浏览器模拟摄像头采样及实际裁剪通过 | 内置摄像头机位、真实 CLIP 分类、噪声与光照影响 |
| 本地语音 | 6 项测试；真实 Piper→主服务→Whisper→唯一打卡闭环通过 | 真实麦克风、口音与现场噪声下的识别效果 |
| IrisView | 构建、打包、校验、公开 API 模拟与独立 Lite 测试通过 | 真实模拟器画面、导航、麦克风和扬声器 |
| 网页 | 真实核心服务联调通过；390px 无横向溢出、零页面错误 | Windows 浏览器与 WSL localhost 转发 |
| 远程工作台 | 78 项新增测试；真实 HTTP、SQLite、Git 工作区及子进程；Chromium 与实际服务联调及 CLI 配对撤销通过 | 真 SWA/Pi、OpenCode、各 CLI、手机私有网络与眼镜远程模式 |

真实语音闭环使用合成中文样本，本次约 7.081 秒；不能据此承诺现场延迟或麦克风准确率。IrisView 的 preflight 与 dry-run 通过不等于真实窗口已渲染。详细证据见 [verification.md](verification.md)，逐项实机流程见 [acceptance.md](acceptance.md)。

## 常见问题

| 现象 | 处理 |
|---|---|
| Kit 仍拒绝 24.04 | 确认运行的是已打补丁的目录，检查 Kit 的 `PATCH-UBUNTU24.md`；不要混用另一份原包 |
| 提示缺少 DISPLAY／图形库 | 启动桌面或 WSLg，再执行系统依赖检查；只修改系统版本列表不能生成图形环境 |
| apt 找不到包 | 先 `sudo apt update`，再运行依赖安装；脚本会拒绝移除或降级已有包的安装计划 |
| 语音模型未就绪 | 检查网页状态；执行准备脚本，再重启服务；模型路径配置见 [speech/README.md](../speech/README.md) |
| 摄像头权限失败 | 从本机 `localhost` 或 HTTPS 打开，允许浏览器摄像头权限；普通手机局域网 HTTP 不支持采集 |
| Vision 不更新 | 检查 7790 视觉服务、画面质量及连续采样数；低分／无效帧不会被当成成功识别 |
| 启动后退出／端口占用 | 关闭此前启动的重复进程；主服务、视觉、语音默认使用 7788／7790／7791 |
| 已设置令牌却连接失败 | 主服务、模型服务、HUD、采集器保持相同 `FOCUS_TOKEN`，网页输入对应令牌 |

## 后续待办

优先完成上述真实设备验收与视觉样本测试，再决定是否扩展场景分类。注意力采集中的浏览器标签、IDE 文件、git 项目感知、手机摄像头 HTTPS 推流尚未接入；远程 Agent 交接的 Git 检查点不属于注意力采集。实际认知注意力测量及准确率保证不在本次交付范围内。Tailscale Serve 提供的是用户自行部署步骤，本次不声明已部署或已连通手机。
