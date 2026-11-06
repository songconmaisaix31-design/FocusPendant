import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {SyncClient} from '../core/remote/sync-client.mjs';

async function listening(server, port = 0) { server.listen(port, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function stop(server) { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); }

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-sync-client-'));
  let clock = 1700000000000;
  const upstream = {epoch: 'stream-1', events: [], tasks: [{id: 'task-1', status: 'running', freshness: 'connected', lastObservedAt: clock}], minimum: 1, auth: true, snapshotHook: null, cursors: []};
  const token = 'device-token-this-must-not-be-persisted';
  const respond = (res, status, value) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(value)); };
  const sourceServer = http.createServer((req, res) => {
    if (!upstream.auth || req.headers.authorization !== `Bearer ${token}`) return respond(res, 401, {error: 'revoked'});
    const url = new URL(req.url, 'http://local');
    const watermark = upstream.events.at(-1)?.seq || 0;
    if (url.pathname === '/api/remote/snapshot') {
      const value = {device: {deviceId: 'workstation-1', streamEpoch: upstream.epoch}, tasks: structuredClone(upstream.tasks), watermark};
      if (upstream.snapshotHook) { const hook = upstream.snapshotHook; upstream.snapshotHook = null; hook(); }
      return respond(res, 200, value);
    }
    if (url.pathname === '/api/remote/events') {
      const after = Number(url.searchParams.get('after'));
      upstream.cursors.push(after);
      const resetRequired = url.searchParams.get('epoch') !== upstream.epoch || after < upstream.minimum - 1;
      const events = upstream.events.filter(event => event.seq > after && event.seq >= upstream.minimum).slice(0, 2);
      return respond(res, 200, {deviceId: 'workstation-1', streamEpoch: upstream.epoch, events, nextCursor: events.at(-1)?.seq ?? after, watermark, resetRequired});
    }
    respond(res, 404, {});
  });
  const sourcePort = await listening(sourceServer);
  let client = new SyncClient({url: `http://127.0.0.1:${sourcePort}`, token, dataDir, now: () => clock, timeoutMs: 300});
  const mirrorServer = http.createServer(async (req, res) => respond(res, 200, await client.pollOnce()));
  const mirrorPort = await listening(mirrorServer);
  t.after(async () => { client.close(); await Promise.all([stop(sourceServer), stop(mirrorServer)]); fs.rmSync(dataDir, {recursive: true, force: true}); });
  const append = (status, extra = {}) => {
    clock += 1000;
    upstream.tasks = [{...upstream.tasks[0], status, lastObservedAt: clock, ...extra}];
    const event = {seq: (upstream.events.at(-1)?.seq || 0) + 1, type: 'task.updated', taskId: 'task-1', capture: 'native_event', observedAt: clock, payload: {task: structuredClone(upstream.tasks[0])}};
    upstream.events.push(event);
  };
  return {
    dataDir, upstream, sourceServer, sourcePort, append, token,
    read: async () => (await fetch(`http://127.0.0.1:${mirrorPort}/mirror`)).json(),
    advance: ms => clock += ms,
    client: () => client,
    restartClient: () => { client.close(); client = new SyncClient({url: `http://127.0.0.1:${sourcePort}`, token, dataDir, now: () => clock, timeoutMs: 300}); return client; }
  };
}

