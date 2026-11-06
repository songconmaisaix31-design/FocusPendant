#!/usr/bin/env python3
"""Local camera-frame classifier. Images stay in memory; no automatic model download."""
from __future__ import annotations

import argparse
import base64
import hmac
import io
import json
import math
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCENES = {
    "reading": "a person reading an open book on a desk",
    "writing": "a hand writing with a pen in a notebook on a desk",
    "meeting": "people attending a meeting around a table",
    "screen_work": "hands working at a computer keyboard on a desk",
    "eating": "a person eating food at a table",
    "exercise": "a person doing physical exercise",
    "away": "an empty desk with no person or hands present",
    "other": "a desk activity other than reading, writing, computer work, or eating",
    "unknown": "an unclear or obstructed image whose activity cannot be determined",
}
MAX_FRAME = 2 * 1024 * 1024


def unknown(reason: str, backend="none", quality=None):
    return {"scene": "unknown", "confidence": 0, "objects": [], "backend": backend,
            "observed": False, "reason": reason,
            "quality": quality or {"accepted": False, "reason": reason}}


def parse_prediction(content):
    """Accept only a small structured result, never inferred prose."""
    if isinstance(content, str):
        text = content.strip()
        if text.startswith("```"):
            parts = text.splitlines()
            if len(parts) < 3 or parts[-1].strip() != "```":
                raise ValueError("invalid_model_json")
            text = "\n".join(parts[1:-1])
        value = json.loads(text)
    else:
        value = content
    if not isinstance(value, dict) or value.get("scene") not in SCENES:
        raise ValueError("invalid_scene")
    score = value.get("confidence")
    if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 1:
        raise ValueError("invalid_confidence")
    objects = value.get("objects", [])
    if not isinstance(objects, list) or any(not isinstance(x, str) for x in objects):
        raise ValueError("invalid_objects")
    return {"scene": value["scene"], "confidence": float(score), "objects": [x[:40] for x in objects[:8]]}


class FrameGate:
    def __init__(self, min_brightness=18, min_sharpness=8, duplicate_seconds=5):
        self.min_brightness = min_brightness
        self.min_sharpness = min_sharpness
        self.duplicate_seconds = duplicate_seconds
        self.previous = None
        self.previous_at = 0.0

    def inspect(self, raw: bytes, now=None):
        from PIL import Image, ImageOps, UnidentifiedImageError
        now = time.monotonic() if now is None else now
        try:
            with Image.open(io.BytesIO(raw)) as incoming:
                if incoming.width * incoming.height > 16_000_000:
                    return None, {"accepted": False, "reason": "image_too_large"}
                if incoming.width < 32 or incoming.height < 32:
                    return None, {"accepted": False, "reason": "image_too_small"}
                image = ImageOps.exif_transpose(incoming).convert("RGB")
                image.thumbnail((512, 512))
        except (UnidentifiedImageError, OSError, ValueError):
            return None, {"accepted": False, "reason": "invalid_image"}
        gray = list(image.convert("L").resize((64, 64)).getdata())
        brightness = sum(gray) / len(gray)
        lap = [4 * gray[y*64+x] - gray[y*64+x-1] - gray[y*64+x+1]
               - gray[(y-1)*64+x] - gray[(y+1)*64+x]
               for y in range(1, 63) for x in range(1, 63)]
        mean = sum(lap) / len(lap)
        sharpness = sum((n-mean)**2 for n in lap) / len(lap)
        quality = {"accepted": True, "reason": "ok", "brightness": round(brightness, 2),
                   "sharpness": round(sharpness, 2)}
        if brightness < self.min_brightness:
            quality.update(accepted=False, reason="too_dark")
        elif brightness > 249:
            quality.update(accepted=False, reason="overexposed")
        elif sharpness < self.min_sharpness:
            quality.update(accepted=False, reason="blurred_or_occluded")
        elif self.previous and now - self.previous_at < self.duplicate_seconds:
            difference = sum(abs(a-b) for a, b in zip(gray, self.previous)) / len(gray)
            if difference < 2:
                quality.update(accepted=False, reason="duplicate_within_5s")
        if not quality["accepted"]:
            image.close()
            return None, quality
        self.previous = gray
        self.previous_at = now
        return image, quality


class LocalCLIP:
    def __init__(self, model_name=None):
        self.model_name = model_name or os.getenv("FOCUS_CLIP_MODEL", "openai/clip-vit-base-patch32")
        self.model = self.processor = self.torch = None
        self.error = None
        self.attempted = False

    def load(self):
        if self.attempted:
            return self.model is not None
        self.attempted = True
        try:
            import torch
            from transformers import CLIPModel, CLIPProcessor
            torch.set_num_threads(max(1, int(os.getenv("FOCUS_CLIP_THREADS", "2"))))
            # Never download weights in a capture/classify request, including cloud fallback.
            self.processor = CLIPProcessor.from_pretrained(self.model_name, local_files_only=True)
            self.model = CLIPModel.from_pretrained(self.model_name, local_files_only=True).eval()
            self.torch = torch
        except ImportError:
            self.error = "local_dependencies_missing: install collectors/requirements-vision.txt"
        except Exception:
            self.error = "local_model_unavailable: pre-download weights or set FOCUS_CLIP_MODEL to a local directory"
        return self.model is not None

    def classify(self, image):
        if not self.load():
            return unknown(self.error, "local-clip")
        labels = list(SCENES)
        inputs = self.processor(text=list(SCENES.values()), images=image, return_tensors="pt", padding=True)
        with self.torch.inference_mode():
            scores = self.model(**inputs).logits_per_image.softmax(dim=1)[0]
        index = int(scores.argmax().item())
        return {"scene": labels[index], "confidence": float(scores[index].item()), "objects": [],
                "backend": "local-clip", "observed": True,
                "scoreKind": "uncalibrated_relative_similarity"}

    def health(self):
        return {"ready": self.model is not None, "model": self.model_name, "error": self.error}


