# 远程 Agent 工作台 · v0.4.0

在 Ubuntu 24.04 任务电脑运行 FocusPendant，手机通过私有 HTTPS 页面查看已登记任务、回答原始问题；IrisView 显示三行摘要。原注意力日记、内置摄像头和本地语音仍使用首页，本页介绍新增的 `/remote.html`。

任务阶段、连接新鲜度、成果验收是三个不同字段：进程退出或 Agent 报告完成不会把成果自动标记为验收通过。断网显示最后确认时间并禁用操作，不把旧状态显示成实时进展。

## 1. 初始化任务电脑

前提：Ubuntu 24.04、Node.js 24，所选 Agent CLI 已在本机安装并完成自身登录。主服务无需 `npm install`；托管 CLI 的模型费用、账户和网络由该 CLI 原配置决定。以下命令在 FocusPendant 根目录执行。

```bash
npm run remote -- init
```

初始化生成 `data/remote-config.json`，含随机 `ownerToken`、空 `targets`、空 `handoffProviders`。已有配置会拒绝覆盖。服务及管理 CLI 自动读取它；默认每两秒观察任务。`FOCUS_DATA_DIR` 可更换数据目录，`FOCUS_REMOTE_CONFIG` 可指定配置文件；所有相关进程应使用同一组路径。

`ownerToken` 是电脑管理凭据，仅留在本机。配置和运行数据位于已忽略的 `data/`；`.env`、模型和虚拟环境也不提交。若把配置放到其他目录，应自行保证不进入 Git。SWA/OpenCode 密码用 `tokenEnv` 指向本地环境变量，配置只写变量名。明确设置的 `FOCUS_TOKEN` 优先于 `ownerToken`。

先按下一节登记所需来源，再运行：

```bash
npm start
```

打开 `http://localhost:7788/remote.html`。Ctrl+C 关闭主服务；本服务启动的托管 Agent 会尝试停止，外部 SWA/OpenCode 服务由各自终端管理。登记或修改配置后必须重启 FocusPendant，重启不会自动续跑旧会话。

## 2. 选择真实任务来源

### SWA：登记一个已有 Run

