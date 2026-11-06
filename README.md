# FocusPendant · IrisView

v0.4.0 新增 **远程 Agent 工作台**：在 `/remote.html` 配对手机，查看已登记的 SWA、托管 CLI 和 OpenCode 任务，按授权回答问题、继续或交接。完整部署、来源版本与操作边界见 [远程工作台说明](docs/REMOTE.md)。

把电脑活动、桌面视觉和主动打卡整理成全天时间线，在 IrisView 三行 HUD 中显示当下状态，晚上回看记录并纠正标签。

交付范围、完整启动顺序、验收状态与排障见 [交付说明](docs/DELIVERY.md)。

当前按 **Ubuntu 24.04、电脑内置摄像头、本地语音模型** 实现，保留全天整理为主、计时为辅的主线。配套工具包已直接加入 Ubuntu 24.04 支持列表并更新依赖脚本；已有修订包可直接使用，从赛事原包开始请按 [Kit 适配说明](docs/irisview-ubuntu24.md) 应用补丁。

## 先运行（Ubuntu 24.04）

主服务需要 Node.js 24，无 npm 依赖。克隆仓库或解压源码后，在项目根目录运行：

```bash
npm start
```

打开 **http://localhost:7788**。Windows 也可以双击 `start.cmd`；Linux 可执行 `bash scripts/start.sh`。

此时可用：25/5 计时、暂停和结束、分心标记、文字打卡、自报活动、全天时间线、逐段修正、三句本地复盘、最近七天统计、JSON / Markdown 导出。首次运行不含示例数据。计时不自动开摄像头，也不自动采集前台窗口。

想先看完整界面：另开终端执行 `npm run demo`，打开 **http://localhost:7789**。演示使用独立临时数据目录，界面明确标注演示数据。它不能证明真实视觉分类成功。

## 接入 IrisView

已提供 `iris-app/FocusPendant-1.0.0.fuiapp`。项目版本 0.4.0 与 IrisView 应用清单版本分别管理。远程任务模式的构建和环境配置见 [远程工作台说明](docs/REMOTE.md)。

```bash
bash scripts/iris-run.sh /absolute/path/IrisView-Developer-Kit-v1.0.0
```

本次直接修改 Kit 的支持列表，新增 **Ubuntu 24.04 x86_64**，同步调整依赖安装脚本和 SHA256 清单。系统保持真实的 24.04，图形桌面 / WSLg、共享库和音频检查继续执行。修改范围记录在修订 Kit 的 `PATCH-UBUNTU24.md`。

先检查/安装这台电脑所需的系统依赖：

```bash
bash scripts/setup-ubuntu24.sh --check
bash scripts/setup-ubuntu24.sh --install
```

| 眼镜导航 | 操作 |
|---|---|
| 确认 | 开始 / 暂停 / 继续 |
| 上 | 待机切换 Lite / Flow / Vision；计时中打卡 |
| 下 | 标记分心 |
| 左 / 返回 | 结束计时 |
| 右 | 授权录音 / 结束录音，最长 60 秒 |

没有伴生服务时，应用可独立运行 Lite，记录存于应用私有目录。已由服务管理的会话断连后等待重连，不重复启动另一份计时。音频按帧持续写入 WAV；保存到服务后在网页“打卡记录”中播放。录音保存后自动交给本机 Whisper 转写；失败时保留原音频并允许重试。输入 `/read` 可请求本地生成并在眼镜朗读复盘，`/stop` 停止。

更多构建、输入和现场操作说明见 [iris-app/README.md](iris-app/README.md)。

## 本地语音：转写与朗读

首次准备依赖与模型需要联网下载；准备后语音采集、转写和朗读均在本机完成，无云端密钥要求。

```bash
bash scripts/prepare-local-speech.sh
bash scripts/start-local.sh
```