class VisionEngine:
    def __init__(self, local=None, gate=None):
        self.local = local or LocalCLIP()
        self.gate = gate or FrameGate()
        self.lock = threading.Lock()
        self.mode = os.getenv("FOCUS_VISION_BACKEND", "local").lower()
        if self.mode not in {"local", "cloud"}:
            raise ValueError("FOCUS_VISION_BACKEND must be local or cloud")
        self.cloud_url = os.getenv("FOCUS_VLM_URL", "")
        self.cloud_model = os.getenv("FOCUS_VLM_MODEL", "")
        self.cloud_key = os.getenv("FOCUS_VLM_API_KEY", "")

    def cloud_ready(self):
        target = urllib.parse.urlparse(self.cloud_url)
        secure = target.scheme == "https" or (target.scheme == "http" and target.hostname in {"localhost", "127.0.0.1", "::1"})
        return bool(secure and self.cloud_model and self.cloud_key)

    def health(self):
        local = self.local.health()
        return {"service": "focus-vision", "backend": self.mode, "local": local,
                "cloudConfigured": self.cloud_ready(),
                "ready": local["ready"] or (self.mode == "cloud" and self.cloud_ready()),
                "framesStored": False, "localOnlyHeaderSupported": True}

    def cloud(self, image):
        if not self.cloud_ready():
            raise ValueError("cloud_not_configured")
        encoded = io.BytesIO()
        image.save(encoded, format="JPEG", quality=50)
        prompt = ("Classify the visible desk activity only. Do not infer attention, intentions, identity, "
                  "phone use, or mental state. Return a JSON object with scene, confidence (0..1), "
                  "objects (up to 8 visible object names). scene must be one of: " + ", ".join(SCENES) +
                  ". If the evidence is insufficient use unknown. A book merely being visible does not establish reading.")
        body = {"model": self.cloud_model, "temperature": 0, "max_tokens": 150,
                "messages": [{"role": "user", "content": [{"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(encoded.getvalue()).decode()}}]}]}
        request = urllib.request.Request(self.cloud_url, data=json.dumps(body).encode(), method="POST",
                                         headers={"Authorization": "Bearer " + self.cloud_key, "Content-Type": "application/json"})
        # urllib's default redirects can resend the Authorization header. Reject redirects here.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        with urllib.request.build_opener(NoRedirect).open(request, timeout=12) as response:
            payload = response.read(64 * 1024 + 1)
            if len(payload) > 64 * 1024:
                raise ValueError("cloud_response_too_large")
            result = json.loads(payload)
        prediction = parse_prediction(result["choices"][0]["message"]["content"])
        return {**prediction, "backend": "cloud-vlm", "observed": True, "scoreKind": "model_self_reported"}

    def classify(self, raw: bytes, local_only=True):
        if not self.lock.acquire(blocking=False):
            return unknown("classifier_busy")
        image = None
        try:
            try:
                image, quality = self.gate.inspect(raw)
            except ImportError:
                return unknown("image_dependency_missing: install Pillow")
            if image is None:
                return unknown(quality["reason"], quality=quality)
            if self.mode == "cloud" and not local_only:
                try:
                    result = self.cloud(image)
                except Exception:
                    result = self.local.classify(image)
                    result["fallbackReason"] = "cloud_unavailable_or_invalid_response"
            else:
                result = self.local.classify(image)
            return {**result, "quality": quality, "localOnly": local_only}
        except Exception:
            return unknown("classification_failed", "local-clip" if local_only else self.mode)
        finally:
            if image is not None:
                image.close()
            self.lock.release()


def serve(port=7790):
    engine = VisionEngine()
    engine.local.load()
    token = os.getenv("FOCUS_TOKEN", "")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # no frame bodies, auth tokens, or cloud content in access logs

        def reply(self, status, value):
            data = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def authorized(self):
            return not token or hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token)

        def do_GET(self):
            if not self.authorized():
                return self.reply(401, {"error": "unauthorized"})
            if self.path != "/health":
                return self.reply(404, {"error": "not_found"})
            self.reply(200, engine.health())

        def do_POST(self):
            if not self.authorized():
                return self.reply(401, {"error": "unauthorized"})
            if self.path != "/classify":
                return self.reply(404, {"error": "not_found"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                return self.reply(400, {"error": "invalid_content_length"})
            if not 0 < size <= MAX_FRAME:
                return self.reply(413, {"error": "frame_must_be_1_to_2097152_bytes"})
            if self.headers.get("Content-Type", "").split(";")[0] not in {"image/jpeg", "image/png"}:
                return self.reply(415, {"error": "use_image_jpeg_or_png"})
            self.connection.settimeout(15)
            try:
                raw = self.rfile.read(size)
            except TimeoutError:
                return self.reply(408, {"error": "frame_read_timeout"})
            if len(raw) != size:
                return self.reply(400, {"error": "incomplete_frame"})
            # Only the literal false opts into cloud. Header omitted means local-only.
            local_only = self.headers.get("X-Focus-Local-Only", "true").lower() != "false"
            self.reply(200, engine.classify(raw, local_only=local_only))

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    print(json.dumps({"listening": f"http://127.0.0.1:{port}", **engine.health()}, ensure_ascii=False), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=7790)
    args = parser.parse_args()
    serve(args.port)
