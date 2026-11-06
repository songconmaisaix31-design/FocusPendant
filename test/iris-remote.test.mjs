import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const project = fileURLToPath(new URL('../', import.meta.url));
const { RemoteTasks } = require('../iris-app/src/remote-tasks.js');
const task = (id = 'task-a', extra = {}) => ({
  id, title: `${id} 修复回调`, provider: 'codex', status: 'waiting_input', acceptance: 'accepted',
  questions: [{ id: `${id}-q`, text: '请选择目标分支', kind: 'question', dispatchId: `${id}-dispatch` }],
  capabilities: { answer: true }, lastObservedAt: 1800000000000, revision: 7,
  sessionId: `${id}-session`, dispatchId: `${id}-dispatch`, freshness: 'connected', ...extra
});
const snapshot = (tasks = [task()], scopes = ['read', 'answer']) => ({ tasks, permissions: { scopes }, serverTime: 1800000000000 });

function setup(t, initial = snapshot()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-remote-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = { directory, now: 1800000000000, snapshot: initial, calls: [], fail: false };
  fixture.remote = new RemoteTasks({ directory, now: () => fixture.now, uuid: () => '32f53c3c-1c2d-4f0b-b65e-d20617e55a38', request: async (route, body) => {
    fixture.calls.push({ route, body });
    if (fixture.fail) throw new Error('unreachable');
    return route.endsWith('/snapshot') ? fixture.snapshot : { status: 'queued' };
  } });
  return fixture;
}

test('remote HUD selects task and original question, and sends an explicitly bound answer', async t => {
  const b = task('task-b');
  b.questions.push({ id: 'b-second', text: '请输入验证命令', kind: 'question', dispatchId: b.dispatchId });
  const f = setup(t, snapshot([task(), b]));
  await f.remote.refresh();
  f.remote.navigation('right');
  f.remote.navigation('down');
  assert.equal(f.remote.task.id, 'task-b');
  assert.equal(f.remote.question.id, 'b-second');
  assert.match(f.remote.hudLines()[1], /问2\/2/);
  assert.match(f.remote.navigation('activate'), /手机回答/);
  assert.equal(f.calls.length, 1, 'Activation is read-only and never means approval');
  await f.remote.answer('npm test');
  assert.deepEqual(f.calls[1], { route: '/api/remote/commands', body: {
    id: '32f53c3c-1c2d-4f0b-b65e-d20617e55a38', taskId: 'task-b', action: 'answer',
    expectedRevision: 7, sessionId: b.sessionId, questionId: 'b-second', dispatchId: b.dispatchId,
    expiresAt: f.now + 60000, payload: { answer: 'npm test' }
  } });
  assert.equal(f.remote.task.status, 'waiting_input', 'Submission is not provider confirmation');
});

test('a snapshot expires at 15 seconds, and disconnected or stale source data cannot send', async t => {
  const f = setup(t);
  await f.remote.refresh();
  f.now += 15000;
  assert.equal(f.remote.connection(), 'stale');
  assert.match(f.remote.hudLines()[2], /过期.*最后确认/);
  await assert.rejects(f.remote.answer('main'), /过期/);
  assert.equal(f.calls.length, 1);
  f.now += 30000;
  assert.equal(f.remote.connection(), 'offline');
  f.snapshot.tasks[0].freshness = 'stale';
  await f.remote.refresh();
  await assert.rejects(f.remote.answer('main'), /过期/);
  f.fail = true;
  await assert.rejects(f.remote.refresh(), /unreachable/);
  assert.match(f.remote.hudLines()[2], /断连.*最后确认/);
  await assert.rejects(f.remote.answer('main'), /过期/);
  assert.equal(f.calls.filter(call => call.route.endsWith('/commands')).length, 0);
});

test('device scope, task capability, approval kind and continuation context all gate answers', async t => {
  for (const change of [
    { scopes: ['read'] },
    { task: { capabilities: { answer: false } } },
    { question: { kind: 'approval' } },
    { question: { continuationRequired: true } },
    { question: { dispatchId: 'older-dispatch' } },
    { task: { revision: null } }
  ]) {
    const item = task('task-a', change.task);
    Object.assign(item.questions[0], change.question);
    const f = setup(t, snapshot([item], change.scopes));
    await f.remote.refresh();
    await assert.rejects(f.remote.answer('yes'));
    assert.equal(f.calls.filter(call => call.route.endsWith('/commands')).length, 0);
  }
});

