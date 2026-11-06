#!/usr/bin/env python3
"""Local Chinese ASR + TTS. Model preparation is a separate, explicit command."""
from __future__ import annotations

import argparse
import hmac
import io
import json
import os
from pathlib import Path
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Neither tokenizer/model loading nor inference is allowed to download files.
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'
MAX_AUDIO = 5 * 1024 * 1024
MAX_SECONDS = 60
MAX_TEXT = 1000
MODELS = Path(__file__).resolve().parents[1] / 'models' / 'speech'


class SpeechError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def validate_text(value):
    if not isinstance(value, str) or not value.strip():
        raise SpeechError('朗读文字不能为空')
    text = value.strip()
    if len(text) > MAX_TEXT:
        raise SpeechError(f'一次朗读最多 {MAX_TEXT} 个字符')
    if any(ord(c) < 32 and c not in '\n\t\r' for c in text):
        raise SpeechError('朗读文字含无效控制字符')
    return text


def decode_audio(raw):
    """Bound decode to 61 seconds (encoder padding), then trim to 60 seconds."""
    import av
    import numpy as np
    if not raw:
        raise SpeechError('录音为空')
    chunks, total = [], 0
    try:
        with av.open(io.BytesIO(raw), mode='r') as container:
            if not container.streams.audio:
                raise SpeechError('文件没有音轨')
            resampler = av.audio.resampler.AudioResampler(format='flt', layout='mono', rate=16000)
            for frame in container.decode(audio=0):
                for out in resampler.resample(frame):
                    samples = out.to_ndarray().reshape(-1)
                    total += len(samples)
                    if total > 16000 * (MAX_SECONDS + 1):
                        raise SpeechError('录音超过 60 秒（允许 1 秒编码尾部）')
                    chunks.append(samples)
            for out in resampler.resample(None):
                samples = out.to_ndarray().reshape(-1)
                total += len(samples)
                if total > 16000 * (MAX_SECONDS + 1):
                    raise SpeechError('录音超过 60 秒（允许 1 秒编码尾部）')
                chunks.append(samples)
    except SpeechError:
        raise
    except Exception as exc:
        raise SpeechError('无法解码音频；请使用 WAV 或 WebM') from exc
    if total == 0:
        raise SpeechError('录音没有音频样本')
    samples = np.concatenate(chunks).astype(np.float32, copy=False)[:16000 * MAX_SECONDS]
    return samples, len(samples) / 16000


class SpeechEngine:
    def __init__(self, model_root=None, threads=None):
        root = Path(model_root or os.getenv('FOCUS_SPEECH_MODELS', MODELS)).expanduser().resolve()
        self.asr_path = Path(os.getenv('FOCUS_ASR_MODEL', root / 'asr-small')).expanduser().resolve()
        self.tts_path = Path(os.getenv('FOCUS_TTS_MODEL', root / 'zh_CN-huayan-medium.onnx')).expanduser().resolve()
        self.threads = max(1, min(8, threads or int(os.getenv('FOCUS_SPEECH_THREADS', '2'))))
        self.asr = self.tts = None
        self.asr_error = self.tts_error = '尚未加载'
        self.lock = threading.Lock()

    def load(self):
        self.asr_error = self.tts_error = None
        try:
            required = ['model.bin', 'config.json', 'tokenizer.json']
            if not all((self.asr_path / f).is_file() for f in required):
                raise SpeechError('本地 ASR 权重不完整；请执行 python speech/prepare_models.py')
            from faster_whisper import WhisperModel
            self.asr = WhisperModel(str(self.asr_path), device='cpu', compute_type='int8',
                                    cpu_threads=self.threads, num_workers=1, local_files_only=True)
        except SpeechError as exc:
            self.asr_error = str(exc)
        except ImportError:
            self.asr_error = 'ASR 依赖未安装；请安装 speech/requirements.txt'
        except Exception:
            self.asr_error = '本地 ASR 模型无法加载；请检查模型文件和 CPU 运行库'
        try:
            config_path = Path(str(self.tts_path) + '.json')
            if not self.tts_path.is_file() or not config_path.is_file():
                raise SpeechError('本地 TTS 权重不完整；请执行 python speech/prepare_models.py')
            config = json.loads(config_path.read_text(encoding='utf-8'))
            # Huayan uses bundled eSpeak data. Other phonemizers may auto-download extras.
            if config.get('phoneme_type', 'espeak') != 'espeak':
                raise SpeechError('离线服务仅接受已配套的 eSpeak 类型 Piper 模型')
            import onnxruntime as ort
            from piper import PiperVoice
            from piper.config import PiperConfig
            options = ort.SessionOptions()
            options.intra_op_num_threads = self.threads
            options.inter_op_num_threads = 1
            options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            session = ort.InferenceSession(str(self.tts_path), sess_options=options, providers=['CPUExecutionProvider'])
            self.tts = PiperVoice(session=session, config=PiperConfig.from_dict(config), use_tashkeel=False)
        except SpeechError as exc:
            self.tts_error = str(exc)
        except ImportError:
            self.tts_error = 'TTS 依赖未安装；请安装 speech/requirements.txt'
        except Exception:
            self.tts_error = '本地 TTS 模型无法加载；请检查 ONNX 和配套 JSON'

    def health(self):
        return {'service': 'focus-local-speech', 'localOnly': True, 'device': 'cpu',
                'threads': self.threads, 'busy': self.lock.locked(),
                'asr': {'ready': self.asr is not None, 'backend': 'faster-whisper',
                        'model': self.asr_path.name, 'computeType': 'int8', 'error': self.asr_error},
                'tts': {'ready': self.tts is not None, 'backend': 'piper',
                        'model': self.tts_path.name, 'error': self.tts_error}}

    def transcribe(self, raw):
        if self.asr is None:
            raise SpeechError(self.asr_error or '本地转写未就绪', 503)
        if not self.lock.acquire(blocking=False):
            raise SpeechError('本地语音正在处理上一项任务，请稍后重试', 429)
        try:
            samples, duration = decode_audio(raw)
            segments, info = self.asr.transcribe(samples, language='zh', task='transcribe',
                                                beam_size=3, vad_filter=True,
                                                condition_on_previous_text=False)
            text = ''.join(segment.text for segment in segments).strip()
            return {'text': text, 'language': info.language, 'durationSec': round(duration, 3),
                    'backend': 'local-faster-whisper', 'model': self.asr_path.name,
                    'status': 'transcribed' if text else 'no_speech', 'localOnly': True}
        finally:
            self.lock.release()

    def synthesize(self, value):
        text = validate_text(value)
        if self.tts is None:
            raise SpeechError(self.tts_error or '本地朗读未就绪', 503)
        if not self.lock.acquire(blocking=False):
            raise SpeechError('本地语音正在处理上一项任务，请稍后重试', 429)
        try:
            buffer = io.BytesIO()
            with wave.open(buffer, 'wb') as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(getattr(getattr(self.tts, 'config', None), 'sample_rate', 22050))
                self.tts.synthesize_wav(text, output)
            return buffer.getvalue()
        finally:
            self.lock.release()


