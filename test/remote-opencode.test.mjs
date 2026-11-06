import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {OpenCodeAdapter} from '../core/remote/opencode.mjs';
import {RemoteStore} from '../core/remote/store.mjs';

const sessionId = 'ses_test', cwd = '/workspace/project';
const command = (action, payload = {}, extras = {}) => ({id: 'cmd-original', action, sessionId, payload, ...extras});
const permission = version => ({id: 'per_test', sessionID: sessionId,
  ...(version === 'v1' ? {permission: 'bash', patterns: ['git status'], always: ['git *'], metadata: {}} : {action: 'bash', resources: ['git status']})});
const question = () => ({id: 'que_test', sessionID: sessionId, questions: [{question: '选择分支', header: '分支', options: [{label: 'main', description: '主分支'}], custom: true}]});
const form = fields => ({id: 'frm_test', sessionID: sessionId, title: '选择分支', fields: fields ?? [{key: 'branch', type: 'string', required: true}]});

async function fixture(t, version = 'v1', adapterOptions = {}) {
  const state = {session: {id: sessionId, title: '当前任务', time: {created: 1, updated: 2},
    ...(version === 'v1' ? {directory: cwd} : {location: {directory: cwd}})},
  states: {[sessionId]: {type: version === 'v1' ? 'busy' : 'running'}}, permissions: [], questions: [], posts: [], requests: [], postStatus: null, postBody: undefined};
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost'), chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    state.requests.push({method: request.method, path: url.pathname, directory: url.searchParams.get('directory'), auth: request.headers.authorization, resume: url.searchParams.get('resume'), body});
    const reply = (status, data) => { response.writeHead(status, {'Content-Type': 'application/json'}); response.end(data === undefined ? undefined : JSON.stringify(data)); };
    if (state.failGet && request.method === 'GET') return reply(state.failGet, {error: 'unavailable'});
    if (request.method === 'POST') {
      state.posts.push(state.requests.at(-1));
      if (state.disconnect) return request.socket.destroy();
      if (state.postStatus) return reply(state.postStatus, state.postBody);
      if (url.pathname.endsWith('/abort')) return reply(200, true);
      if (url.pathname.endsWith('/interrupt')) return reply(200, {interrupted: true});
      if (url.pathname.endsWith('/prompt')) return reply(200, {data: {id: 'inb_test', type: 'user'}});
      if (url.pathname.endsWith('/prompt_async') || version === 'v2') return reply(204);
      return reply(200, true);
    }
    const base = version === 'v2' ? `/api/session/${sessionId}` : `/session/${sessionId}`;
    let data;
    if (url.pathname === base) data = state.session;
    else if (url.pathname === (version === 'v2' ? '/api/session/active' : '/session/status')) data = state.states;
    else if (url.pathname === (version === 'v2' ? `${base}/permission` : '/permission')) data = state.permissions;
    else if (url.pathname === (version === 'v2' ? `${base}/form` : '/question')) data = state.questions;
    else return reply(404, {});
    reply(200, version === 'v2' ? {data} : data);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return {state, endpoint, adapter: new OpenCodeAdapter({endpoint, apiVersion: version, cwd, sessionId, ...adapterOptions})};
}

test('configuration rejects omitted protocol, non-loopback and credential-bearing endpoints', () => {
  const base = {endpoint: 'http://127.0.0.1:4096', apiVersion: 'v1', cwd, sessionId};
  for (const endpoint of ['http://example.com:4096', 'http://0.0.0.0:4096', 'http://user:pass@127.0.0.1:4096', 'http://127.0.0.1:4096/api', 'http://127.0.0.1:4096/?token=x', 'file:///tmp/opencode']) assert.throws(() => new OpenCodeAdapter({...base, endpoint}), {code: 'invalid_endpoint'});
  assert.throws(() => new OpenCodeAdapter({...base, apiVersion: undefined}), {code: 'invalid_api_version'});
  assert.throws(() => new OpenCodeAdapter({...base, cwd: 'relative'}), {code: 'invalid_cwd'});
  assert.doesNotThrow(() => new OpenCodeAdapter({...base, endpoint: 'http://[::1]:4096'}));
});

