"use strict";

const fs = require("node:fs");
const path = require("node:path");

// A small standalone timer for a kit-only launch. The companion remains the
// authority for Flow/Vision and daily aggregation; these offline sessions have
// their own provenance and are never silently merged with live sessions.
class LocalLite {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, "standalone-state.json");
    this.data = { active: false, phase: "idle", remainingSec: 1500, focusSec: 0, distractions: 0, checkins: 0 };
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (saved.active && Number.isFinite(saved.remainingSec)) {
        this.data = { ...saved, phase: "paused", resumePhase: saved.phase === "break" ? "break" : saved.resumePhase || "focus" };
      }
    } catch {}
    this.lastFrame = null;
    this.savedAt = 0;
  }

  save() {
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  action(action) {
    const data = this.data;
    if (action === "start") {
      Object.assign(data, { active: true, phase: "focus", remainingSec: 1500, focusSec: 0, distractions: 0, checkins: 0, startedAt: new Date().toISOString() });
    } else if (action === "pause" && ["focus", "break"].includes(data.phase)) {
      data.resumePhase = data.phase; data.phase = "paused";
    } else if (action === "resume" && data.phase === "paused") data.phase = data.resumePhase || "focus";
    else if (action === "distraction" && data.active) data.distractions += 1;
    else if (action === "checkin" && data.active) data.checkins += 1;
    else if (action === "finish" && data.active) {
      const record = { ...data, source: "iris-standalone", endedAt: new Date().toISOString() };
      fs.appendFileSync(path.join(this.directory, "standalone-sessions.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
      data.active = false; data.phase = "finished";
      this.save();
      return record;
    }
    this.save();
    return null;
  }

  tick(timestamp) {
    const elapsed = this.lastFrame === null ? 0 : Math.max(0, timestamp - this.lastFrame) / 1000;
    this.lastFrame = timestamp;
    if (!this.data.active || !["focus", "break"].includes(this.data.phase)) return;
    const counted = Math.min(elapsed, this.data.remainingSec);
    if (this.data.phase === "focus") this.data.focusSec += counted;
    this.data.remainingSec -= counted;
    if (this.data.remainingSec <= 0) {
      if (this.data.phase === "focus") { this.data.phase = "break"; this.data.remainingSec = 300; }
      else this.action("finish");
    }
    if (timestamp - this.savedAt > 5000) { this.save(); this.savedAt = timestamp; }
  }

  snapshot() {
    const remaining = Math.ceil(this.data.remainingSec);
    const clock = `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
    const phases = { idle: "确认开始", focus: "专注", break: "休息", paused: "已暂停", finished: "已保存" };
    return {
      modeRequested: "lite", modeEffective: "lite", phase: this.data.phase,
      remainingSec: remaining,
      hudLines: ["LITE · 眼镜本机记录", `${phases[this.data.phase]} ${clock}`, `分心 ${this.data.distractions} · 打卡 ${this.data.checkins}`]
    };
  }
}

module.exports = { LocalLite };
