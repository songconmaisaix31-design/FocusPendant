"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("@irisview/osx/os");
const input = require("@irisview/osx/os/input");
const { Board, Color, Font, FusionRoot, Text, TextAlign } = require("@irisview/osx/fusionui");
const { applicationDataDirectory } = require("./application-data");
const { LocalLite } = require("./local-lite");
const { parseWave } = require("./speech-playback");

const base = (process.env.FOCUS_SERVER_URL || "http://127.0.0.1:7788").replace(/\/$/, "");
const token = process.env.FOCUS_TOKEN || "";
const state = { alive: false, foreground: true, online: false, snapshot: null, message: "连接注意力服务…", messageUntil: Infinity, voice: null, local: null, localMode: false };
const retained = {};
let polling = false;
let actionChain = Promise.resolve();
let speechBusy = false;
let lastSpeechId = "";
let playbackFile = null;
let activeSpeech = null;

function acknowledgeSpeech(id, status, error) {
  api("/api/speech/ack", { id, status, ...(error ? { error } : {}) }).catch(() => {});
}

function notice(message, milliseconds = 4000) {
  state.message = message;
  state.messageUntil = Date.now() + milliseconds;
  render();
}

async function api(route, body) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${route}`, {
    method: body === undefined ? "GET" : "POST", headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(2500)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function poll() {
  if (polling || !state.alive) return;
  polling = true;
  try {
    const snapshot = await api("/api/state");
    if (!state.alive) return;
    state.online = true;
    state.snapshot = snapshot;
    receiveSpeech(snapshot.speech);
    if (state.localMode && !state.local.data.active) state.localMode = false;
    if (state.messageUntil === Infinity) state.messageUntil = 0;
    render();
  } catch {
    state.online = false;
    if (!state.snapshot || ["idle", "finished"].includes(state.snapshot.phase)) state.localMode = true;
    if (!state.localMode) notice("服务断开 · 会话等待重连", 2500);
    else if (state.messageUntil === Infinity) state.messageUntil = 0;
  } finally { polling = false; }
}

function act(action, extra = {}) {
  actionChain = actionChain.then(async () => {
    if (!state.alive) return;
    if (state.localMode) {
      if (action === "mode") { notice("本机仅 LITE · 请启动服务"); return; }
      const record = state.local.action(action);
      if (record && state.online) {
        try { await api("/api/action", { action: "checkin", text: `眼镜离线专注 ${Math.round(record.focusSec / 60)} 分钟，分心 ${record.distractions} 次`, source: "iris-standalone", durationSec: record.focusSec }); } catch {}
      }
      if (!state.local.data.active && state.online) state.localMode = false;
      render();
      return;
    }
    try { await api("/api/action", { action, ...extra }); await poll(); }
    catch { notice("操作未发送 · 请检查服务"); }
  });
}

function render() {
  if (!retained.text) return;
  const snapshot = state.localMode ? state.local.snapshot() : state.snapshot;
  const lines = snapshot && Array.isArray(snapshot.hudLines)
    ? snapshot.hudLines.slice(0, 3)
    : ["FocusPendant", "注意力日记", "等待本地服务"];
  while (lines.length < 3) lines.push("");
  if (state.voice) lines[2] = state.voice.recording ? "录音中 · 右键结束" : "等待麦克风授权";
  else if (Date.now() < state.messageUntil) lines[2] = state.message;
  else {
    const battery = os.getBatteryStatus();
    if (battery.availability === "available" && battery.percent !== null && battery.percent <= 15 && !battery.externalPower) lines[2] = `电量 ${battery.percent}% · 请连接电源`;
  }
  const text = lines.map(line => Array.from(String(line).replace(/[\r\n]/g, " ")).slice(0, 22).join("")).join("\n");
  if (text !== retained.lastText) {
    retained.text.setText(text);
    retained.lastText = text;
  }
}

function handleNavigation(action) {
  const snapshot = (state.localMode ? state.local.snapshot() : state.snapshot) || {};
  const phase = snapshot.phase || "idle";
  if (action === "right") { toggleVoice(); return; }
  if (action === "activate") {
    act(phase === "idle" || phase === "finished" ? "start" : phase === "paused" ? "resume" : "pause");
  } else if (action === "up") {
    if (phase === "idle" || phase === "finished") {
      const modes = ["lite", "flow", "vision"];
      const current = String(snapshot.modeRequested || "lite").toLowerCase();
      act("mode", { mode: modes[(modes.indexOf(current) + 1) % modes.length] });
    } else act("checkin", { text: "我仍在当前任务上", source: "iris-navigation" });
  } else if (action === "down") act("distraction");
  else if (action === "left" || action === "back") { stopSpeech(); act("finish"); }
}

function stopSpeech() {
  if (activeSpeech) activeSpeech.stopRequested = true;
  try { os.commandRemoteMedia(os.RemoteMediaCommand.STOP); } catch {}
}

function monitorSpeech() {
  if (!activeSpeech) return;
  const snapshot = os.readRemoteMediaSnapshot();
  if (!snapshot) return;
  if (snapshot.state === os.RemoteMediaState.PLAYING && !activeSpeech.started) {
    activeSpeech.started = true;
    acknowledgeSpeech(activeSpeech.id, "started");
  } else if (snapshot.state === os.RemoteMediaState.COMPLETED) {
    acknowledgeSpeech(activeSpeech.id, "completed"); activeSpeech = null;
  } else if (snapshot.state === os.RemoteMediaState.FAILED) {
    acknowledgeSpeech(activeSpeech.id, "error", `IrisView media error ${snapshot.failureCode}`); activeSpeech = null;
    notice("眼镜朗读失败 · 网页可播放");
  } else if (snapshot.state === os.RemoteMediaState.STOPPED && activeSpeech.stopRequested) {
    acknowledgeSpeech(activeSpeech.id, "stopped"); activeSpeech = null;
  }
}

async function requestSpeech() {
  notice("本地生成复盘语音…", 185000);
  try {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${base}/api/speech`, { method: "POST", headers, body: JSON.stringify({ target: "iris" }), signal: AbortSignal.timeout(185000) });
    if (!response.ok) throw new Error("本地语音服务未就绪");
    notice("语音请求已提交");
    poll();
  } catch { notice("朗读未生成 · 检查本地语音服务"); }
}