for (const version of ['v1', 'v2']) {
  test(`${version}: observes native status, explicit idle and acceptance separately`, async t => {
    const {adapter, state} = await fixture(t, version);
    const running = await adapter.read();
    assert.equal(running.status, 'running'); assert.equal(running.acceptance, 'unreviewed');
    assert.equal(running.capture, 'snapshot_diff'); assert.equal(running.capabilities.resume, false);
    state.states = {}; state.session.outcome = 'succeeded';
    const idle = await adapter.read();
    assert.equal(idle.status, 'idle'); assert.equal(idle.acceptance, 'unreviewed'); assert.equal(idle.capabilities.resume, true);
    if (version === 'v1') assert.ok(state.requests.every(request => request.directory === cwd));
    else assert.ok(state.requests.every(request => request.directory === null));
  });

  test(`${version}: permission reply binds exact session and current request and allows only once/reject`, async t => {
    const {adapter, state} = await fixture(t, version); state.permissions = [permission(version)];
    const task = await adapter.read();
    assert.equal(task.status, 'blocked'); assert.equal(task.questions[0].kind, 'approval');
    await assert.rejects(adapter.execute(command('answer', {decision: 'always'}, {questionId: 'per_test'}), task), {code: 'invalid_decision'});
    await assert.rejects(adapter.execute(command('answer', {decision: 'once'}, {sessionId: 'ses_other', questionId: 'per_test'}), task), {code: 'scope_mismatch'});
    const receipt = await adapter.execute(command('answer', {decision: 'once'}, {questionId: 'per_test'}), task);
    assert.equal(receipt.status, version === 'v1' ? 'accepted' : 'answered'); assert.equal(receipt.readState, 'read_unconfirmed');
    if (version === 'v1') assert.equal(receipt.nativeAcknowledgement, 'http_only');
    assert.deepEqual(state.posts[0].body, version === 'v1' ? {reply: 'once'} : {decision: 'once'});
    assert.equal(state.posts[0].path, version === 'v1' ? '/permission/per_test/reply' : `/api/session/${sessionId}/permission/per_test/reply`);
    state.permissions = [];
    await assert.rejects(adapter.execute(command('answer', {decision: 'reject'}, {questionId: 'per_test'}), task), {code: 'question_changed'});
    assert.equal(state.posts.length, 1);
  });

  test(`${version}: changed permission contents under the same ID are not silently approved`, async t => {
    const {adapter, state} = await fixture(t, version); state.permissions = [permission(version)];
    const task = await adapter.read();
    state.permissions[0][version === 'v1' ? 'patterns' : 'resources'] = ['rm data'];
    await assert.rejects(adapter.execute(command('answer', {decision: 'once'}, {questionId: 'per_test'}), task), {code: 'question_changed'});
    assert.equal(state.posts.length, 0);
  });

  test(`${version}: resume rechecks idle and submits only explicit input to the original session`, async t => {
    const {adapter, state} = await fixture(t, version); state.states = {};
    const task = await adapter.read();
    await assert.rejects(adapter.execute(command('resume'), task), {code: 'invalid_input'});
    assert.equal((await adapter.execute(command('resume', {input: '继续验证测试'}), task)).status, 'accepted');
    assert.deepEqual(state.posts[0].body, version === 'v1' ? {parts: [{type: 'text', text: '继续验证测试'}]} : {text: '继续验证测试', resume: true});
    assert.equal(state.posts[0].path, version === 'v1' ? `/session/${sessionId}/prompt_async` : `/api/session/${sessionId}/prompt`);
    state.states = {[sessionId]: {type: version === 'v1' ? 'busy' : 'running'}};
    await assert.rejects(adapter.execute(command('resume', {input: '继续'}), task), {code: 'session_not_idle'});
    assert.equal(state.posts.length, 1);
  });

  test(`${version}: interrupt has no implicit resume and requires current native activity`, async t => {
    const {adapter, state} = await fixture(t, version); const task = await adapter.read();
    const receipt = await adapter.execute(command('interrupt'), task);
    assert.equal(receipt.status, 'interrupted');
    assert.equal(state.posts[0].path, `${version === 'v2' ? '/api' : ''}/session/${sessionId}/${version === 'v2' ? 'interrupt' : 'abort'}`);
    assert.equal(state.posts[0].resume, version === 'v2' ? 'false' : null); assert.equal(state.posts[0].body, undefined);
    state.states = {};
    await assert.rejects(adapter.execute(command('interrupt'), task), {code: 'session_not_active'});
  });

  test(`${version}: cwd drift or unreachable native service blocks all mutations`, async t => {
    const {adapter, state} = await fixture(t, version); const task = await adapter.read();
    if (version === 'v1') state.session.directory = '/other'; else state.session.location.directory = '/other';
    await assert.rejects(adapter.execute(command('interrupt'), task), {code: 'scope_mismatch'});
    state.failGet = 503;
    await assert.rejects(adapter.read(), {code: 'opencode_http_error'});
    await assert.rejects(adapter.execute(command('interrupt'), task), {code: 'opencode_http_error'});
    assert.equal(state.posts.length, 0);
  });
}