`start-local.sh` 启动主服务和已准备好的语音/视觉服务。转写使用 faster-whisper small 多语言模型、CPU int8；朗读使用 Piper 中文 huayan 模型，默认各用 2 个 CPU 线程。完整权重独立下载，不塞入源码包。

网页点击“开始录音”，最长 60 秒；结束后自动保存并本地转写。IrisView 录音走相同转写链路。打卡记录显示处理状态、文字和原始音频，模型未准备时显示原因。点击复盘朗读可以选择电脑或眼镜，避免两端同时播放。

服务固定使用本机地址 `127.0.0.1:7791`，不跟随外部重定向，也不会在运行时自动下载权重。模型路径、下载和独立启动说明见 [speech/README.md](speech/README.md)。

## Flow：电脑活动

先在网页选择 Flow，再在 Windows PowerShell 执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\collectors\windows.ps1
```

默认每 5 秒发送应用名、匿名窗口标识和空闲时长，不发送窗口标题、屏幕图像或浏览器地址。Ctrl+C 停止。WSL 中的 Linux 进程无法直接读取 Windows 前台窗口。

原生 Linux X11 可用 `collectors/linux-x11.py`；Wayland 未适配。采集器、主服务与 IrisView 默认经 `127.0.0.1:7788` 连接。Windows 浏览器通常可通过 WSL localhost 转发访问服务，仍需在目标电脑确认。

## Vision：桌面粗分类

第一步准备一次本地视觉模型：

```bash
python3 -m venv .venv-vision
source .venv-vision/bin/activate
python -m pip install -r collectors/requirements-vision.txt
python collectors/download_model.py
python collectors/vision_service.py
```

第二步在网页选择 Vision，点击“开启摄像头”，选择电脑的内置摄像头。默认使用浏览器摄像头；授权后显示设备名，可切换设备并选择取景裁剪区域。实际送给模型的是裁剪后的图像。

内置摄像头常朝向人，须调整电脑角度或把纸笔放进可见区域；单靠裁剪无法让镜头看到视野外的物体。先查看实时预览，确认目标活动可见。默认每 20 秒采样一帧，最长边 512px，不存档；通过 `localhost` 使用 Windows 浏览器时也可访问 WSL 中的服务，不要求 WSL 直接拥有摄像头设备。

模型正常返回后，**三次连续有效、一致且分数 ≥0.7 的采样**才更新场景；最早约 40–60 秒。分数未做现场校准，不代表准确率。质量不合格或模型不可用时保留未知，不能用样例标签冒充推理。

本地模型必须提前下载；运行期间不会自动下载模型。云端 VLM 是可选配置，且必须在界面明确关闭“仅本地识别”才会发送缩略图。详见 [collectors/README.md](collectors/README.md)。

**手机浏览器直接打开普通局域网 HTTP 地址不能开启摄像头。**首版手机入口为系统虚拟摄像头；手机浏览器 HTTPS 推流未配置。

## 复盘与记录边界

- 全天记录独立于专注计时。没有来源的时间记为“未观测”，电脑休眠时暂停计时。
- 视觉提供场景线索；窗口提供电脑使用线索；自报和计时分别保留来源。不会输出未经验证的“注意力分数”。
- 视觉与窗口均有效时，可提示“桌面似在阅读，电脑前台仍在活动，请确认”；不会据此断言刷手机。
- 视觉结果 90 秒未更新，Vision 降为 Flow 或 Lite；窗口也失效则为 Lite。来源恢复后自动恢复所选模式。
- 手动修正保留原标签及原来源。近七天图表使用已记录日期，不补造历史。
- 资料写入项目 `data/`；录音写入 `data/voice/`。备份时停止服务并复制整个目录。删除该目录会清除个人历史。
- 服务重启后摄像头默认关闭，进行中的专注会话恢复为暂停。

本地三句复盘始终可用。若需要模型生成复盘，给主服务配置以下环境变量，然后在网页主动点击“云端复盘（发送活动摘要）”：

```bash
export FOCUS_AI_BASE_URL='https://your-provider.example/v1'
export FOCUS_AI_MODEL='your-text-model'
export FOCUS_AI_KEY='your-key'
npm start
```

模型需支持 OpenAI 兼容 `chat/completions`。这一步发送所选日期的统计、活动片段和打卡文字，不发送图像或录音。失败时保留本地复盘。云端回复当前仅显示在页面，导出内容仍以本地事实复盘为准。

## 已实现与待实测

| 能力 | 当前状态 |
|---|---|
| 远程 Agent 工作台、配对/撤销、事件同步与操作回执 | v0.4.0 新增；协议、权限与验收边界见 [远程说明](docs/REMOTE.md) |
| 全天记录、计时、纠正、日报/七天图、导出 | 已实现；核心与真实 HTTP 测试通过 |
| IrisView HUD、导航、录音、独立 Lite | 已实现；官方构建/包校验和公开 API 模拟测试通过 |
| Windows 窗口采集 | 已实现；待 Windows 桌面实测 |
| 桌面采样、本地 CLIP、可选云 VLM | 已实现；过滤和回退测试通过；待真实模型与摄像头实测 |
| 视觉/窗口失效降级、恢复、证据融合 | 已实现；状态机测试通过 |
| 云端文字复盘 | 已提供可配置接口；待你的服务配置与实际调用 |
| 语音 ASR、中文 TTS | 已接入本地模型；录音自动转写，支持浏览器与眼镜播放目标 |
| 浏览器标签/IDE 文件/git 项目感知 | 未接入；首版只记录前台应用与窗口切换 |
| 实际注意力识别、准确率/CPU/延迟保证 | 未验证，不作此承诺 |

## 验证

```bash
npm test
node scripts/iris-smoke.cjs
node scripts/iris-lite-test.cjs
python3 -m unittest discover -s speech/tests -v
python3 -m unittest discover -s collectors/tests -v
bash scripts/iris-build.sh /absolute/path/IrisView-Developer-Kit-v1.0.0
```

实机交付前按 [docs/acceptance.md](docs/acceptance.md) 验收。已完成的检查与环境限制见 [docs/verification.md](docs/verification.md)。

## 配置

| 变量 | 默认 / 用途 |
|---|---|
| `FOCUS_PORT` | `7788` |
| `FOCUS_HOST` | `127.0.0.1`；非本地监听要求至少 16 位令牌 |
| `FOCUS_TOKEN` | 可选；主服务、HUD、采集器、视觉服务使用相同令牌 |
| `FOCUS_DATA_DIR` | 项目 `data/` |
| `FOCUS_TIMEZONE` | `Asia/Shanghai` |
| `FOCUS_SERVER_URL` | HUD / 采集器连接主服务的地址 |
| `FOCUS_REMOTE_CONFIG` | 默认 `data/remote-config.json`；远程来源和电脑管理凭据 |
| `FOCUS_REMOTE_TASKS` | `1` 启用 IrisView 远程任务模式 |
| `FOCUS_DEVICE_TOKEN` | 远程 IrisView / 镜像使用的配对设备令牌 |
| `FOCUS_VISION_URL` | `http://127.0.0.1:7790` |
| `FOCUS_SPEECH_URL` | `http://127.0.0.1:7791`，仅允许本机地址 |
| `FOCUS_SPEECH_MODELS` | 项目 `models/speech/`，需预先准备权重 |
| `FOCUS_SPEECH_THREADS` | `2`，CPU 推理线程数 |

不把密钥写入源码。本项目不会部署公网服务、设置自动开机采集或代替用户开启录音/摄像头。

## 本机最后验收

在你的 Ubuntu 24.04 / WSLg 环境确认真实 HUD、内置摄像头取景、麦克风权限和扬声器输出。已完成的软件与模型检查范围见 [docs/verification.md](docs/verification.md)。
