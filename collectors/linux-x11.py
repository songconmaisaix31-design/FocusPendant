#!/usr/bin/env python3
"""Foreground-window collector for an X11 desktop; not Wayland or WSL windows.

Usage: python3 collectors/linux-x11.py [--include-titles] [--once]
Needs system commands xprop and xprintidle (Ubuntu: apt install x11-utils xprintidle).
Reads FOCUS_SERVER_URL (default http://127.0.0.1:7788), optional FOCUS_TOKEN.
Stops with Ctrl+C; does not install a service or start other processes persistently.
"""
import argparse
import hashlib
import json
import math
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def command(*args):
    return subprocess.check_output(args, text=True, timeout=3, stderr=subprocess.DEVNULL)


def active_window(output):
    match = re.search(r"(?:window id #|=)\s*(0x[0-9a-fA-F]+)", output)
    if not match or int(match.group(1), 16) == 0:
        raise ValueError("No foreground window is available")
    return match.group(1)


def parse_properties(output, include_titles=False):
    result = {"app": "unknown"}
    for line in output.splitlines():
        if line.startswith("WM_CLASS("):
            values = re.findall(r'"((?:\\.|[^"\\])*)"', line)
            if values:
                result["app"] = values[-1][:120]
        elif include_titles and line.startswith("_NET_WM_NAME(") and " = " in line:
            result["title"] = line.split(" = ", 1)[1].strip('"')[:512]
    return result


def sample(session_salt, include_titles=False):
    window = active_window(command("xprop", "-root", "_NET_ACTIVE_WINDOW"))
    properties = ["WM_CLASS"]
    if include_titles:
        properties.append("_NET_WM_NAME")
    result = parse_properties(command("xprop", "-id", window, *properties), include_titles)
    idle = float(command("xprintidle").strip()) / 1000
    if not math.isfinite(idle) or idle < 0:
        raise ValueError("Invalid idle duration")
    result.update(type="window", ts=int(time.time() * 1000), idle_sec=round(idle, 1),
                  windowId=hashlib.sha256((session_salt + ":" + window).encode()).hexdigest()[:16])
    return result


def send(server_url, token, event):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(server_url.rstrip("/") + "/events",
                                     data=json.dumps(event).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=5) as response:
        if not 200 <= response.status < 300:
            raise ValueError("Server did not accept the sample")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", default=os.getenv("FOCUS_SERVER_URL", "http://127.0.0.1:7788"))
    parser.add_argument("--interval", type=float, default=5)
    parser.add_argument("--include-titles", action="store_true")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    if urllib.parse.urlparse(args.server).scheme not in ("http", "https"):
        parser.error("--server must be an http:// or https:// URL")
    if not 1 <= args.interval <= 300:
        parser.error("--interval must be between 1 and 300 seconds")
    if os.getenv("XDG_SESSION_TYPE") == "wayland" or os.getenv("WAYLAND_DISPLAY"):
        parser.error("Wayland is unsupported: this collector cannot observe all foreground windows. Use an X11 session.")
    if not os.getenv("DISPLAY"):
        parser.error("No X11 DISPLAY. In WSL use windows.ps1 from Windows PowerShell to collect Windows activity.")
    missing = [tool for tool in ("xprop", "xprintidle") if not shutil.which(tool)]
    if missing:
        parser.error("Missing tools: " + ", ".join(missing) + ". Ubuntu: sudo apt install x11-utils xprintidle")
    salt, had_error = secrets.token_hex(16), False
    print(f"FocusPendant X11 collector started; titles: {args.include_titles}. Ctrl+C stops collection.")
    try:
        while True:
            try:
                send(args.server, os.getenv("FOCUS_TOKEN", ""), sample(salt, args.include_titles))
                if had_error:
                    print("Collector connection restored.", flush=True)
                had_error = False
            except (OSError, ValueError, subprocess.SubprocessError) as exc:
                if args.once:
                    print(f"Could not collect or deliver activity: {type(exc).__name__}.", file=sys.stderr)
                    return 1
                if not had_error:
                    print("Could not collect or deliver activity. Check the desktop and local server; retrying.", file=sys.stderr)
                had_error = True
            if args.once:
                return 0
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nFocusPendant X11 collector stopped.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
