import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {RemoteStore} from '../core/remote/store.mjs';

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-remote-store-'));
  const stores = [];
  let now = 1700000000000;
  const open = () => { const store = new RemoteStore({dataDir, now: () => now, ...options}); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); fs.rmSync(dataDir, {recursive: true, force: true}); });
  return {store: open(), open, dataDir, advance: ms => now += ms};
}

const task = extra => ({id: 'task-1', adapter: 'swa', provider: 'pi', title: '检查接口', projectId: 'project-1', status: 'running', acceptance: 'unreviewed', questions: [], capabilities: {answer: true, resume: true}, ...extra});

test('task snapshots persist and duplicate polls do not invent revisions or events', t => {
  const {store, open, advance} = fixture(t);
  const identity = store.identity();
  const original = store.upsertTask(task(), {capture: 'snapshot_diff'});
  advance(2000);
  const again = store.upsertTask(task(), {capture: 'snapshot_diff'});
  assert.equal(again.revision, original.revision);
  assert.equal(again.lastObservedAt, original.lastObservedAt + 2000);
  assert.equal(store.events().events.length, 1);
  store.close();
  const reopened = open();
  assert.deepEqual(reopened.identity(), identity);
  assert.equal(reopened.getTask('task-1').status, 'running');
  assert.equal(reopened.events().events[0].capture, 'snapshot_diff');
  const next = reopened.upsertTask(task({status: 'waiting_input', questions: [{id: 'q-1', text: '使用哪个分支？', kind: 'question'}]}));
  assert.equal(next.revision, 2);
  assert.equal(reopened.events({after: 1}).events.length, 1);
});

test('freshness and explicit disconnect preserve last task facts, and late samples cannot rewind them', t => {
  const {store, advance} = fixture(t);
  const original = store.upsertTask(task());
  advance(16000);
  assert.equal(store.getTask('task-1').freshness, 'stale');
  advance(30000);
  assert.equal(store.getTask('task-1').freshness, 'offline');
  const disconnected = store.markTaskUnavailable('task-1', '连接失败');
  assert.equal(disconnected.status, 'running');
  assert.equal(disconnected.lastObservedAt, original.lastObservedAt);
  const recovered = store.upsertTask(task());
  assert.equal(recovered.freshness, 'connected');
  assert.equal(recovered.revision, original.revision);
  store.upsertTask(task({status: 'failed', lastObservedAt: original.lastObservedAt}));
  assert.equal(store.getTask('task-1').status, 'running');
  assert.equal(store.getTask('task-1').connectionError, undefined);
});

test('event cursors paginate without duplicates and signal retention gaps or epoch resets', t => {
  const {store, open} = fixture(t, {retention: 3});
  for (let i = 0; i < 4; i++) store.appendEvent('task.sample', {index: i});
  const page = store.events({after: 0, limit: 2});
  assert.equal(page.resetRequired, true);
  assert.deepEqual(page.events.map(item => item.seq), [2, 3]);
  const tail = store.events({after: page.nextCursor, epoch: page.streamEpoch});
  assert.equal(tail.resetRequired, false);
  assert.deepEqual(tail.events.map(item => item.seq), [4]);
  assert.equal(store.events({after: 4}).events.length, 0);
  assert.equal(store.events({after: 4, epoch: 'old-database'}).resetRequired, true);
  assert.equal(store.events({after: 999}).resetRequired, true);
  store.close();
  const reopened = open();
  assert.equal(reopened.appendEvent('task.next', {}).seq, 5);
  assert.equal(reopened.events({after: 4}).events[0].seq, 5);
});

