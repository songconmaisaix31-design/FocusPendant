#!/usr/bin/env python3
"""Capture a PC/phone virtual camera and send sparse frames to the local FocusPendant server."""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", type=int, default=0, help="Camera device index; virtual phone cameras often use 1")
    parser.add_argument("--interval", type=float, default=30, help="Seconds between sampled frames; minimum 5")
    parser.add_argument("--server", default=os.getenv("FOCUS_SERVER_URL", "http://127.0.0.1:7788"))
    args = parser.parse_args()
    if args.interval < 5:
        parser.error("--interval must be at least 5 seconds")
    try:
        import cv2
    except ImportError:
        print("Install collectors/requirements-camera.txt before starting camera capture.", file=sys.stderr)
        return 1
    headers = {"Content-Type": "image/jpeg"}
    if os.getenv("FOCUS_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["FOCUS_TOKEN"]
    camera = None
    next_sample = 0
    print("Camera capture starting. Aim only at your desk. Ctrl+C stops capture. No images are saved.", flush=True)
    try:
        while True:
            if camera is None:
                camera = cv2.VideoCapture(args.device)
                camera.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                if not camera.isOpened():
                    camera.release()
                    camera = None
                    print("Camera unavailable; no visual events will be sent. Retrying in 3 seconds.", flush=True)
                    time.sleep(3)
                    continue
            ok, frame = camera.read()
            if not ok:
                camera.release()
                camera = None
                print("Camera disconnected; visual reporting stopped.", flush=True)
                time.sleep(3)
                continue
            now = time.monotonic()
            if now < next_sample:
                time.sleep(0.1)
                continue
            height, width = frame.shape[:2]
            scale = min(512 / width, 512 / height, 1)
            small = cv2.resize(frame, (round(width * scale), round(height * scale)))
            ok, encoded = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 50])
            if ok:
                request = urllib.request.Request(args.server.rstrip("/") + "/api/frame", data=encoded.tobytes(),
                                                 headers=headers, method="POST")
                try:
                    with urllib.request.urlopen(request, timeout=25) as response:
                        result = json.loads(response.read(64 * 1024))
                    print(json.dumps({key: result[key] for key in ("scene", "confidence", "observed", "backend", "reason", "error") if key in result}), flush=True)
                except urllib.error.HTTPError as error:
                    print(f"Frame rejected by FocusPendant (HTTP {error.code}); check capture settings and token.", flush=True)
                except (urllib.error.URLError, TimeoutError, ValueError):
                    print("FocusPendant server unavailable; frame discarded.", flush=True)
            # The next frame is fresh from the camera after the sampling interval.
            next_sample = time.monotonic() + args.interval
    except KeyboardInterrupt:
        print("Camera stopped.", flush=True)
    finally:
        if camera is not None:
            camera.release()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