test('V1 answers actual ordered question arrays and ignores other sessions', async t => {
  const {adapter, state} = await fixture(t); state.questions = [question(), {...question(), id: 'que_other', sessionID: 'ses_other'}];
  const task = await adapter.read(); assert.equal(task.questions.length, 1); assert.equal(task.status, 'waiting_input');
  await adapter.execute(command('answer', {answer: 'release'}, {questionId: 'que_test'}), task);
  assert.deepEqual(state.posts[0].body, {answers: [['release']]}); assert.equal(state.posts[0].path, '/question/que_test/reply');
  state.questions[0].questions.push({question: '选择检查', header: '检查', multiple: true, custom: false, options: [{label: 'lint'}, {label: 'test'}]});
  const multi = await adapter.read();
  await assert.rejects(adapter.execute(command('answer', {answer: 'main'}, {questionId: 'que_test'}), multi), {code: 'invalid_answer'});
  await adapter.execute(command('answer', {answers: [['main'], ['lint', 'test']]}, {questionId: 'que_test'}), multi);
  assert.deepEqual(state.posts[1].body, {answers: [['main'], ['lint', 'test']]});
  await assert.rejects(adapter.execute(command('answer', {answers: [['main'], ['invalid']]}, {questionId: 'que_test'}), multi), {code: 'invalid_answer'});
});

test('V1 pending permissions retained after abort cannot revive idle execution', async t => {
  const {adapter, state} = await fixture(t); state.permissions = [permission('v1')];
  const task = await adapter.read(); state.states = {};
  const fresh = await adapter.read(); assert.equal(fresh.capabilities.answer, false); assert.equal(fresh.capabilities.resume, false);
  await assert.rejects(adapter.execute(command('answer', {decision: 'once'}, {questionId: 'per_test'}), task), {code: 'unsupported_question'});
  assert.equal(state.posts.length, 0);
});

test('V2 answers string and multiselect form fields using native field keys and option values', async t => {
  const {adapter, state} = await fixture(t, 'v2'); state.questions = [form()];
  await adapter.execute(command('answer', {answer: 'main'}, {questionId: 'frm_test'}), await adapter.read());
  assert.deepEqual(state.posts[0].body, {answer: {branch: 'main'}});
  state.questions = [form([{key: 'checks', type: 'multiselect', required: true, minItems: 1, options: [{value: 'unit', label: '单元测试'}]}])];
  const task = await adapter.read();
  await assert.rejects(adapter.execute(command('answer', {answers: ['单元测试']}, {questionId: 'frm_test'}), task), {code: 'invalid_answer'});
  await adapter.execute(command('answer', {answers: ['unit']}, {questionId: 'frm_test'}), task);
  assert.deepEqual(state.posts[1].body, {answer: {checks: ['unit']}});
});

test('V2 complex, conditional and external forms are visible but not answerable', async t => {
  const {adapter, state} = await fixture(t, 'v2');
  for (const fields of [[{key: 'a', type: 'string'}, {key: 'b', type: 'string'}], [{key: 'a', type: 'string', when: [{key: 'b'}]}], [{key: 'url', type: 'external', url: 'https://example.com'}]]) {
    state.questions = [form(fields)]; const task = await adapter.read();
    assert.equal(task.status, 'waiting_input'); assert.equal(task.capabilities.answer, false); assert.equal(task.questions[0].answerSupported, false);
    await assert.rejects(adapter.execute(command('answer', {answer: 'anything'}, {questionId: 'frm_test'}), task), {code: 'unsupported_question'});
  }
  assert.equal(state.posts.length, 0);
});

test('V2 session-scoped lists may never answer a different session', async t => {
  const {adapter, state} = await fixture(t, 'v2'); state.questions = [{...form(), sessionID: 'ses_other'}];
  await assert.rejects(adapter.read(), {code: 'scope_mismatch'});
});