async function receiveSpeech(speech) {
  if (!state.foreground || state.voice || speechBusy || !speech || speech.target !== "iris" || speech.status !== "ready" || !speech.id || speech.id === lastSpeechId) return;
  // Never replay a saved report merely because the application restarted.
  if (!Number.isFinite(speech.createdAt) || Date.now() - speech.createdAt > 120000 || Date.now() < speech.createdAt - 5000) return;
  if (!/^\/speech\/[a-f0-9-]{36}\.wav$/.test(speech.url || "")) return;
  lastSpeechId = String(speech.id); speechBusy = true;
  try {
    fs.writeFileSync(path.join(retained.dataDirectory, "last-speech.json"), JSON.stringify({ id: lastSpeechId }), { mode: 0o600 });
    const response = await fetch(base + speech.url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("Speech download failed");
    if (Number(response.headers.get("content-length") || 0) > 20 * 1024 * 1024) throw new Error("Speech too large");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 20 * 1024 * 1024) throw new Error("Speech too large");
    const metadata = parseWave(bytes);
    if (!state.alive || !state.foreground || state.voice) { acknowledgeSpeech(speech.id, "stopped"); return; }
    const directory = path.join(retained.dataDirectory, "speech");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, `${speech.id}.wav`);
    fs.writeFileSync(filename, bytes, { mode: 0o600 });
    stopSpeech();
    if (!os.configureRemoteMedia({ absolutePath: filename, ...metadata, codec: os.RemoteMediaCodec.PCM_WAVE, title: "FocusPendant 本地复盘", autoplay: true, synchronizeVisuals: false })) throw new Error("Media playback not admitted");
    activeSpeech = { id: speech.id, started: false, stopRequested: false };
    if (playbackFile && playbackFile !== filename) { try { fs.unlinkSync(playbackFile); } catch {} }
    playbackFile = filename;
    notice("本地朗读已提交 · 左键停止");
  } catch { acknowledgeSpeech(speech.id, "error", "IrisView could not prepare local WAV playback"); notice("眼镜朗读未启动 · 网页可播放"); }
  finally { speechBusy = false; }
}

function toggleVoice() {
  if (state.voice) { state.voice.session.finish(); return; }
  stopSpeech();
  try {
    const availability = input.getVoiceInputAvailability("audio");
    if (!availability.canRequest) { notice(`录音不可用 · ${availability.reason}`); return; }
    const directory = path.join(retained.dataDirectory, "voice");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, `${Date.now()}.wav`);
    const fd = fs.openSync(filename, "wx", 0o600);
    fs.writeSync(fd, Buffer.alloc(44));
    try {
      const session = input.requestVoiceInput({ mode: "audio" });
      state.voice = { session, fd, filename, samples: 0, sequence: 0, recording: false };
    } catch (error) { fs.closeSync(fd); fs.unlinkSync(filename); throw error; }
  } catch (error) { notice(`录音未开始 · ${error.code || "设备不可用"}`); }
  render();
}

function waveHeader(samples) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + samples * 2, 4);
  header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(samples * 2, 40);
  return header;
}

function closeVoice(voice, keep) {
  if (voice.fd !== null) {
    if (keep) fs.writeSync(voice.fd, waveHeader(voice.samples), 0, 44, 0);
    fs.closeSync(voice.fd); voice.fd = null;
  }
  if (!keep && fs.existsSync(voice.filename)) fs.unlinkSync(voice.filename);
}

