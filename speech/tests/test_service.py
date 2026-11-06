import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from service import SpeechEngine, SpeechError, decode_audio, make_server, validate_text


def wav_bytes(seconds=1):
    data = io.BytesIO()
    with wave.open(data, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b'\0\0' * int(16000 * seconds))
    return data.getvalue()


class LocalSpeechTests(unittest.TestCase):
    def test_missing_models_remain_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = SpeechEngine(tmp)
            engine.load()
            health = engine.health()
            self.assertFalse(health['asr']['ready'])
            self.assertFalse(health['tts']['ready'])
            self.assertTrue(health['localOnly'])
            with self.assertRaises(SpeechError) as caught:
                engine.transcribe(wav_bytes())
            self.assertEqual(caught.exception.status, 503)
            with self.assertRaises(SpeechError):
                engine.synthesize('今天的专注记录已经保存。')

    def test_text_validation(self):
        for value in [None, '', ' ', ['文本'], 'x'*1001, '文本\0']:
            with self.assertRaises(SpeechError):
                validate_text(value)
        self.assertEqual(validate_text('  今日复盘。\n下一步。 '), '今日复盘。\n下一步。')

    def test_no_speech_does_not_fabricate_a_transcript(self):
        class Model:
            def transcribe(self, *args, **kwargs):
                return iter([]), type('Info', (), {'language': 'zh'})()
        e = SpeechEngine()
        e.asr = Model()
        with patch('service.decode_audio', return_value=([0], 1)):
            result = e.transcribe(b'fixture')
        self.assertEqual(result['text'], '')
        self.assertEqual(result['status'], 'no_speech')
        self.assertFalse(e.lock.locked())

    def test_busy_and_failed_inference_release(self):
        class Failed:
            def synthesize_wav(self, *args):
                raise RuntimeError('test failure')
        e = SpeechEngine()
        e.tts = Failed()
        e.lock.acquire()
        try:
            with self.assertRaises(SpeechError) as caught:
                e.synthesize('正在处理')
            self.assertEqual(caught.exception.status, 429)
        finally:
            e.lock.release()
        with self.assertRaises(RuntimeError):
            e.synthesize('失败后可以重试')
        self.assertFalse(e.lock.locked())

    @unittest.skipUnless(importlib.util.find_spec('av'), 'PyAV is optional until speech dependencies are installed')
    def test_audio_decode_duration_and_invalid_audio(self):
        samples, duration = decode_audio(wav_bytes(0.5))
        self.assertEqual(len(samples), 8000)
        self.assertEqual(duration, 0.5)
        samples, duration = decode_audio(wav_bytes(60.1))
        self.assertEqual(duration, 60)
        self.assertEqual(len(samples), 960000)
        with self.assertRaisesRegex(SpeechError, '超过 60'):
            decode_audio(wav_bytes(61.1))
        with self.assertRaises(SpeechError):
            decode_audio(b'not audio')

    def test_http_contract_token_missing_models_and_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            e = SpeechEngine(tmp)
            e.load()
            server = make_server(0, e, token='test-local-token')
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f'http://127.0.0.1:{server.server_address[1]}'
            def request(path, data=None, mime='application/json', authenticated=True):
                headers = {'Content-Type': mime}
                if authenticated:
                    headers['Authorization'] = 'Bearer test-local-token'
                req = urllib.request.Request(base + path, data=data, headers=headers)
                try:
                    with urllib.request.urlopen(req, timeout=5) as response:
                        return response.status, json.loads(response.read())
                except urllib.error.HTTPError as error:
                    return error.code, json.loads(error.read())
            try:
                self.assertEqual(request('/health', authenticated=False)[0], 401)
                status, health = request('/health')
                self.assertEqual(status, 200)
                self.assertFalse(health['tts']['ready'])
                self.assertEqual(request('/transcribe', wav_bytes(), 'audio/wav')[0], 503)
                self.assertEqual(request('/transcribe', b'bytes', 'text/plain')[0], 415)
                self.assertEqual(request('/synthesize', b'[]')[0], 400)
                self.assertEqual(request('/synthesize', json.dumps({'text': '本地朗读'}).encode())[0], 503)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)


if __name__ == '__main__':
    unittest.main()