def make_server(port=7791, engine=None, token=None):
    engine = engine or SpeechEngine()
    token = os.getenv('FOCUS_TOKEN', '') if token is None else token

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # do not log audio, text, or authentication tokens

        def reply(self, status, value, mime='application/json; charset=utf-8'):
            data = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(data)

        def authenticate(self):
            if token and not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                raise SpeechError('连接令牌无效', 401)
            # Only the companion server/CLI calls this service; browser talks to core.
            if self.headers.get('Origin'):
                raise SpeechError('请通过 FocusPendant 主服务调用语音接口', 403)

        def read_body(self, limit):
            try:
                size = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                raise SpeechError('无效 Content-Length')
            if size <= 0:
                raise SpeechError('请求体为空')
            if size > limit:
                raise SpeechError('请求体过大', 413)
            self.connection.settimeout(15)
            data = self.rfile.read(size)
            if len(data) != size:
                raise SpeechError('请求体不完整')
            return data

        def do_GET(self):
            try:
                self.authenticate()
                if self.path != '/health':
                    raise SpeechError('接口不存在', 404)
                self.reply(200, engine.health())
            except SpeechError as exc:
                self.reply(exc.status, {'error': str(exc)})

        def do_POST(self):
            try:
                self.authenticate()
                if self.path == '/transcribe':
                    mime = self.headers.get('Content-Type', '').split(';', 1)[0].lower()
                    if mime not in {'audio/wav', 'audio/x-wav', 'audio/webm'}:
                        raise SpeechError('仅接收 WAV 或 WebM 录音', 415)
                    self.reply(200, engine.transcribe(self.read_body(MAX_AUDIO)))
                elif self.path == '/synthesize':
                    try:
                        value = json.loads(self.read_body(8192))
                    except (ValueError, UnicodeDecodeError):
                        raise SpeechError('JSON 格式错误')
                    if not isinstance(value, dict):
                        raise SpeechError('请求应为 JSON 对象')
                    self.reply(200, engine.synthesize(value.get('text')), 'audio/wav')
                else:
                    raise SpeechError('接口不存在', 404)
            except SpeechError as exc:
                self.reply(exc.status, {'error': str(exc)})
            except Exception:
                self.reply(500, {'error': '本地语音处理失败；录音或原始文字保留在主服务'})

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    server.engine = engine
    return server


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=7791)
    args = parser.parse_args()
    speech = SpeechEngine()
    speech.load()
    print(json.dumps(speech.health(), ensure_ascii=False), flush=True)
    server = make_server(args.port, speech)
    print(f'本地语音服务 → http://127.0.0.1:{args.port}；Ctrl+C 停止', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