async function uploadVoice(voice) {
  try {
    const headers = { "Content-Type": "application/octet-stream", "X-Audio-Sample-Rate": "16000" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const pcm = fs.readFileSync(voice.filename).subarray(44);
    const response = await fetch(`${base}/api/voice`, { method: "POST", headers, body: pcm, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (result.status !== "saved") throw new Error("Voice save not confirmed");
    fs.unlinkSync(voice.filename);
    notice("语音已保存 · 本地转写中");
    // /api/voice creates its own check-in; do not count the same capture twice.
    if (state.localMode) state.local.action("checkin");
    poll();
  } catch {
    notice("语音已存眼镜本机 · 未转写");
    act("checkin", { text: "语音仅保存于眼镜本机（尚未转写）", source: "iris-audio-local", durationSec: voice.samples / 16000 });
    console.log(`FocusPendant voice saved locally: ${voice.filename}`);
  }
}

function drainVoice() {
  const voice = state.voice;
  if (!voice) return;
  let event;
  while ((event = voice.session.takeEvent()) !== null) {
    if (event.type === "state") voice.recording = event.state === "recording";
    else if (event.type === "audio") {
      if (event.sequence !== voice.sequence || event.sampleOffset !== voice.samples || voice.samples + event.sampleCount > 960000) {
        voice.invalid = true; voice.session.cancel(); continue;
      }
      if (!voice.invalid) {
        fs.writeSync(voice.fd, event.data);
        voice.sequence += 1; voice.samples += event.sampleCount;
      }
    } else if (event.type === "end") {
      const keep = event.status === "completed" && !voice.invalid && voice.samples > 0;
      closeVoice(voice, keep);
      state.voice = null;
      if (keep) {
        notice("正在保存语音…");
        uploadVoice(voice);
      } else notice(`录音未保存 · ${event.reason}`);
      break;
    }
  }
}

function frame(timestamp) {
  if (!state.alive) return;
  try {
    if (state.local) state.local.tick(timestamp);
    drainVoice();
    monitorSpeech();
    if (state.foreground) {
      let action;
      while ((action = input.takeNavigationAction()) !== null) handleNavigation(action);
      let submission;
      while ((submission = input.takeTextInput()) !== null) {
        if (submission.text.trim() === "/read") requestSpeech();
        else if (submission.text.trim() === "/stop") { stopSpeech(); notice("已请求停止朗读"); }
        else act("checkin", { text: submission.text, source: "iris-text" });
      }
    }
    render();
  } catch (error) {
    if (state.voice) {
      state.voice.invalid = true;
      try { state.voice.session.cancel(); closeVoice(state.voice, false); } catch {}
    }
    notice("输入异常 · 可使用电脑控制");
    console.error("FocusPendant input:", error.message);
  }
  retained.frameId = os.requestAnimationFrame(frame);
}

function start() {
  if (state.alive) return;
  state.alive = true;
  retained.dataDirectory = applicationDataDirectory();
  try { lastSpeechId = JSON.parse(fs.readFileSync(path.join(retained.dataDirectory, "last-speech.json"), "utf8")).id || ""; } catch {}
  state.local = new LocalLite(retained.dataDirectory);
  state.localMode = state.local.data.active;
  const property = os.WindowProperty.create();
  property.setTitle("FocusPendant");
  property.setSize([0.64, 0.48, 0.01]);
  retained.window = os.Window.create(property);
  retained.root = FusionRoot.acquireFusionRootFromWindow(retained.window);
  retained.board = Board.create();
  retained.board.setParent(retained.root.getRootWidget());
  retained.board.setIgnoreLayout(true);
  retained.board.setSize([640, 480, 0]);
  retained.board.getLocalStyle().setBackgroundColor(Color.fromRGB8(0, 0, 0));
  retained.text = Text.create();
  retained.text.setParent(retained.board);
  retained.text.setSize([640, 480, 0]);
  retained.text.getLocalStyle().setTextColor(Color.fromRGB8(0, 255, 0));
  retained.text.getLocalStyle().setTextFont(Font.getCachedFont("", 26, 0, 0));
  retained.text.getLocalStyle().setTextAlign(TextAlign.CENTER);
  input.requestWindowFocus(retained.window);
  os.setDisplayKeepAwake(true);
  render(); poll();
  retained.pollTimer = setInterval(poll, 1000);
  retained.frameId = os.requestAnimationFrame(frame);
  console.log("FocusPendant IrisView application ready");
}

os.App.createApp(lifecycle => {
  if (lifecycle === os.AppLifecycle.ON_CREATE) start();
  else if (lifecycle === os.AppLifecycle.ON_BACKGROUND) {
    state.foreground = false;
    os.setDisplayKeepAwake(false);
    if (state.voice) state.voice.session.cancel();
  } else if (lifecycle === os.AppLifecycle.ON_FOREGROUND || lifecycle === os.AppLifecycle.ON_REOPEN) {
    state.foreground = true;
    if (state.alive) { os.setDisplayKeepAwake(true); input.requestWindowFocus(retained.window); poll(); }
  } else if (lifecycle === os.AppLifecycle.ON_DESTROY) {
    state.alive = false;
    clearInterval(retained.pollTimer);
    os.cancelAnimationFrame(retained.frameId);
    os.setDisplayKeepAwake(false);
    stopSpeech();
    try { os.releaseRemoteMedia(); } catch {}
    if (state.voice) { state.voice.session.cancel(); closeVoice(state.voice, false); state.voice = null; }
    retained.text = undefined; retained.board = undefined;
    retained.root = undefined; retained.window = undefined;
  }
});
