"use strict";

// Public API contract test only; this does not assert native rendering or mic hardware.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const project = path.resolve(__dirname, "..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "focus-iris-smoke-"));
const calls = [], navigation = [], voiceEvents = [];
let lifecycle, frame, displayed = "", session, speechToPlay = null, mediaState = 7, mediaConfig;
const mediaCalls = [];
const wave = Buffer.alloc(44 + 3200);
wave.write("RIFF"); wave.writeUInt32LE(wave.length-8,4);wave.write("WAVEfmt ",8);
wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);
wave.writeUInt32LE(16000,24);wave.writeUInt32LE(32000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write("data",36);wave.writeUInt32LE(3200,40);
const widget = () => ({ setParent() {}, setIgnoreLayout() {}, setSize() {}, setText(value) { displayed = value; }, getLocalStyle: () => ({ setBackgroundColor() {}, setTextColor() {}, setTextFont() {}, setTextAlign() {} }) });
const publicOs = {
  AppLifecycle: { ON_CREATE: 0, ON_DESTROY: 1, ON_FOREGROUND: 2, ON_BACKGROUND: 3, ON_REOPEN: 4 },
  App: { createApp(callback) { lifecycle = callback; } },
  WindowProperty: { create: () => ({ setTitle() {}, setSize() {} }) },
  Window: { create: () => ({}) },
  setDisplayKeepAwake() {}, getBatteryStatus: () => ({ availability: "unknown" }),
  requestAnimationFrame(callback) { frame = callback; return 1; }, cancelAnimationFrame() {},
  RemoteMediaCommand: { STOP: 4 }, RemoteMediaCodec: { PCM_WAVE: 1 },
  RemoteMediaState: { STOPPED: 0, READY: 7, PLAYING: 8, COMPLETED: 10, FAILED: 11 },
  configureRemoteMedia(config) { mediaConfig=config;mediaCalls.push(config);return true; },
  commandRemoteMedia() { return true; }, readRemoteMediaSnapshot() { return { state: mediaState, failureCode:0 }; }, releaseRemoteMedia() {}
};
const publicInput = {
  requestWindowFocus() {}, takeNavigationAction: () => navigation.shift() || null, takeTextInput: () => null,
  getVoiceInputAvailability: () => ({ canRequest: true }),
  requestVoiceInput() {
    session = {
      takeEvent: () => voiceEvents.shift() || null,
      finish() { voiceEvents.push({ type: "end", status: "completed", reason: "none" }); },
      cancel() { voiceEvents.push({ type: "end", status: "cancelled", reason: "user-cancelled" }); }
    };
    return session;
  }
};
const context = {
  require(name) {
    if (name === "@irisview/osx/os") return publicOs;
    if (name === "@irisview/osx/os/input") return publicInput;
    if (name === "@irisview/osx/fusionui") return { Board: { create: widget }, Text: { create: widget }, Color: { fromRGB8() {} }, Font: { getCachedFont() {} }, TextAlign: { CENTER: 1 }, FusionRoot: { acquireFusionRootFromWindow: () => ({ getRootWidget: () => ({}) }) } };
    if (name === "./application-data") return { applicationDataDirectory: () => directory };
    if (name === "./local-lite") return require(path.join(project, "iris-app/src/local-lite"));
    if (name === "./speech-playback") return require(path.join(project, "iris-app/src/speech-playback"));
    return require(name);
  },
  process: { env: {} }, console, Buffer, AbortSignal, setInterval: () => 1, clearInterval() {},
  async fetch(url, options) {
    calls.push({ url, ...options });
    return { ok: true, headers: new Map([["content-length", String(wave.length)]]), async arrayBuffer() { return wave.buffer.slice(wave.byteOffset,wave.byteOffset+wave.byteLength); }, async json() { return url.endsWith("/api/state") ? { phase: "idle", modeRequested: "lite", hudLines: ["LITE", "今日记录", "确认开始"], speech:speechToPlay } : url.endsWith("/api/voice") ? { id: "test-voice", status: "saved" } : { ok: true }; } };
  }
};
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

(async () => {
  try {
    vm.runInNewContext(fs.readFileSync(path.join(project, "iris-app/src/index.js"), "utf8"), context);
    lifecycle(0); await flush();
    assert.equal(displayed, "LITE\n今日记录\n确认开始");
    navigation.push("activate"); frame(16); await flush();
    assert(calls.some(call => call.url.endsWith("/api/action") && JSON.parse(call.body).action === "start"));
    navigation.push("right"); frame(32);
    assert(session, "Explicit right action requests audio");
    voiceEvents.push({ type: "state", state: "recording" }, { type: "audio", sequence: 0, sampleOffset: 0, sampleCount: 320, data: new Uint8Array(640) });
    frame(48);
    assert.equal(fs.readdirSync(path.join(directory, "voice")).length, 1);
    navigation.push("right"); frame(64); frame(80); await flush();
    const upload = calls.find(call => call.url.endsWith("/api/voice"));
    assert.equal(upload.body.length, 640);
    assert.equal(upload.headers["X-Audio-Sample-Rate"], "16000");
    assert.equal(fs.readdirSync(path.join(directory, "voice")).length, 0, "Local duplicate removed only after save acknowledgement");
    assert.equal(calls.filter(call => call.url.endsWith("/api/action") && JSON.parse(call.body).action === "checkin").length, 0, "Voice endpoint owns check-in creation; no duplicate action");
    const {parseWave}=require(path.join(project,"iris-app/src/speech-playback"));
    assert.equal(parseWave(wave).durationUs,100000);
    assert.throws(()=>parseWave(wave.subarray(0,100)),/Truncated/);
    speechToPlay={id:"12345678-1234-1234-1234-123456789abc",url:"/speech/12345678-1234-1234-1234-123456789abc.wav",target:"iris",status:"ready",createdAt:Date.now()};
    await context.poll(); await flush();
    assert.equal(mediaConfig.sourceSampleRate,16000);assert.equal(mediaConfig.channels,1);assert.equal(mediaConfig.codec,1);
    assert.equal(mediaConfig.durationUs,100000);assert(fs.existsSync(mediaConfig.absolutePath));
    assert.equal(calls.filter(call=>call.url.endsWith('/api/speech/ack')).length,0,"Admission does not mean audible playback");
    mediaState=8;frame(100);await flush();
    assert(calls.some(call=>call.url.endsWith('/api/speech/ack')&&JSON.parse(call.body).status==='started'));
    await context.poll();await flush();assert.equal(mediaCalls.length,1,"Same speech request cannot replay");
    mediaState=10;frame(120);await flush();
    assert(calls.some(call=>call.url.endsWith('/api/speech/ack')&&JSON.parse(call.body).status==='completed'));
    lifecycle(1);
    console.log("Iris adapter public-API smoke PASS: HUD, navigation, PCM drain/upload, local WAV playback, native state acknowledgement, no duplicate replay.");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