test('multi-worker run answers only the selected original dispatch with nullable run session', async t => {
  const item = task('multi', { sessionId: null, dispatchId: null, questions: [
    { id: 'worker-one-q', text: 'Worker one question', kind: 'question', dispatchId: 'worker-one' },
    { id: 'worker-two-q', text: 'Worker two question', kind: 'question', dispatchId: 'worker-two' }
  ] });
  const f = setup(t, snapshot([item]));
  await f.remote.refresh();
  f.remote.navigation('down');
  await f.remote.answer('answer for worker two');
  assert.equal(f.calls.at(-1).body.dispatchId, 'worker-two');
  assert.equal(f.calls.at(-1).body.sessionId, null);
  assert.equal(f.calls.at(-1).body.questionId, 'worker-two-q');
  await f.remote.refresh();
  await assert.rejects(f.remote.answer('repeat'), /等待主机确认/);
});

test('a definitive revision rejection permits an explicit retry only after a fresh snapshot', async t => {
  const f = setup(t);
  await f.remote.refresh();
  const request = f.remote.request;
  f.remote.request = async (route, body) => {
    if (route.endsWith('/commands')) { f.calls.push({ route, body }); const error = new Error('revision changed'); error.status = 409; throw error; }
    return request(route, body);
  };
  await assert.rejects(f.remote.answer('main'), /被拒绝/);
  await assert.rejects(f.remote.answer('main'), /过期/);
  f.remote.request = request;
  f.snapshot.tasks[0].revision++;
  await f.remote.refresh();
  assert.equal(f.calls.filter(call => call.route.endsWith('/commands')).length, 1, 'Refresh itself never retries');
  await f.remote.answer('main');
  assert.equal(f.calls.at(-1).body.expectedRevision, 8);
});

test('pending or ambiguous delivery is never automatically resent under a new ID', async t => {
  const f = setup(t);
  await f.remote.refresh();
  await f.remote.answer('main');
  f.snapshot.tasks[0].revision++;
  await f.remote.refresh();
  await assert.rejects(f.remote.answer('main'), /等待主机确认/);
  assert.equal(f.calls.filter(call => call.route.endsWith('/commands')).length, 1);
  f.snapshot.tasks[0].questions = [{ ...f.snapshot.tasks[0].questions[0], id: 'new-original-question' }];
  await f.remote.refresh();
  f.fail = true;
  await assert.rejects(f.remote.answer('answer-two'), /未确认/);
  f.fail = false;
  await f.remote.refresh();
  await assert.rejects(f.remote.answer('answer-two'), /等待主机确认/);
  assert.equal(f.calls.filter(call => call.route.endsWith('/commands')).length, 2);
});

test('cache contains only credential-free summaries and always restores offline and read-only', async t => {
  const item = task();
  item.apiKey = 'must-never-persist';
  item.questions[0].text = 'private question text must stay out of summary';
  const f = setup(t, { ...snapshot([item]), token: 'device-secret', permissions: { scopes: ['answer'], token: 'another-secret' } });
  await f.remote.refresh();
  const bytes = fs.readFileSync(path.join(f.directory, 'remote-task-summary.json'), 'utf8');
  assert.doesNotMatch(bytes, /must-never-persist|device-secret|another-secret|private question|questions|capabilities|sessionId|dispatchId|scopes/);
  const restored = new RemoteTasks({ directory: f.directory, request: () => { throw new Error('No request expected'); } });
  assert.equal(restored.task.title, item.title);
  assert.equal(restored.connection(), 'offline');
  assert.equal(restored.question, null);
  await assert.rejects(restored.answer('main'), /过期/);
  assert.match(restored.hudLines()[2], /断连.*最后确认/);
});

test('changing selected task during an in-flight answer cannot retarget that command', async t => {
  const f = setup(t, snapshot([task('a'), task('b')]));
  await f.remote.refresh();
  let complete;
  f.remote.request = (route, body) => { f.calls.push({ route, body }); return new Promise(resolve => { complete = resolve; }); };
  const result = f.remote.answer('main');
  f.remote.navigation('right');
  assert.equal(f.remote.task.id, 'b');
  assert.equal(f.calls.at(-1).body.taskId, 'a');
  await assert.rejects(f.remote.answer('dev'), /等待主机确认/);
  complete({ status: 'queued' });
  await result;
});

