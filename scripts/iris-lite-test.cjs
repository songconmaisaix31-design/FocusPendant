"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { LocalLite } = require("../iris-app/src/local-lite");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iris-lite-test-"));
try {
  const lite = new LocalLite(directory);
  lite.action("start");
  lite.tick(1000); lite.tick(61000);
  assert.equal(lite.data.focusSec, 60);
  assert.equal(lite.snapshot().remainingSec, 1440);
  lite.action("pause"); lite.tick(121000);
  assert.equal(lite.data.focusSec, 60, "Paused intervals do not become focus time");
  lite.action("distraction"); lite.action("checkin");
  const restarted = new LocalLite(directory);
  assert.equal(restarted.data.phase, "paused", "Process restart requires explicit resume");
  restarted.action("resume"); restarted.tick(1); restarted.tick(10001);
  assert.equal(restarted.data.focusSec, 70);
  const session = restarted.action("finish");
  assert.equal(session.distractions, 1); assert.equal(session.checkins, 1);
  const recorded = JSON.parse(fs.readFileSync(path.join(directory, "standalone-sessions.jsonl"), "utf8"));
  assert.equal(recorded.focusSec, 70); assert.equal(recorded.source, "iris-standalone");

  const timed = new LocalLite(directory);
  timed.action("start"); timed.tick(10); timed.tick(1500010);
  assert.equal(timed.data.phase, "break");
  assert.equal(timed.data.focusSec, 1500);
  timed.tick(1800010);
  assert.equal(timed.data.phase, "finished");
  const records = fs.readFileSync(path.join(directory, "standalone-sessions.jsonl"), "utf8").trim().split("\n");
  assert.equal(records.length, 2);
  assert.equal(JSON.parse(records[1]).focusSec, 1500, "Rest time is excluded from focus total");
  console.log("Standalone Lite PASS: monotonic timer, pause, recovery, manual finish, 25/5 transition and durable journal.");
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