test('pairing is single-use, expires, persists only credential hashes and supports revocation', t => {
  const {store, open, dataDir, advance} = fixture(t);
  const pairing = store.createPairing({label: '我的手机', scopes: ['answer'], projectIds: ['project-1']});
  const {device, token} = store.claimPairing({code: pairing.code});
  assert.deepEqual(device.scopes, ['answer', 'read']);
  assert.deepEqual(device.projectIds, ['project-1']);
  assert.equal(store.authenticate(token).id, device.id);
  assert.throws(() => store.claimPairing({code: pairing.code}), {status: 401});
  const expiring = store.createPairing();
  advance(300001);
  assert.throws(() => store.claimPairing({code: expiring.code}), {status: 401});
  const publicJSON = JSON.stringify({devices: store.listDevices(), events: store.events()});
  assert.ok(!publicJSON.includes(token));
  assert.ok(!publicJSON.includes(pairing.code));
  store.close();
  const bytes = fs.readFileSync(path.join(dataDir, 'remote.sqlite'));
  assert.ok(!bytes.includes(Buffer.from(token)));
  assert.ok(!bytes.includes(Buffer.from(pairing.code)));
  const reopened = open();
  assert.equal(reopened.authenticate(token).id, device.id);
  reopened.revokeDevice(device.id);
  assert.equal(reopened.authenticate(token), null);
  assert.ok(reopened.listDevices()[0].revokedAt);
});

test('command idempotency binds original device and exact payload, including after restart', t => {
  const {store, open} = fixture(t);
  const command = {id: 'cmd-1', taskId: 'task-1', action: 'answer', payload: {text: '继续', questionId: 'q-1'}};
  assert.equal(store.beginCommand(command, 'phone-1').replayed, false);
  store.updateCommand('cmd-1', {status: 'dispatching', nativeRequestId: 'native-1'});
  const duplicate = store.beginCommand({...command, payload: {questionId: 'q-1', text: '继续'}}, 'phone-1');
  assert.equal(duplicate.replayed, true);
  assert.equal(duplicate.status, 'dispatching');
  assert.throws(() => store.beginCommand({...command, action: 'interrupt'}, 'phone-1'), {status: 409});
  assert.throws(() => store.beginCommand(command, 'phone-2'), {status: 409});
  store.close();
  const reopened = open();
  const restored = reopened.getCommand('cmd-1');
  assert.equal(restored.status, 'unknown');
  assert.equal(restored.nativeRequestId, 'native-1');
  assert.equal(reopened.beginCommand(command, 'phone-1').status, 'unknown');
  assert.equal(reopened.listCommands().length, 1);
});

test('stored events and public command receipts redact credential keys and reject malformed limits', t => {
  const {store} = fixture(t);
  const event = store.appendEvent('task.output', {token: 'secret-value', nested: {apiKey: 'provider-key'}, message: '普通文本'});
  assert.equal(event.payload.token, '[redacted]');
  assert.equal(event.payload.nested.apiKey, '[redacted]');
  store.beginCommand({id: 'cmd-2', taskId: 'task-1', token: 'never-store-this'}, 'phone-1');
  assert.ok(!JSON.stringify(store.getCommand('cmd-2')).includes('never-store-this'));
  assert.throws(() => store.events({after: -1}), {status: 400});
  assert.throws(() => store.createPairing({scopes: ['shell']}), {status: 400});
  assert.throws(() => store.upsertTask(task({status: 'made-up'})), {status: 400});
});

test('historical event project scope survives task reassignment and restart', t => {
  const {store, open} = fixture(t);
  store.upsertTask(task({projectId: 'private-project'}));
  store.upsertTask(task({projectId: 'other-project'}));
  assert.deepEqual(store.events().events.map(event => event.projectId), ['private-project', 'other-project']);
  store.close();
  const reopened = open();
  assert.equal(reopened.getTask('task-1').projectId, 'other-project');
  assert.equal(reopened.events().events[0].projectId, 'private-project');
});

test('migrated historical events keep unknown project attribution instead of inheriting a current project', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-remote-legacy-'));
  const legacy = new DatabaseSync(path.join(dataDir, 'remote.sqlite'));
  legacy.exec(`CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,task_id TEXT,capture TEXT NOT NULL,observed_at INTEGER NOT NULL,payload TEXT NOT NULL);
    INSERT INTO events(type,task_id,capture,observed_at,payload) VALUES ('task.updated','task-1','snapshot_diff',1,'{}');`);
  legacy.close();
  const store = new RemoteStore({dataDir});
  t.after(() => { store.close(); fs.rmSync(dataDir, {recursive: true, force: true}); });
  store.upsertTask(task({projectId: 'current-project'}));
  assert.equal(store.events().events[0].projectId, null);
  assert.equal(store.events().events[1].projectId, 'current-project');
});