test('native Basic password is not returned or leaked through fetch errors', async t => {
  const secret = 'password-with-quote"and-slash\\';
  const {adapter, state} = await fixture(t, 'v1', {token: secret});
  state.session.title = `title ${secret}`;
  assert.ok(!JSON.stringify(await adapter.read()).includes(secret));
  assert.equal(state.requests[0].auth, `Basic ${Buffer.from(`opencode:${secret}`).toString('base64')}`);
  const failing = new OpenCodeAdapter({endpoint: 'http://localhost:4096', apiVersion: 'v1', cwd, sessionId, token: secret, fetchImpl: () => {throw new Error(secret);}});
  await assert.rejects(failing.read(), error => error.code === 'opencode_unavailable' && !error.message.includes(secret));
});

test('timeouts include non-cooperating injected clients and read errors never fabricate a fresh unknown task', async () => {
  const adapter = new OpenCodeAdapter({endpoint: 'http://localhost:4096', apiVersion: 'v1', cwd, sessionId, timeoutMs: 10, fetchImpl: () => new Promise(() => {})});
  await assert.rejects(adapter.read(), {code: 'opencode_timeout'});
});

test('uncertain native effects return unknown; ledger duplicate IDs do not re-dispatch', async t => {
  const {adapter, state} = await fixture(t); state.states = {}; state.disconnect = true;
  const task = await adapter.read();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-oc-ledger-'));
  const store = new RemoteStore({dataDir});
  t.after(() => {store.close(); fs.rmSync(dataDir, {recursive: true, force: true});});
  const input = command('resume', {input: '继续'});
  const first = store.beginCommand(input, 'client-one'); assert.equal(first.replayed, false);
  store.updateCommand(input.id, {status: 'dispatching'});
  const receipt = await adapter.execute(input, task); assert.equal(receipt.status, 'unknown');
  store.updateCommand(input.id, receipt);
  const duplicate = store.beginCommand(input, 'client-one');
  assert.equal(duplicate.replayed, true); assert.equal(duplicate.status, 'unknown');
  assert.equal(state.posts.length, 1);
});

test('native HTTP rejection is definitive while malformed success and server failure are unknown', async t => {
  const {adapter, state} = await fixture(t); const task = await adapter.read();
  state.postStatus = 409; state.postBody = {error: 'expired'};
  await assert.rejects(adapter.execute(command('interrupt'), task), {code: 'opencode_http_error', outcome: 'rejected'});
  state.postStatus = 200; state.postBody = {};
  assert.equal((await adapter.execute(command('interrupt'), task)).status, 'unknown');
  state.postStatus = 503;
  assert.equal((await adapter.execute(command('interrupt'), task)).status, 'unknown');
});

test('mutating timeout is unknown and is sent exactly once without automatic retry', async t => {
  const {endpoint, state} = await fixture(t); state.states = {};
  let postCalls = 0;
  const adapter = new OpenCodeAdapter({endpoint, apiVersion: 'v1', cwd, sessionId, timeoutMs: 30,
    fetchImpl: (url, options) => { if (options.method === 'POST') {postCalls++; return new Promise(() => {});} return fetch(url, options); }});
  const receipt = await adapter.execute(command('resume', {input: '继续'}), await adapter.read());
  assert.equal(receipt.status, 'unknown'); assert.equal(receipt.error.code, 'opencode_timeout'); assert.equal(postCalls, 1);
});

test('protocol errors never trigger implicit V1/V2 fallback', async t => {
  const {adapter, state} = await fixture(t, 'v2'); state.failGet = 404;
  await assert.rejects(adapter.read(), {code: 'opencode_http_error'});
  assert.ok(state.requests.every(request => request.path.startsWith('/api/')));
  state.failGet = null; state.states = {[sessionId]: {type: 'busy'}};
  await assert.rejects(adapter.read(), {code: 'invalid_response'});
});

test('V2 idle race during interrupt reports the native no-op accurately', async t => {
  const {adapter, state} = await fixture(t, 'v2'); const task = await adapter.read();
  state.postStatus = 200; state.postBody = {interrupted: false};
  const receipt = await adapter.execute(command('interrupt'), task);
  assert.equal(receipt.status, 'accepted'); assert.equal(receipt.interrupted, false);
});