test('remote app mode uses paired token and never polls attention or turns navigation/text into audio or approval', async t => {
  const f = setup(t, snapshot([task()]));
  const calls = [], navigation = [], textQueue = [];
  let lifecycle, frame, displayed = '', fail = false;
  const widget = () => ({ setParent() {}, setIgnoreLayout() {}, setSize() {}, setText(value) { displayed = value; }, getLocalStyle: () => ({ setBackgroundColor() {}, setTextColor() {}, setTextFont() {}, setTextAlign() {} }) });
  const publicOs = {
    AppLifecycle: { ON_CREATE: 0, ON_DESTROY: 1, ON_FOREGROUND: 2, ON_BACKGROUND: 3, ON_REOPEN: 4 },
    App: { createApp(callback) { lifecycle = callback; } },
    WindowProperty: { create: () => ({ setTitle() {}, setSize() {} }) }, Window: { create: () => ({}) },
    setDisplayKeepAwake() {}, requestAnimationFrame(callback) { frame = callback; return 1; }, cancelAnimationFrame() {}
  };
  const context = {
    require(name) {
      if (name === '@irisview/osx/os') return publicOs;
      if (name === '@irisview/osx/os/input') return {
        requestWindowFocus() {}, takeNavigationAction: () => navigation.shift() || null,
        takeTextInput: () => textQueue.length ? { text: textQueue.shift() } : null,
        requestVoiceInput() { assert.fail('Remote navigation must not open microphone'); }
      };
      if (name === '@irisview/osx/fusionui') return { Board: { create: widget }, Text: { create: widget }, Color: { fromRGB8() {} }, Font: { getCachedFont() {} }, TextAlign: { CENTER: 1 }, FusionRoot: { acquireFusionRootFromWindow: () => ({ getRootWidget: () => ({}) }) } };
      if (name === './application-data') return { applicationDataDirectory: () => f.directory };
      if (name.startsWith('./')) return require(path.join(project, 'iris-app/src', name));
      return require(name);
    },
    process: { env: { FOCUS_REMOTE_TASKS: '1', FOCUS_DEVICE_TOKEN: 'paired-token', FOCUS_TOKEN: 'owner-token', FOCUS_SERVER_URL: 'https://example.invalid/' } },
    console: { log() {}, error() {} }, Buffer, AbortSignal, setInterval: () => 1, clearInterval() {},
    async fetch(url, options) {
      calls.push({ url, ...options });
      assert.match(url, /^https:\/\/example\.invalid\/api\/remote\//);
      assert.equal(options.headers.Authorization, 'Bearer paired-token');
      if (fail) throw new Error('offline');
      return { ok: true, json: async () => url.endsWith('/snapshot') ? { ...f.snapshot, serverTime: Date.now() } : { status: 'queued' } };
    }
  };
  const flush = async () => { for (let n = 0; n < 8; n++) await new Promise(resolve => setImmediate(resolve)); };
  vm.runInNewContext(fs.readFileSync(path.join(project, 'iris-app/src/index.js'), 'utf8'), context);
  lifecycle(0); await flush();
  assert.match(displayed, /task-a/);
  assert.match(displayed, /最后确认/);
  navigation.push('left', 'right', 'up', 'down', 'activate', 'back'); frame(16); await flush();
  textQueue.push('/read', '/stop', '同意所有任务'); frame(32); await flush();
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  textQueue.push('/answer main'); frame(48); await flush();
  assert.equal(calls.filter(call => call.url.endsWith('/commands')).length, 1);
  assert.equal(JSON.parse(calls.find(call => call.url.endsWith('/commands')).body).questionId, 'task-a-q');
  fail = true; await context.poll();
  textQueue.push('/answer another-answer'); frame(64); await flush();
  assert.equal(calls.filter(call => call.url.endsWith('/commands')).length, 1, 'Disconnected answers are not sent or queued');
  assert.match(displayed, /断连.*最后确认/);
  assert.equal(fs.existsSync(path.join(f.directory, 'standalone-state.json')), false);
  lifecycle(1);
});