协议固定为 [swarm-anything runtime 分支提交](https://github.com/songconmaisaix31-design/swarm-anything/tree/733ee08fb694fe8d8719693ca6b6e05432e005b2) `733ee08fb694fe8d8719693ca6b6e05432e005b2`，分支名 `codex/heterogeneous-agent-20261027`。核对时 `main` 不含该分支的 `cmd/swa`／`runtime/swa-orca`；不能把另一个版本当作已兼容的 runtime。

先通过现有 SWA 流程启动本地服务、取得项目授权，并创建原 Run。本项目不创建 SWA Run，也不扫描任意终端。使用原运行结果中的 `controller`、`run_id`、根 `task_id`（或已核对 `run.show` 的 `root_task_id`），不能用子任务或问题的 Task 代替。

```bash
read -r -s -p 'SWA 项目令牌：' SWA_PROJECT_TOKEN
export SWA_PROJECT_TOKEN
npm run remote -- add-swa \
  --id swa-main --endpoint http://127.0.0.1:4318 \
  --token-env SWA_PROJECT_TOKEN --project YOUR_PROJECT_ID \
  --controller YOUR_CONTROLLER_ID --run YOUR_RUN_ID --task YOUR_ROOT_TASK_ID
```

端口 `4318` 是示例，必须替换为原服务实际地址；只接受带明确端口的回环 IP HTTP 地址。令牌沿原 SWA 授权取得，不能临时生成替代。启动 FocusPendant 的终端必须继承 `SWA_PROJECT_TOKEN`。

观察来自 `run.show` 的 `swa.run-view.v1`。可操作的问题仅限 Pi 以原生 `swa_ask` 暴露的明确问题；普通终端问句和其他 provider 的工具审批不会被猜成可答问题。回答绑定原 Controller、Run、根 Task、Dispatch 和 Question；`continuation_required` 才显示显式继续。此适配器不开放 interrupt/handoff。

`capture: snapshot_diff` 表示轮询快照变化，不是完整 SWA journal，不能证明两次轮询之间没有遗漏瞬时事件。请求超时后按原 UUID 查询 `request.show`，不会另造请求重发。

### 托管 CLI：由 FocusPendant 显式启动

支持 `codex`、`claude`、`gemini`、`opencode` 的结构化 JSONL 输出，不接管已打开的交互终端。先准备真实项目目录与本地提示文件，例如：

```bash
mkdir -p data/prompts
cat > data/prompts/review.txt <<'EOF'
检查当前项目，列出需要修复的问题和可执行的验证步骤，暂不修改文件。
EOF
npm run remote -- add-managed \
  --id review-main --provider codex --project YOUR_PROJECT_ID \
  --cwd /absolute/path/your-project --prompt-file data/prompts/review.txt \
  --sandbox read-only --title '项目检查'
```

`--model` 可指定该 CLI 已配置的模型。注册只写配置，`autoStart` 为 `false`。重启 FocusPendant 后，另开继承相同环境的终端显式启动：

```bash
npm run remote -- start --id review-main
npm run remote -- status
```

| Provider | 调用形式 | 续跑形式 |
|---|---|---|
| Codex | `codex exec --json … -- PROMPT` | `exec … resume --json SESSION -- PROMPT` |
| Claude | `claude -p --output-format stream-json --verbose … -- PROMPT` | 同一命令增加 `--resume SESSION` |
| Gemini | `gemini --output-format stream-json … --prompt=PROMPT` | 增加 `--resume SESSION` |
| OpenCode CLI | `opencode run --format json … -- PROMPT` | 增加 `--session SESSION` |

表中省略号代表本机配置的模型等参数，不能照抄为参数。CLI 必须实际支持对应形式。`--sandbox read-only`／`workspace-write` 当前仅传给 Codex；其他 provider 的权限由其本机 CLI 策略决定，登记托管任务不等于为它们建立沙箱。

托管模式记录实际 JSONL 生命周期、工具活动、原生会话和退出状态；不转发原始 stderr、自由文本全文或终端键盘输入，也不提供远程工具审批。它可在来源确认且进程释放后继续原会话，或中断本服务启动的进程组。

服务重启后，持久化 session 不能证明外部写入者已停止。需在本机先检查原进程，再把该目标配置的 `recoverable` 设为 `true` 后重启并显式 `start`；新登记已有会话可用 `--session SESSION --writer-stopped true`。该标记是本机确认，不能用它跳过实际检查。未知会话状态、会话 ID 不匹配或未停止的进程组都不会自动恢复。

### OpenCode HTTP：登记一个已有会话

这是独立于上面的托管 CLI 的连接方式。V1 路由和消息格式依据官方 [v1.1.35 源码](https://github.com/anomalyco/opencode/blob/v1.1.35/packages/opencode/src/server/routes/question.ts)核对，V2 依据 2026-11-06 [官方 OpenAPI 契约](https://opencode.ai/docs/openapi.json)核对；不宣称覆盖所有发行版，也不按失败结果自动猜测版本。

先在原项目目录启动对应版本的 OpenCode 服务，并通过原生界面确认 `sessionId`：

```bash
read -r -s -p 'OpenCode 本机服务密码：' OPENCODE_SERVER_PASSWORD
export OPENCODE_SERVER_PASSWORD
opencode serve --hostname 127.0.0.1 --port 4096
```

在 FocusPendant 根目录的另一终端设置相同密码环境变量，然后登记；把 `--api-version v1` 改为已核对的实际版本 `v2` 时，其他身份仍须对应同一原会话：

```bash
npm run remote -- add-opencode \
  --id opencode-main --endpoint http://127.0.0.1:4096 --api-version v1 \
  --cwd /absolute/path/your-project --session YOUR_SESSION_ID \
  --project YOUR_PROJECT_ID --token-env OPENCODE_SERVER_PASSWORD
```

密码以 HTTP Basic 发送，用户名固定 `opencode`；不要为原服务配置其他 `OPENCODE_SERVER_USERNAME`。`tokenEnv` 指向密码本身，不是 Bearer token 或编码后的 Basic 字符串。无密码服务可省略 `--token-env`。endpoint 只接受回环 HTTP(S) 根地址，绝对 cwd 与原生会话目录必须一致。

| 协议 | 可回答的精确形式 | 操作限制 |
|---|---|---|
| V1 question | 一个或多个原始问题；按原顺序提交 `answers: string[][]`；支持单选、多选及原题允许的自定义文本 | 仅 active 会话；`custom:false` 时答案必须为原 option label |
| V1 permission | `reply: once` 或 `reject` | 仅 active 会话，不支持永久允许；abort 后残留请求不复活 |
| V2 form | 仅一个可见 `string` 或 `multiselect` 字段；支持原选项、required、长度或数量约束 | 选项使用原 value；多字段、条件、hidden、format、pattern 等复杂表单只显示 |
| V2 permission | `decision: once` 或 `reject` | 不支持永久允许 |

网页按对应结构提交文本或多选；`answerSupported:false` 的问题保留展示并提示回原终端。每次操作都重新核对原问题指纹。只有原生 idle、无 pending 请求且未归档的会话能带明确新输入继续；中断限当前 active 会话。HTTP 超时后的执行结果为 unknown，原端点不共享桥接请求 ID，因此不自动重发或凭状态猜测成功。OpenCode HTTP 来源也使用 `snapshot_diff`，不提供跨 provider 交接。

OpenCode 的 HTTP 成功不证明模型已读取回答。V1 即使请求已在竞态中消失也可能返回 `200 true`，因此回执仅作 `http_only` 确认；V1/V2 都保留 `read_unconfirmed`，不能据此判断任务或验收完成。

## 3. 配对手机与限定权限

主服务运行后，在任务电脑生成一次性配对码：

```bash
npm run remote -- pair --label '我的手机' --scopes read --projects YOUR_PROJECT_ID
```

默认只有 `read`。需要操作时明确选择，例如 `--scopes read,answer,resume`；另可授予 `interrupt`、`handoff`。设备获得权限仍需对应适配器当前能力允许。`--projects` 用逗号分隔配置中的 `projectId`，不是目标 `id`；省略表示全部项目，包含以后登记的项目。

在手机 `/remote.html` 输入配对码和设备名。配对码五分钟内有效且仅能兑换一次；网页把设备令牌保存在当前浏览器会话，快照缓存保存在该浏览器本地。页面“断开”清理该浏览器访问状态，但不会撤销服务器登记的设备。撤销在任务电脑执行：

```bash
npm run remote -- devices
npm run remote -- revoke --id DEVICE_ID_FROM_DEVICES
```

撤销后令牌失效，重新访问需重新配对。设备令牌只访问授权的远程任务接口，不能访问原注意力记录，也不能创建配对码或启动未启动的托管任务。手机无需持有 `ownerToken`。

### 私有 HTTPS：Tailscale Serve

以下是用户在目标电脑执行的部署步骤，本次交付不表示已经开通网络或完成实机连接。先按 [Tailscale 官方安装与 Serve 说明](https://tailscale.com/docs/features/tailscale-serve) 配置任务电脑与手机在同一 tailnet，允许该设备使用 HTTPS。

```bash
tailscale serve --bg http://127.0.0.1:7788
tailscale serve status
```

使用命令返回的实际 `https://设备名.tailnet.ts.net/remote.html`。保持 FocusPendant 监听 `127.0.0.1`；Serve 代理整个站点，使页面和 `/api/remote/` 处于同一源，并保留原 Host。访问还受 tailnet 规则和 FocusPendant 设备令牌双重约束。不要将后端改成无保护的公网地址；这里没有使用公开 Funnel。

停止该 HTTPS 代理：`tailscale serve --https=443 off`。后台 Serve 不随 FocusPendant 的 Ctrl+C 退出；主服务关闭时代理后端不可用。若已有 Serve 配置，先查看状态，避免占用现有 HTTPS 入口。命令依据 [官方 Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)。

## 4. 只读离线镜像与 IrisView

### 取得专用设备令牌

为镜像或 IrisView 单独生成配对码，再在该设备调用一次兑换接口。下面 JSON 中的值均需替换；返回 `token` 仅用于对应设备，不保存到仓库：

```bash
curl --fail-with-body --silent --show-error \
  --json '{"code":"ONE_TIME_PAIRING_CODE","label":"只读镜像"}' \
  'https://YOUR_HOST.YOUR_TAILNET.ts.net/api/remote/pair'
read -r -s -p '兑换得到的设备 token：' FOCUS_DEVICE_TOKEN
export FOCUS_DEVICE_TOKEN
```

配对码会被消费，不要把手机已用过的码再给镜像。令牌丢失时撤销原设备并重新配对。若终端返回敏感值，避免将该输出附入日志或截图。

### 只读镜像

```bash
npm run remote -- mirror \
  --url https://YOUR_HOST.YOUR_TAILNET.ts.net \
  --token-env FOCUS_DEVICE_TOKEN --dir /absolute/path/private-mirror
```

`--dir` 是镜像 `dataDir`，默认 `data/mirror`；落盘文件为 `remote-mirror.json`。`--once true` 只同步一次，Ctrl+C 停止持续同步。这个客户端只读，不转交命令。跨设备 URL 必须为 HTTPS，本机可用回环 HTTP。

首次配对从当前快照和 watermark 建立基线，不补造更早历史；之后按设备 ID、streamEpoch、seq 游标补传和去重，最多保留 5000 条镜像事件。主机清理历史、事件流变化或游标回退时重新取快照并标明 historyGap；断线只展示最后确认状态。设备令牌不写入镜像文件。

### IrisView 远程模式

先按 [Kit 适配说明](irisview-ubuntu24.md) 准备工具包，并从当前源码构建应用：

```bash
bash scripts/iris-build.sh /absolute/path/IrisView-Developer-Kit-v1.0.0
export FOCUS_REMOTE_TASKS=1
read -r -s -p 'IrisView 专用设备 token：' FOCUS_DEVICE_TOKEN
export FOCUS_DEVICE_TOKEN
export FOCUS_SERVER_URL='https://YOUR_HOST.YOUR_TAILNET.ts.net'
bash scripts/iris-run.sh /absolute/path/IrisView-Developer-Kit-v1.0.0
```

默认配对 `read` 时仅查看。左右切换任务，上下切换问题，显示最后确认时间；缓存仅有任务摘要，断网禁用回答。授予 `answer` 后，可在 Kit 文本输入／控制台提交 `/answer 内容`，仅回答包含准确 Dispatch 的原始文本问题（当前对应 SWA Pi）。审批、多选表单和显式继续请使用手机；远程语音尚未接入。原注意力模式仍有本地 ASR/TTS，但不自动变成远程 Agent 的语音审批。

真实手机网络、眼镜显示与输入仍待目标设备验收；API 模拟不能证明真实硬件连通。退出远程模式可清除 `FOCUS_REMOTE_TASKS` 后重启应用。

## 5. 同会话继续与跨 Agent 交接

“继续”使用原 provider 和原生 session，附带明确下一步输入。“交给另一个 Agent”创建新会话，原会话不会被迁移；已完成证据仍需接手者与用户核对。

跨 Agent 交接默认关闭。只在任务电脑的 `data/remote-config.json` 中显式登记允许的 provider、model 与策略，例如合并以下字段后重启：

```json
{
  "handoffProviders": {
    "codex": {"model": "YOUR_LOCALLY_CONFIGURED_MODEL", "sandbox": "read-only"}
  }
}
```

这是配置片段，保留已有 `version`、`ownerToken` 和 `targets`；模型名替换为本机可用值。可登记 `codex`、`claude`、`gemini`、`opencode`，但非 Codex 的沙箱仍依其原生策略。远端不能指定可执行文件、任意 cwd、模型或新 provider。

交接只适用于已启动且确认释放写入者的 managed 任务，且设备需有 `handoff` 权限。程序读取 Git HEAD、状态、已跟踪文件差异、未跟踪文件清单及哈希，生成本地 `data/handoffs/REQUEST_ID.json`，在目标启动前重新校验工作区指纹。它不会自动提交 Git；未跟踪文件仍在原工作区，检查卡不复制其内容。当前限制最多 200 个未跟踪文件、合计 20 MiB，受 Git 读取上限约束。

目标在同一 cwd 读取本地交接卡，包含目标、已完成事项、决策、成果、待办及原任务/session 来源；卡内差异不随手机事件流上传。恢复定义写入 `data/remote-handoffs.json`。同工作区已有托管写入者时拒绝并行接手；外部进程不在此锁覆盖范围，应先在本机确认停止或使用独立 worktree。

## 6. 数据、回执与原功能共存

| 本地位置 | 内容 |
|---|---|
| `data/remote-config.json` | ownerToken、来源配置、本机交接许可 |
| `data/remote.sqlite` 及运行中的 WAL | 设备令牌哈希、任务快照、事件、稳定 UUID 命令及回执 |
| `data/remote-handoffs.json`、`data/handoffs/` | 接手目标定义与本地交接卡 |
| 镜像目录 `remote-mirror.json` | 该设备权限内的快照、游标及事件 |

备份前停止主服务及镜像，复制完整数据目录。保存回答、Agent 读取、接受继续、进程结束和成果验收各有含义。unknown 表示尚未确认；页面只核对原请求，只有服务器明确尚未记录且原命令未过期时才允许手动重发同一 UUID。重启时在途命令变为 unknown，不自动再执行。

初始化远程配置后，原首页也要求电脑令牌；设备令牌不能替代它。`start-local.sh` 和 `iris-run.sh` 会读取本机配置供原模式使用；单独启动采集器、语音或视觉服务时，在本机当前终端加载同一令牌：

```bash
export FOCUS_TOKEN="$(node -p 'JSON.parse(require("node:fs").readFileSync("data/remote-config.json","utf8")).ownerToken')"
```

若使用自定义配置路径或显式 `FOCUS_TOKEN`，改用对应值。原网页在连接令牌框输入电脑令牌；不要发给只需远程任务权限的手机。未运行 `remote init` 的原本地使用方式保持可用。

## 7. 验证与目标设备验收

```bash
node --test test/remote-*.test.mjs test/iris-remote.test.mjs
npm test
node scripts/iris-smoke.cjs
node scripts/iris-lite-test.cjs
bash scripts/iris-build.sh /absolute/path/IrisView-Developer-Kit-v1.0.0
```

2026-11-07 本次验收：Node 全套 103 项通过（含新增远程/HUD 78 项）；视觉和本地语音组件 14 项通过，语音测试使用含 PyAV 的环境，无跳过。原 HUD 与独立 Lite 回归通过。Chromium 与真实 `createService` 联调验证配对、原问题答复只执行一次、SQLite 消费回执、刷新恢复以及服务断连后的状态保留与禁写；另验证 390px 布局、只读权限、复杂表单禁答和撤销。CLI 实际服务流程验证初始化、登记但不启动、主凭据加载、项目配对与撤销。详情见 [验证记录](verification.md)。各测试可以证明的边界如下：

| 项目 | 自动验证覆盖 | 仍需现场验收 |
|---|---|---|
| 存储、同步、权限 | 本机测试：游标、重复命令、过期状态、设备撤销及项目范围 | 两台真实设备断连后补传、tailnet 规则 |
| SWA / OpenCode | 本机 HTTP 协议服务：原身份、问题约束和回执 | 固定 SWA/Pi 和对应 OpenCode 真服务、真实模型 |
| 托管 Agent / 交接 | 结构化输出与子进程、工作区检查点测试 | 已安装 CLI、真实登录、模型额度及外部写入者检查 |
| 网页 / IrisView | 网页交互与公开 API 模拟按单独记录验收 | 真手机配对、眼镜显示导航及 `/answer` |

现场至少执行：只读配对 → 读到指定项目 → 增加授权设备 → 回答准确原问题 → 核对保存/读取状态 → 断网后操作禁用 → 恢复后游标补传 → 撤销后访问失败。继续和交接必须分别验证原 session 与新 session，不能只凭“操作完成”推断任务完成。

常见故障：401 检查设备是否撤销及环境令牌；403 检查设备 scopes、项目范围和反代同源 Host；409 刷新原任务并核对会话／问题是否变化；unknown 回原来源检查原请求，避免重复执行。来源连接失败时先确认本机 SWA/OpenCode 端口、密码和版本，不通过放宽 endpoint 或关闭校验解决。
