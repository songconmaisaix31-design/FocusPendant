# FocusPendant 感知端

这些进程由你手动启动，Ctrl+C 停止。窗口采集与摄像头采集相互独立。摄像头画面用于活动粗分类，结果不能证明人的专注程度。

## 建议运行方式：Windows + WSL

- 在 WSL 运行主服务、IrisView 和 `vision_service.py`。
- 在 Windows PowerShell 运行 `windows.ps1`。
- 在 Windows 浏览器打开主服务的 `http://localhost:7788`，手动开启摄像头。浏览器将采样图发给主服务，主服务按隐私设置调用视觉服务。
- 窗口采集器默认连接 `http://127.0.0.1:7788`。若 Windows 无法访问 WSL 服务，先验证 WSL localhost 转发；不要为了连接而直接把未认证服务暴露到公网。

## Windows 窗口采集

在 Windows PowerShell、项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\collectors\windows.ps1
```

默认每 5 秒上报前台应用名、当次采集进程内稳定的窗口标识和空闲秒数。窗口标识使用会话随机盐，不上报原始窗口句柄。默认不读取窗口标题，也不读取屏幕、文件内容或浏览器地址。

```powershell
# 仅在你需要标题且接受相应采集范围时使用。
.\collectors\windows.ps1 -IncludeTitles

# 可选：服务地址 / 令牌（必须与主服务相同）
$env:FOCUS_SERVER_URL = 'http://127.0.0.1:7788'
$env:FOCUS_TOKEN = 'your-local-token'
.\collectors\windows.ps1 -Once
```

`-Once` 发送一次用于连通性检查；锁屏或没有前台窗口时不制造活动事件。无法采样时重试，停止产生有效事件后主服务自行降级。

## Linux 窗口采集

原生 X11 桌面可使用：

```bash
sudo apt install x11-utils xprintidle
python3 collectors/linux-x11.py
```

Wayland 不受支持。WSL 中运行此脚本也无法采集 Windows 前台窗口，应使用 Windows 采集器。窗口标题仍为默认关闭，可用 `--include-titles` 明确开启。

## 本地视觉模型

Python 3.10+，建议新建虚拟环境。下载依赖与权重需要网络、磁盘空间；本地推理不自动下载文件。

```bash
python3 -m venv .venv-vision
source .venv-vision/bin/activate
python -m pip install -r collectors/requirements-vision.txt
python collectors/download_model.py
python collectors/vision_service.py
```

服务仅监听 `127.0.0.1:7790`，启动时尝试加载缓存中的 CLIP 权重。也可以明确保存到目录后离线使用：

```bash
python collectors/download_model.py --output /absolute/path/to/clip-model
FOCUS_CLIP_MODEL=/absolute/path/to/clip-model python collectors/vision_service.py
```

默认模型为 `openai/clip-vit-base-patch32`；`FOCUS_CLIP_THREADS` 默认 2。没有依赖或权重时，`/health` 返回 `ready:false`，分类返回 `observed:false` 和明确原因。此时不会伪造场景标签，也不会产生成功视觉心跳。

图像只驻留内存；超过 512px 的图像按比例缩小。质量过滤覆盖过暗、过曝、明显模糊/遮挡，以及 5 秒内的近重复帧。20–30 秒后的真实采样会重新推理，可累计连续三帧证据。质量阈值是初始启发式参数，需要用现场光线和机位验证。

分类集合：`reading`、`writing`、`meeting`、`screen_work`、`eating`、`exercise`、`away`、`other`、`unknown`。CLIP 的 `confidence` 是候选文本之间的相对相似度，尚未用现场数据校准，不代表真实准确率；桌面机位通常无法可靠区分会议、锻炼等场景。没有可辨识证据时保留未知。

## 可选云端 VLM

只有在环境变量明确选择云端、服务信息齐备、主界面关闭“仅本地”后才可发送缩略图。原始全分辨率帧不发送到模型提供方，图片不落盘。图像是否被云服务提供方保留取决于其服务约定。

```bash
export FOCUS_VISION_BACKEND=cloud
export FOCUS_VLM_URL='https://your-provider.example/v1/chat/completions'
export FOCUS_VLM_MODEL='your-vision-model'
export FOCUS_VLM_API_KEY='your-key'
python collectors/vision_service.py
```

接口采用 OpenAI 兼容的 `chat/completions` 图像输入格式，需要实际提供方支持。`FOCUS_VLM_URL` 必须是完整接口地址；远程地址要求 HTTPS。不要把密钥写入源码。云端超时或输出结构无效时，只回退到实际可用的本地模型；本地不可用则返回未知。

主服务发送 `X-Focus-Local-Only:true` 时，视觉服务强制只调用本地模型。省略该头同样默认为只在本地。`false` 允许云端，但不会绕过 `FOCUS_VISION_BACKEND=cloud`。

## 摄像头的两种入口

首选主界面的浏览器摄像头入口，不需要 OpenCV。摄像头需要手动授权，使用 `localhost` 或 HTTPS；手机通过普通局域网 HTTP 地址打开网页无法获得浏览器摄像头权限。

备用入口为电脑摄像头或手机虚拟摄像头。安装相应手机软件后，设备须先能在电脑系统中被识别为摄像头，再执行：

```bash
python -m pip install -r collectors/requirements-camera.txt
python collectors/camera.py --device 0 --interval 30
# 第二个 / 手机虚拟摄像头通常可尝试 --device 1
```

CLI 只把 JPEG 帧发送到主服务 `/api/frame`，因此同样服从主服务的采集开关和隐私设置。摄像头断开即停止视觉上报，恢复连接后重新取新帧，不回放缓存帧。Windows 摄像头可在 Windows 运行这个 CLI，主服务与视觉服务仍可在 WSL。

取景应由你实际检查：俯拍桌面并避开人脸、屏幕内容。代码没有宣称自动排除人脸或自动裁掉屏幕；机位错误会把相应内容包含在采样图中。

## 接口

```text
GET  /health
POST /classify    Content-Type: image/jpeg 或 image/png；原始图片字节，最多 2 MiB
```

可选 `FOCUS_TOKEN` 需要 `Authorization: Bearer <token>`。它应与主服务一致。

成功推理结果示例（仅协议示例，非实测）：

```json
{"scene":"reading","confidence":0.82,"objects":[],"backend":"local-clip","observed":true,"scoreKind":"uncalibrated_relative_similarity","quality":{"accepted":true,"reason":"ok"},"localOnly":true}
```

未处理的帧返回 `observed:false`；核心服务应忽略其场景候选，不累计迟滞次数，也不将它当成成功推理心跳。

## 已运行的检查与待现场验证

```bash
python3 -m unittest discover -s collectors/tests -v
python3 -m py_compile collectors/*.py
```

已通过 8 项测试：结构化结果校验、本地隐私开关、云端失败回退、模型缺失时返回未知、暗图/模糊图、重复帧间隔。HTTP 冒烟验证了服务健康状态及缺少模型时的真实未知结果。Linux 采集器通过语法与模拟采样检查。

当前开发环境没有 Windows 桌面、摄像头、Torch 或 Transformers；Windows 原生采集、摄像头实采、真实 CLIP/VLM 分类准确率与延迟仍需现场验证。没有使用假数据代替这些验收。

参考：[MDN getUserMedia 安全上下文](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)、[Hugging Face CLIP](https://huggingface.co/docs/transformers/model_doc/clip)。
