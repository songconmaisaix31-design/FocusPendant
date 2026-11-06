#!/usr/bin/env python3
"""Run a real local TTS → ASR check after preparing the models."""
import json
import time
from service import SpeechEngine

engine = SpeechEngine()
engine.load()
health = engine.health()
if not health['asr']['ready'] or not health['tts']['ready']:
    print(json.dumps(health, ensure_ascii=False, indent=2))
    raise SystemExit('本地模型未就绪')
text = '今天完成了二十五分钟的阅读。接下来，我要休息五分钟。'
start = time.monotonic()
audio = engine.synthesize(text)
tts_seconds = time.monotonic() - start
start = time.monotonic()
result = engine.transcribe(audio)
print(json.dumps({'input': text, 'output': result, 'ttsSeconds': round(tts_seconds, 3),
                  'asrSeconds': round(time.monotonic() - start, 3),
                  'testSource': 'synthetic_local_tts_not_real_microphone'}, ensure_ascii=False, indent=2))
if not result['text']:
    raise SystemExit('模型已运行，但本次合成语音未转写出文字')