test('two HTTP hosts preserve running tasks offline and reconnect from a persistent cursor without duplicate events', async t => {
  const f = await fixture(t);
  f.append('running');
  let snapshot = await f.read();
  assert.equal(snapshot.sync.status, 'connected');
  assert.equal(snapshot.sync.cursor, 1);
  assert.equal(snapshot.sync.historyFromPairing, true);
  assert.equal(f.client().getEvents().length, 0);
  f.append('waiting_input', {questions: [{id: 'q-1', text: '继续？'}]});
  snapshot = await f.read();
  assert.equal(snapshot.tasks[0].status, 'waiting_input');
  assert.deepEqual(f.client().getEvents().map(event => event.seq), [2]);
  const lastReceivedAt = snapshot.sync.lastReceivedAt;
  await stop(f.sourceServer);
  f.advance(120000);
  f.append('completed', {questions: []});
  snapshot = await f.read();
  assert.equal(snapshot.sync.status, 'offline');
  assert.equal(snapshot.sync.lastReceivedAt, lastReceivedAt);
  assert.equal(snapshot.tasks[0].status, 'waiting_input');
  assert.equal(snapshot.tasks[0].freshness, 'offline');
  assert.equal(f.upstream.tasks[0].status, 'completed');
  await listening(f.sourceServer, f.sourcePort);
  snapshot = await f.read();
  assert.equal(snapshot.tasks[0].status, 'completed');
  assert.equal(snapshot.sync.status, 'connected');
  assert.deepEqual(f.client().getEvents().map(event => event.seq), [2, 3]);
  await f.read();
  assert.deepEqual(f.client().getEvents().map(event => event.seq), [2, 3]);
  const reopened = f.restartClient();
  assert.equal(reopened.getSnapshot().sync.cursor, 3);
  assert.equal(reopened.getSnapshot().sync.status, 'offline');
  f.upstream.cursors.length = 0;
  await f.read();
  assert.deepEqual(f.upstream.cursors, [3]);
  const saved = fs.readFileSync(path.join(f.dataDir, 'remote-mirror.json'), 'utf8');
  assert.ok(!saved.includes(f.token));
  assert.equal(JSON.parse(saved).cursor, 3);
});

test('snapshot/event races consume every new event and same-content polls refresh heartbeat time', async t => {
  const f = await fixture(t);
  await f.read();
  f.upstream.snapshotHook = () => { f.append('waiting_input'); f.append('running'); f.append('completed'); };
  const snapshot = await f.read();
  assert.equal(snapshot.tasks[0].status, 'completed');
  assert.equal(snapshot.sync.cursor, 3);
  assert.deepEqual(f.client().getEvents().map(event => event.seq), [1, 2, 3]);
  f.advance(2000);
  f.upstream.tasks[0].lastObservedAt += 2000;
  const refreshed = await f.read();
  assert.equal(refreshed.tasks[0].lastObservedAt, snapshot.tasks[0].lastObservedAt + 2000);
  assert.equal(refreshed.sync.cursor, 3);
  assert.ok(refreshed.sync.lastReceivedAt > snapshot.sync.lastReceivedAt);
});

test('retention gaps and epoch changes reset history to a new explicit snapshot baseline', async t => {
  const f = await fixture(t);
  await f.read();
  f.append('running');
  await f.read();
  f.append('running');
  f.append('running');
  f.append('completed');
  f.upstream.minimum = 4;
  let snapshot = await f.read();
  assert.equal(snapshot.sync.historyGap, true);
  assert.equal(snapshot.sync.cursor, 4);
  assert.deepEqual(f.client().getEvents(), []);
  f.upstream.epoch = 'stream-2';
  f.upstream.events = [];
  f.upstream.minimum = 1;
  f.append('running');
  snapshot = await f.read();
  assert.equal(snapshot.sync.streamEpoch, 'stream-2');
  assert.equal(snapshot.sync.cursor, 1);
  assert.equal(snapshot.tasks[0].status, 'running');
  assert.deepEqual(f.client().getEvents(), []);
});

test('revoked devices receive an explicit auth error while keeping the last task outcome', async t => {
  const f = await fixture(t);
  f.append('completed');
  await f.read();
  f.upstream.auth = false;
  const snapshot = await f.read();
  assert.equal(snapshot.sync.status, 'auth_error');
  assert.equal(snapshot.sync.httpStatus, 401);
  assert.equal(snapshot.tasks[0].status, 'completed');
  assert.equal(snapshot.tasks[0].freshness, 'offline');
  assert.match(snapshot.sync.error, /令牌/);
});
