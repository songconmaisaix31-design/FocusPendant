# 本地中文语音

语音录音在电脑上转写，复盘在电脑上合成为 WAV。运行时不调用云端服务，不需要 API Key，也不需要 GPU。

| 能力 | 默认模型 | 运行方式 |
|---|---|---|
| 中文 ASR | faster-whisper `small`，多语种模型 | CPU int8，2 线程，中文识别 |
| 中文 TTS | Piper `zh_CN-huayan-medium` | CPU ONNX，2 线程，22,050 Hz 单声道 WAV |

代码依赖固定为 `faster-whisper==1.2.1`、`piper-tts==1.8.0`。Python 3.12 / Ubuntu 24.04 可安装对应 Linux wheels；不依赖 Torch 或 CUDA。

## 第一次准备

在 FocusPendant 项目根目录执行：

```bash
bash scripts/prepare-local-speech.sh
```

该命令创建 `.venv-speech`、安装依赖，并明确下载模型到 `models/speech/`。模型实际文件合计约 525 MiB；下载缓存和 Python 依赖会另占空间。请在比赛前联网完成此步。交付 ZIP 不重新打包模型权重。

如果使用 SOCKS 代理且下载提示缺少 `socksio`：

```bash
.venv-speech/bin/python -m pip install socksio
.venv-speech/bin/python speech/prepare_models.py
```

也可以手工分开执行：

```bash
python3 -m venv .venv-speech
.venv-speech/bin/python -m pip install -r speech/requirements.txt
.venv-speech/bin/python speech/prepare_models.py
.venv-speech/bin/python speech/service.py
```

准备完成后可断网运行。服务只监听 `127.0.0.1:7791`，权重加载强制 `local_files_only`，缺失时明确显示不可用，运行中不会自动补下载。Piper 使用已随依赖安装的 eSpeak 数据；服务不启用需要额外下载的中文拼音或阿拉伯语辅助模型。

## 与主服务联动

`bash scripts/start-local.sh` 会启动主服务和已准备的语音服务。也可在两个终端分别执行 `npm start` 与 `.venv-speech/bin/python speech/service.py`。

- 网页或 IrisView 主动录音结束后，主服务保存原始录音并排队进行本地转写。
- 识别结果显示在同一条打卡中，不新增第二次打卡；原录音仍可播放。
- 录音没有可辨识人声时返回空结果，不生成占位转写。
- 点击网页“本地朗读”生成 WAV；眼镜播放由 IrisView 公共媒体接口消费。
- 原音频失败、模型缺失或任务拥堵时，主服务保留录音，可稍后重试。

ASR 一次最多 60 秒。为兼容浏览器编码尾部，接受不超过 61 秒的解码音频，处理前截到 60 秒；更长文件拒绝。TTS 一次最多 1000 字符。语音服务一次处理一项任务，主服务负责排队，不与模拟器争用全部 CPU 核心。

## 配置

| 环境变量 | 默认 |
|---|---|
| `FOCUS_SPEECH_MODELS` | 项目 `models/speech` |
| `FOCUS_ASR_MODEL` | 上述目录中的 `asr-small`，必须是本地目录 |
| `FOCUS_TTS_MODEL` | 上述目录中的 `zh_CN-huayan-medium.onnx`，需要同名 `.onnx.json` |
| `FOCUS_SPEECH_THREADS` | `2`，允许 1–8 |
| `FOCUS_TOKEN` | 可选，与主服务一致 |
| `FOCUS_SPEECH_URL` | 主服务配置，默认为 `http://127.0.0.1:7791` |

模型目录可复制到另一台电脑后离线使用。若 CPU 资源紧张，可明确下载更小的多语种 `base` 模型并修改路径：

```bash
.venv-speech/bin/python speech/prepare_models.py --asr-size base --asr-only
FOCUS_ASR_MODEL="$PWD/models/speech/asr-base" .venv-speech/bin/python speech/service.py
```

识别质量需用自己的麦克风、口音和噪声环境验证；更小模型通常需要重新检查效果。

## 服务接口

```text
GET  /health
POST /transcribe   Content-Type: audio/wav 或 audio/webm；原始音频，最大 5 MiB
POST /synthesize   Content-Type: application/json；{"text":"今日复盘……"}
```

`/transcribe` 返回 `text`、`language`、`durationSec`、`backend`、`status`、`localOnly:true`。`/synthesize` 成功返回 `audio/wav`。模型未准备返回 503，忙碌返回 429；可选令牌通过 `Authorization: Bearer ...` 发送。浏览器通过主服务转发，不直接连接 7791。

## 本次验证

```bash
.venv-speech/bin/python -m unittest discover -s speech/tests -v
.venv-speech/bin/python speech/smoke.py  # 使用真实本地模型，检查 TTS → ASR
```

6 项测试通过，覆盖缺失模型、空转写、忙碌与异常释放、音频解码/时长上限、HTTP 令牌和输入约束。

另外已下载并加载真实模型，完成两层验证：

1. 直接模型闭环：合成“今天完成了二十五分钟的阅读。接下来，我要休息五分钟。”，得到 4.284 秒 WAV；ASR 输出“今天完成了25分钟的阅读接下来我要休息5分钟”。本次合成约 0.805 秒，转写约 4.057 秒。
2. 真实主服务闭环：`/api/speech` → TTS WAV → 转为 16kHz PCM → `/api/voice` → 自动 ASR → 打卡文字更新。仅新增一次打卡，最终转写与上面一致，整条路径本次约 7.081 秒。

上述时间是开发环境一次观测，不是目标电脑的延迟保证。样本来自本地 TTS，尚未证明真实麦克风录音的准确率；真实眼镜扬声器输出也需现场验证。

## 上游资料与模型信息

- [faster-whisper 官方仓库](https://github.com/SYSTRAN/faster-whisper)：CPU int8、本地目录加载、VAD。
- [Piper Python API](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/API_PYTHON.md)：`PiperVoice` 与 WAV 合成。
- [Huayan medium 配置](https://huggingface.co/rhasspy/piper-voices/blob/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx.json)：`phoneme_type=espeak`、`voice=cmn`、22050 Hz。
- [模型卡](https://huggingface.co/rhasspy/piper-voices/blob/main/zh/zh_CN/huayan/medium/MODEL_CARD)：下载脚本同时保留 `huayan-MODEL_CARD`；其中训练数据集许可标记为 Unknown。Piper 运行库采用 GPL-3.0-or-later，权重未打入本项目交付包。
