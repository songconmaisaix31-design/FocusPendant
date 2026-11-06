import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createService} from '../core/server.mjs';

const ownerToken = 'review-owner-token-at-least-sixteen';

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-controller-review-'));
  const definition = {id: 'job', adapter: 'test', projectId: 'project-a'};
  let snapshot = {id: 'job', adapter: 'test', provider: 'pi', title: '原任务', projectId: 'project-a', sessionId: 'session-1', status: 'waiting_input', acceptance: 'unreviewed', questions: [{id: 'question-1', kind: 'question', text: '使用哪个分支？'}], capabilities: {answer: true}, capture: 'snapshot_diff'};
  let delayNext = false, release, readCalls = 0, executes = 0;
  const adapter = {
    async read() {
      readCalls++;
      const captured = structuredClone(snapshot);
      if (delayNext) { delayNext = false; return new Promise(resolve => { release = () => resolve(captured); }); }
      return captured;
    },
    async execute() { executes++; snapshot = {...snapshot, status: 'completed', questions: []}; return {status: 'accepted', readState: 'read_observed'}; },
    async close() { release?.(); }
  };
  const service = createService({dataDir, token: ownerToken, remoteConfig: {targets: [definition], pollIntervalMs: 60000}, remoteOptions: {adapters: {job: adapter}}});
  await service.remoteReady;
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const call = async (route, body, token = ownerToken) => fetch(base + route, {method: body === undefined ? 'GET' : 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
  t.after(async () => { release?.(); service.server.closeAllConnections(); await new Promise(resolve => service.server.close(resolve)); fs.rmSync(dataDir, {recursive: true, force: true}); });
  return {service, call, definition, delayNext: () => { delayNext = true; }, release: () => release?.(), readCalls: () => readCalls, executes: () => executes};
}

test('an in-flight poll and a remote answer share the source read before executing the original task', async t => {
  const f = await fixture(t);
  const before = (await (await f.call('/api/remote/snapshot')).json()).tasks[0];
  let commandReadEntered;
  const entered = new Promise(resolve => { commandReadEntered = resolve; });
  const refresh = f.service.remote.refresh.bind(f.service.remote);
  f.service.remote.refresh = id => {
    const result = refresh(id);
    if (f.service.remote.locks.has(id)) commandReadEntered();
    return result;
  };
  f.delayNext();
  const background = f.service.remote.poll();
  const command = {id: randomUUID(), taskId: 'job', action: 'answer', expectedRevision: before.revision, sessionId: before.sessionId, questionId: 'question-1', expiresAt: Date.now() + 60000, payload: {text: 'main'}};
  const pending = f.call('/api/remote/commands', command);
  // Wait for the actual command validation read rather than relying on request timing.
  // It must share the already pending poll, so no third adapter read may start here.
  await entered;
  assert.equal(f.readCalls(), 2);
  f.release();
  assert.equal((await pending).status, 202);
  await background;
  await Promise.all([...f.service.remote.jobs]);
  const after = await (await f.call('/api/remote/snapshot')).json();
  assert.equal(after.tasks[0].status, 'completed');
  assert.equal(f.executes(), 1);
  assert.equal(f.readCalls(), 3); // Initial state, coalesced poll, post-command observation.
});

test('device-scoped event replay cannot expose a previous project after a task id is reassigned', async t => {
  const f = await fixture(t);
  const pairing = await (await f.call('/api/remote/admin/pairings', {label: '项目 B 手机', scopes: ['read'], projectIds: ['project-b']})).json();
  const claim = await (await f.call('/api/remote/pair', {code: pairing.code})).json();
  f.definition.projectId = 'project-b';
  await f.service.remote.refresh('job');
  const snapshot = await (await f.call('/api/remote/snapshot', undefined, claim.token)).json();
  assert.equal(snapshot.tasks[0].projectId, 'project-b');
  const events = await (await f.call('/api/remote/events?after=0', undefined, claim.token)).json();
  assert.ok(events.events.some(event => event.projectId === 'project-b'));
  assert.ok(events.events.every(event => event.projectId === 'project-b'));
  assert.ok(!events.events.some(event => event.payload.task?.projectId === 'project-a'));
  assert.equal(events.nextCursor, events.watermark); // Filtering still advances the server's global cursor.
  const owner = await (await f.call('/api/remote/events?after=0')).json();
  assert.ok(owner.events.some(event => event.projectId === 'project-a'));
});
