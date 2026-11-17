<div align="center">

# FocusPendant

A local attention journal for one computer: window activity, camera samples and hand-typed check-ins become one day timeline, shown as three lines in the IrisView HUD. When a source is missing it says "not observed" instead of guessing.

一台电脑上的本地注意力日记：窗口活动、摄像头采样和手打打卡合成一条当天时间线，在 IrisView 三行 HUD 上显示；来源缺失时写「未观测」，不猜。

[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](package.json)
[![CI](https://github.com/songconmaisaix31-design/FocusPendant/actions/workflows/ci.yml/badge.svg)](https://github.com/songconmaisaix31-design/FocusPendant/actions/workflows/ci.yml)
[![Source version](https://img.shields.io/badge/source-v0.4.0-blue.svg)](package.json)
[![IrisView app](https://img.shields.io/badge/IrisView%20app-v1.0.0-blueviolet.svg)](iris-app/FusionUIApp.json)

</div>

> **How to read this page · 怎么读这页**
> English first, then the same content in Chinese — not a summary, not a separate "Chinese version". Tables carry both languages in one cell.
> 每段英文在前，同一内容的中文紧跟在后；不是摘要，也没有单独的「中文版」。表格把两种语言放进同一格。

---

## At a glance · 一眼看懂

| | |
|---|---|
| **Problem<br/>问题** | A day of work leaves three unrelated traces — a timer, a list of app names, a camera guess — and none of them answers "what actually happened in those 25 minutes".<br/>一天工作留下三份互不相干的记录：一个计时器、一串应用名、一个摄像头猜测，没有一个能回答「那 25 分钟到底发生了什么」。 |
| **Fix<br/>做法** | One local Node service keeps a per-minute day timeline. Each segment carries its source; vision, window and self-report stay separate; a report is generated from what was observed.<br/>一个本地 Node 服务维护按分钟切段的当天时间线，每段带来源；视觉、窗口、自报分开保存；复盘只根据观测到的内容生成。 |
| **Cost<br/>代价** | Node.js 24, no npm dependencies (`npm start`, not `npm install`). Python 3.12 plus pip packages only if you want local vision or local speech.<br/>Node.js 24，没有 npm 依赖（`npm start`，不需要 `npm install`）。只有要用本地视觉或本地语音时才装 Python 3.12 和 pip 包。 |
| **Not<br/>不是** | Not an attention score, not a screen recorder, not a cloud product. Frames are sampled and discarded; no accuracy or latency is promised.<br/>不是注意力分数，不是录屏工具，不是云服务。采样帧不存档；不承诺准确率或延迟。 |

## The problem · 问题在哪

Each collector answers a narrower question than the one you are asking.

每个采集器回答的问题，都比你真正问的那个窄。

| Source · 来源 | Sees · 看得到 | Cannot see · 看不到 |
|---|---|---|
| **Timer · 计时** | Start, pause, finish; 25/5 focus and break.<br/>开始、暂停、结束；25/5 专注与休息。 | What you did during it.<br/>这段时间里你做了什么。 |
| **Flow · 窗口** | App name, anonymous window id, idle seconds, every 5 s.<br/>应用名、匿名窗口标识、空闲秒数，每 5 秒一次。 | Window titles, page URLs, screen content.<br/>窗口标题、网页地址、屏幕内容。 |
| **Vision · 视觉** | One coarse scene class from a cropped frame, every 20 s.<br/>裁剪画面给出的一个粗场景类别，每 20 秒一帧。 | Anything outside the crop; whether you are paying attention.<br/>裁剪区域之外的东西；你是否在专注。 |
| **Self-report · 自报** | The label you type yourself.<br/>你自己写下的标签。 | How often you bother to type it.<br/>你到底多久才写一次。 |

The tempting fix is to average them into a score. That score cannot be reproduced, and it hides which source produced it.

最省事的做法是把三者平均成一个分数。那个分数无法复现，也看不出是哪一路来源得出的。

## The idea · 思路

Three rules: keep the source, keep the gap, keep the correction cheap.

三条规则：保留来源、保留空档、让修正足够便宜。

| Noun · 名词 | Where · 位置 | Rule · 规则 |
|---|---|---|
| **Source · 来源** | `core/engine.mjs` | Every timeline segment stores `window`, `vision`, `manual`, `timer` or `unknown`. No segment without a source.<br/>每个时间线片段都记 `window`、`vision`、`manual`、`timer` 或 `unknown`，没有无来源的片段。 |
| **Unknown · 未观测** | timeline | Missing data stays missing. Observations are not interpolated across gaps.<br/>缺数据就保持缺，不用插值把空档填满。 |
| **Effective mode · 实际模式** | `modeRequested` / `modeEffective` | Vision going quiet for 90 s drops the mode to Flow, then Lite; it returns when the source is back.<br/>视觉 90 秒没有更新就降为 Flow，再无则 Lite；来源恢复后自动回到所选模式。 |
| **Correction · 修正** | `POST /api/action` `correct` | A rewrite keeps `original.label` and `original.source` next to the new label.<br/>改写时把原标签与原来源留在 `original` 里，和新标签并列。 |
| **HUD · 眼镜** | `iris-app/` | Exactly three lines, each truncated to 22 characters in `core/engine.mjs`.<br/>固定三行，每行在 `core/engine.mjs` 里截到 22 个字符。 |

A one-minute test of whether this is real: start a timer, leave Vision on, stop the collector for 90 seconds. The mode must fall to Lite, the timer must keep running, and the timeline must contain a gap rather than a guess.

一分钟内可以自己验证这套思路是否成立：开始计时、打开 Vision、把采集器停 90 秒。模式应该掉到 Lite，计时应继续走，时间线里应该出现空档而不是猜测。

## Capabilities · 能力清单

| Area · 能力 | What it does · 做什么 | How to check · 怎么验证 |
|---|---|---|
| **Journal · 全天记录** | Per-minute segments, per-day files under `data/`, 7-day stats.<br/>按分钟切段，按天存到 `data/`，七天统计。 | `GET /api/state` |
| **Timer · 计时** | `start` `pause` `resume` `finish` `distraction` `checkin` `mode` `settings`.<br/>专注、暂停、继续、结束、分心、打卡、切模式、改设置。 | `POST /api/action` |
| **Correction · 修正** | `correct` rewrites one segment label and marks it `corrected`.<br/>`correct` 改写一个片段的标签并标记为已修正。 | `POST /api/action` |
| **Report · 复盘** | Three local sentences plus a suggestion; optional cloud text report, off by default.<br/>本地三句复盘加一条建议；云端文字复盘为可选，默认关闭。 | `GET /api/report`, `POST /api/ai-report` |
| **Export · 导出** | `focuspendant-YYYY-MM-DD.json`, or the same day as a Markdown table.<br/>导出当天 JSON，或同样内容的 Markdown 表格。 | `GET /api/export`, `GET /api/report` |
| **Flow · 窗口** | Windows PowerShell and native Linux X11 collectors; Wayland not adapted.<br/>Windows PowerShell 与原生 Linux X11 采集器；Wayland 未适配。 | `collectors/windows.ps1`, `collectors/linux-x11.py` |
| **Vision · 视觉** | Local CLIP-style coarse scene; a scene changes only after three consistent samples scoring ≥0.7.<br/>本地粗分类；三次一致且分数 ≥0.7 才替换场景。 | `collectors/vision_service.py`, `POST /api/frame` |
| **Voice · 语音** | Local ASR on saved audio, local TTS for the review, no API key, no GPU.<br/>保存的音频本地转写，复盘本地朗读；无需 API Key，无需 GPU。 | `speech/service.py`, `POST /api/voice`, `POST /api/speech` |
| **HUD · 眼镜** | Three-line view, navigation keys, recording up to 60 s, standalone Lite mode.<br/>三行显示、导航键、最长 60 秒录音、无服务时独立 Lite。 | `iris-app/`, `scripts/iris-smoke.cjs` |
| **Remote · 远程** | Pair a phone, read the original question, continue the same session or hand off.<br/>配对手机、读取原问题、在同一会话继续或交接。 | `web/remote.html`, `docs/REMOTE.md` |

## Quickstart · 快速开始

### Requirements · 环境要求

Node.js 24 or newer. Ubuntu 24.04 is what has been exercised; Windows works through WSLg. No npm packages, no build step.

需要 Node.js 24 或更高版本。实际跑过的环境是 Ubuntu 24.04；Windows 经 WSLg 使用。没有 npm 包，也没有构建步骤。

### 1. Start the service · 启动服务

```bash
node --version        # must be >= 24 · 需要 >= 24
npm start             # runs core/server.mjs, no npm install needed · 直接跑，不用先安装
```

Open **http://localhost:7788**. On Windows you can also double-click `start.cmd`.

打开 **http://localhost:7788**。Windows 上也可以双击 `start.cmd`。

### 2. See the full interface · 看完整界面

```bash
npm run demo          # demo service on port 7789, own temp data dir · 独立演示服务，端口 7789，临时数据目录
```

The demo is labelled as demo inside the page. It shows the layout; it does not prove real vision classification.

演示页在界面内明确标注演示数据。它能说明界面长什么样，不能证明真实视觉分类成功。

### 3. Verify · 验证

```bash
npm test                      # node --test on 12 files under test/ · 跑 test/ 下 12 个文件
node scripts/iris-smoke.cjs   # HUD public API simulation · HUD 公开接口模拟
node scripts/iris-lite-test.cjs
python3 -m unittest discover -s collectors/tests -v
python3 -m unittest discover -s speech/tests -v
```

The first three need only Node. The two Python suites need the pip packages listed in `collectors/requirements-vision.txt` and `speech/requirements.txt`.

前三条只需要 Node。两个 Python 套件需要 `collectors/requirements-vision.txt` 与 `speech/requirements.txt` 里的 pip 包。

## The remote workbench · 远程工作台

v0.4.0 adds `/remote.html`: a phone pairs with the task computer, reads the tasks already registered there, answers the original question, and continues or hands off the session. Process exit or an agent saying "done" does not mark a result as accepted — phase, connection freshness and acceptance are three separate fields.

v0.4.0 增加 `/remote.html`：手机与任务电脑配对，读取已登记的任务，回答原问题，并在同一会话继续或交接。进程退出或 Agent 自称完成，都不会把成果标记为验收通过——任务阶段、连接新鲜度、成果验收是三个不同字段。

| Endpoint · 端点 | Does · 做什么 | Credential · 凭据 |
|---|---|---|
| `POST /api/remote/pair` | Exchange a one-time pairing code for a device token.<br/>用一次性配对码换设备令牌。 | pairing code<br/>配对码 |
| `GET /api/remote/snapshot` | Task phases, freshness, pending questions.<br/>任务阶段、新鲜度、待答问题。 | device token<br/>设备令牌 |
| `GET /api/remote/events?after=` | Event log by cursor; gaps are kept, not filled.<br/>按游标取事件；缺口保留，不补造。 | device token<br/>设备令牌 |
| `POST /api/remote/commands` | Submit an answer, a continue, or a handoff.<br/>提交答复、继续或交接。 | device token + scope<br/>设备令牌与权限范围 |
| `GET /api/remote/commands/:id` | Read one command receipt.<br/>读取单条命令回执。 | device token<br/>设备令牌 |
| `POST /api/remote/commands/:id/reconcile` | Reconcile an outcome the client never confirmed.<br/>对账客户端没确认到的结果。 | device token<br/>设备令牌 |
| `POST /api/remote/admin/pairings` | Issue a pairing code.<br/>生成配对码。 | owner token<br/>电脑主凭据 |
| `GET /api/remote/admin/devices` | List paired devices.<br/>列出已配对设备。 | owner token<br/>电脑主凭据 |
| `POST /api/remote/admin/revoke` | Revoke one device.<br/>撤销一台设备。 | owner token<br/>电脑主凭据 |
| `POST /api/remote/admin/start` | Explicitly start a managed CLI task.<br/>显式启动一个托管 CLI 任务。 | owner token<br/>电脑主凭据 |

Three adapters are implemented: an existing SWA run, a managed CLI process started by FocusPendant, and an OpenCode HTTP session. The full order — init, add a target, pair, private HTTPS via Tailscale Serve, offline mirror, handoff — is in [docs/REMOTE.md](docs/REMOTE.md).

已实现三个适配器：已存在的 SWA Run、由 FocusPendant 显式启动的托管 CLI、OpenCode HTTP 会话。完整顺序——初始化、登记目标、配对、Tailscale Serve 私有 HTTPS、离线镜像、交接——见 [docs/REMOTE.md](docs/REMOTE.md)。

## Configuration · 配置

| Variable · 变量 | Default / purpose · 默认与用途 |
|---|---|
| `FOCUS_PORT` | `7788`<br/>默认 7788。 |
| `FOCUS_HOST` | `127.0.0.1`. Listening elsewhere requires a token of at least 16 characters.<br/>默认 127.0.0.1；对外监听要求至少 16 位令牌。 |
| `FOCUS_TOKEN` | Optional. One shared token for service, HUD, collectors and vision.<br/>可选；主服务、HUD、采集器、视觉服务共用一个令牌。 |
| `FOCUS_DATA_DIR` | Project `data/`. Deleting it deletes your history.<br/>默认项目 `data/`；删掉它就删掉了历史。 |
| `FOCUS_TIMEZONE` | `Asia/Shanghai`<br/>默认 Asia/Shanghai。 |
| `FOCUS_SERVER_URL` | Where the HUD and collectors connect.<br/>HUD 与采集器连接主服务的地址。 |
| `FOCUS_VISION_URL` | `http://127.0.0.1:7790`<br/>默认 127.0.0.1:7790。 |
| `FOCUS_SPEECH_URL` | `http://127.0.0.1:7791`; loopback only, otherwise the service refuses to start.<br/>默认 127.0.0.1:7791；只允许本机地址，否则服务拒绝启动。 |
| `FOCUS_SPEECH_MODELS` | `models/speech/`; weights are downloaded separately, never at runtime.<br/>默认 `models/speech/`；权重单独下载，运行时不自动下载。 |
| `FOCUS_SPEECH_THREADS` | `2` CPU threads.<br/>默认 2 个 CPU 线程。 |
| `FOCUS_REMOTE_TASKS` | `1` enables the IrisView remote-task mode.<br/>设为 1 打开 IrisView 远程任务模式。 |
| `FOCUS_DEVICE_TOKEN` | Pairing device token used by a remote IrisView or mirror.<br/>远程 IrisView 或镜像使用的配对设备令牌。 |
| `FOCUS_AI_BASE_URL` `FOCUS_AI_MODEL` `FOCUS_AI_KEY` | Optional cloud text report; must speak OpenAI-compatible `chat/completions`. Statistics and notes are sent, images and audio are not.<br/>可选云端文字复盘；需支持 OpenAI 兼容 `chat/completions`。只发送统计与打卡文字，不发送图像与录音。 |

Secrets are never written into the source tree, and the project does not deploy a public service, enable capture at boot, or turn on the camera and microphone for you.

密钥不写进源码。本项目不部署公网服务、不设置开机自动采集、也不替你打开摄像头和麦克风。

## Documentation · 文档

| Doc · 文档 | Read it when · 什么场景读它 |
|---|---|
| [docs/DELIVERY.md](docs/DELIVERY.md) | You want the delivery scope, the exact start order, and troubleshooting.<br/>要看交付范围、按顺序启动的完整步骤和排障。 |
| [docs/REMOTE.md](docs/REMOTE.md) | You are deploying the remote workbench: targets, pairing, private HTTPS, mirror, handoff.<br/>要部署远程工作台：登记目标、配对、私有 HTTPS、镜像、交接。 |
| [docs/acceptance.md](docs/acceptance.md) | You are standing at the target machine and want the pass condition for each step.<br/>人在目标电脑前，要每一步的通过条件。 |
| [docs/verification.md](docs/verification.md) | You want to know what was actually run, on which versions, and what is still unverified.<br/>想知道到底跑过什么、在什么版本上跑、还有什么没验证。 |
| [docs/irisview-ubuntu24.md](docs/irisview-ubuntu24.md) | You start from the original competition kit and need the Ubuntu 24.04 patch steps.<br/>从赛事原包开始，需要 Ubuntu 24.04 的补丁步骤。 |
| [collectors/README.md](collectors/README.md) | You are wiring the window or camera collectors.<br/>要接窗口或摄像头采集器。 |
| [speech/README.md](speech/README.md) | You are preparing the local ASR/TTS models and paths.<br/>要准备本地转写与朗读的模型和路径。 |
| [iris-app/README.md](iris-app/README.md) | You are building or installing the `.fuiapp` on the glasses.<br/>要构建或安装眼镜上的 `.fuiapp`。 |

## Repository layout · 仓库结构

```text
FocusPendant/
├── core/
│   ├── engine.mjs           # timeline, timer, reports, HUD lines · 时间线、计时、复盘、HUD 文本
│   ├── server.mjs           # HTTP service, 21 exact /api routes · HTTP 服务，21 条精确 /api 路由
│   └── remote/              # controller, store, sync, SWA / CLI / OpenCode adapters · 控制器、存储、同步、三个适配器
├── web/                     # index.html + remote.html, no build step · 两个页面，无构建步骤
├── collectors/              # window collectors + vision service · 窗口采集器与视觉服务
├── speech/                  # local ASR and TTS service · 本地转写与朗读服务
├── iris-app/                # .fuiapp package and its source · 眼镜应用包与源码
├── scripts/                 # start, demo, smoke, build, remote CLI · 启动、演示、冒烟、构建、远程 CLI
├── test/                    # 12 node:test files · 12 个 node:test 测试文件
├── docs/                    # delivery, remote, acceptance, verification · 交付、远程、验收、验证
└── SHA256SUMS               # 76 checksums for delivered files · 已交付文件的 76 条校验和
```

## Status · 状态

This is a single-commit snapshot: `08c13a4`, source version 0.4.0, delivered 2026-11-07. There is no development history in this repository, only the delivered tree.

这是一份单提交快照：`08c13a4`，源码版本 0.4.0，交付日期 2026-11-07。仓库里没有开发历史，只有交付时的文件树。

What has actually been exercised, as recorded in [docs/verification.md](docs/verification.md): `npm test` reported 103 passing and 0 failed or skipped; local faster-whisper `small` int8 and Piper `zh_CN-huayan-medium` were downloaded, loaded and run on CPU with 2 threads, including one synthesized sample transcribed end-to-end in about 7.081 s. CI (`.github/workflows/ci.yml`, Ubuntu 24.04 / Node 24 / Python 3.12) runs the Node tests, both IrisView scripts and both Python suites.

实际跑过的内容记录在 [docs/verification.md](docs/verification.md)：`npm test` 记录为 103 通过、0 失败与跳过；本地 faster-whisper `small` int8 与 Piper `zh_CN-huayan-medium` 已下载、加载并在 2 线程 CPU 上运行，其中一段合成样本走完整链路约 7.081 秒。CI（`.github/workflows/ci.yml`，Ubuntu 24.04 / Node 24 / Python 3.12）会跑 Node 测试、两个 IrisView 脚本和两个 Python 套件。

Known limits, stated rather than hidden:

- No real HUD rendering on the glasses: the container attempt could not start a display.
- No real Windows desktop window capture; the collector is implemented but not verified on a real desktop.
- No real camera scene accuracy, unknown rate or latency figures. Model scores are not on-site calibrated.
- No public-link or two-device run. Tailscale Serve was not deployed; SWA/Pi, OpenCode and the four CLIs were not exercised against real logins and models.
- Wayland is not adapted. Phone browsers cannot open the camera over plain LAN HTTP.
- `SHA256SUMS` holds 76 entries for 77 tracked files, and its `README.md` entry does not match the committed README, so `sha256sum -c SHA256SUMS` reports that one line as a mismatch.

边界写出来而不是藏起来：

- 眼镜上没有真实 HUD 渲染：容器里没能起显示服务。
- 没有真实 Windows 桌面窗口采集；采集器写完了，但没在真机上验证。
- 没有真实摄像头的准确率、未知比例和延迟数字。模型分数没有做过现场校准。
- 没有做过公网链路或两台设备的联调。Tailscale Serve 未部署；SWA/Pi、OpenCode 与四家 CLI 没有对真实登录和模型跑过。
- Wayland 未适配。手机浏览器在普通局域网 HTTP 下打不开摄像头。
- `SHA256SUMS` 有 76 条，跟踪文件 77 个，其中 `README.md` 一条与当前提交的 README 不一致，所以 `sha256sum -c SHA256SUMS` 会在这一行报不匹配。

## License · 许可

No license file is present in this repository. No license means no reuse rights are granted by default; add a `LICENSE` before anyone else builds on this code.

仓库里没有许可文件。没有许可默认就没有复用授权；别人要基于这份代码做事之前应当先补上 `LICENSE`。
