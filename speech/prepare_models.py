#!/usr/bin/env python3
"""Explicitly download CPU ASR and Chinese TTS model assets. Never called by service."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil


def prepare(root, asr_size='small', asr_only=False, tts_only=False):
    from huggingface_hub import hf_hub_download, snapshot_download
    root = Path(root).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    saved = []
    if not tts_only:
        target = root / ('asr-' + asr_size)
        snapshot_download('Systran/faster-whisper-' + asr_size, local_dir=target,
                          allow_patterns=['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.*', 'preprocessor_config.json'])
        for name in ['config.json', 'model.bin', 'tokenizer.json']:
            if not (target / name).is_file():
                raise RuntimeError('ASR model is incomplete: ' + name)
        saved.extend(p for p in target.iterdir() if p.is_file())
        # HF local-dir metadata/cache is not needed for strictly local inference.
        # Some downloader versions leave large temporary transfer files here.
        shutil.rmtree(target / '.cache', ignore_errors=True)
    if not asr_only:
        prefix = 'zh/zh_CN/huayan/medium/'
        for name in ['zh_CN-huayan-medium.onnx', 'zh_CN-huayan-medium.onnx.json', 'MODEL_CARD']:
            cached = hf_hub_download('rhasspy/piper-voices', filename=prefix + name)
            target = root / (name if name != 'MODEL_CARD' else 'huayan-MODEL_CARD')
            shutil.copyfile(cached, target)
            saved.append(target)
    records = []
    for file in saved:
        hasher = hashlib.sha256()
        with file.open('rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                hasher.update(chunk)
        records.append({'file': str(file.relative_to(root)), 'bytes': file.stat().st_size, 'sha256': hasher.hexdigest()})
    (root / 'prepared-models.json').write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'Models prepared in {root}')
    if asr_size != 'small':
        print(f'Before starting service: export FOCUS_ASR_MODEL="{root / ("asr-" + asr_size)}"')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default=os.getenv('FOCUS_SPEECH_MODELS', str(Path(__file__).resolve().parents[1] / 'models' / 'speech')))
    parser.add_argument('--asr-size', choices=['tiny', 'base', 'small'], default='small')
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--asr-only', action='store_true')
    group.add_argument('--tts-only', action='store_true')
    args = parser.parse_args()
    prepare(args.output, args.asr_size, args.asr_only, args.tts_only)
