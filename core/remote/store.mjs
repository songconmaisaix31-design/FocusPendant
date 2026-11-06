import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const SCOPES = new Set(['read', 'answer', 'resume', 'interrupt', 'handoff']);
const PHASES = new Set(['running', 'active', 'waiting_input', 'blocked', 'completed', 'failed', 'unknown', 'interrupted', 'cancelled', 'idle']);
const COMMAND_STATES = new Set(['received', 'dispatching', 'executing', 'saved', 'consumed', 'completed', 'failed', 'rejected', 'unknown']);
const SECRET_KEY = /^(?:authorization|password|passwd|secret|secrets|credentials?|token|api[_-]?key|access[_-]?token|refresh[_-]?token|token[_-]?hash)$/i;
const error = (message, status = 400) => Object.assign(new Error(message), {status});
const hash = value => createHash('sha256').update(value).digest('hex');
const parse = value => JSON.parse(value);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function clone(value, max = 256 * 1024) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw error('数据必须可以编码为 JSON'); }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > max) throw error('数据为空或超过大小限制', 413);
  return parse(encoded);
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[redacted]' : redact(item)]));
  return value;
}

function text(value, name, max = 200, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw error(`${name} 无效`);
  return value;
}

function scopes(value = ['read']) {
  if (!Array.isArray(value) || !value.length || value.some(item => !SCOPES.has(item))) throw error('设备权限无效');
  return [...new Set(['read', ...value])].sort();
}

function projects(value = []) {
  if (!Array.isArray(value) || value.length > 100) throw error('项目范围无效');
  return [...new Set(value.map(item => text(item, 'projectId')))].sort();
}

/** Local authoritative event journal. Connection freshness never rewrites task outcome. */
export class RemoteStore {
  constructor({dataDir, now = Date.now, staleMs = 15000, offlineMs = 45000, retention = 10000} = {}) {
    if (!dataDir) throw error('RemoteStore 需要 dataDir');
    if (!(staleMs > 0 && offlineMs >= staleMs && Number.isSafeInteger(retention) && retention > 0)) throw error('事件存储配置无效');
    this.now = now;
    this.staleMs = staleMs;
    this.offlineMs = offlineMs;
    this.retention = retention;
    fs.mkdirSync(dataDir, {recursive: true, mode: 0o700});
    this.file = path.join(dataDir, 'remote.sqlite');
    this.db = new DatabaseSync(this.file);
    fs.chmodSync(this.file, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, fingerprint TEXT NOT NULL,
        revision INTEGER NOT NULL, last_observed_at INTEGER NOT NULL,
        unavailable_at INTEGER, error TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, task_id TEXT,
        project_id TEXT, capture TEXT NOT NULL, observed_at INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pairings (
        id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
        scopes TEXT NOT NULL, project_ids TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL, project_ids TEXT NOT NULL, created_at INTEGER NOT NULL,
        last_seen_at INTEGER, revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        input TEXT NOT NULL, receipt TEXT NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    // Historical scope is captured at ingestion. Old events have no trustworthy
    // project attribution and remain NULL for the API's fail-closed filter.
    if (!this.db.prepare('PRAGMA table_info(events)').all().some(column => column.name === 'project_id')) this.db.exec('ALTER TABLE events ADD COLUMN project_id TEXT');
    const put = this.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)');
    put.run('deviceId', randomUUID());
    put.run('streamEpoch', randomUUID());
    this._identity = Object.fromEntries(this.db.prepare('SELECT key,value FROM settings').all().map(row => [row.key, row.value]));
    this._transaction(() => {
      const inflight = this.db.prepare("SELECT * FROM commands WHERE status IN ('dispatching','executing')").all();
      for (const command of inflight) this._updateCommand(command, {status: 'unknown', error: '服务重启；须核对原请求回执，未自动重发'});
    });
  }

  _transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (cause) { this.db.exec('ROLLBACK'); throw cause; }
  }

  identity() { return {...this._identity}; }

  _event(type, payload, {taskId = null, capture = 'native_event'} = {}) {
    text(type, '事件类型', 100);
    if (taskId !== null) text(taskId, 'taskId');
    text(capture, '采集来源', 100);
    const safe = redact(clone(payload));
    const observedAt = this.now();
    const task = taskId ? this.db.prepare('SELECT payload FROM tasks WHERE id=?').get(taskId) : null;
    const projectId = task ? parse(task.payload).projectId ?? null : null;
    const inserted = this.db.prepare('INSERT INTO events(type,task_id,project_id,capture,observed_at,payload) VALUES (?,?,?,?,?,?)').run(type, taskId, projectId, capture, observedAt, JSON.stringify(safe));
    const seq = Number(inserted.lastInsertRowid);
    this.db.prepare('DELETE FROM events WHERE seq <= ?').run(seq - this.retention);
    return {seq, type, taskId, projectId, capture, observedAt, payload: safe};
  }

  appendEvent(type, payload, options = {}) {
    return this._transaction(() => this._event(type, payload, options));
  }

  _task(row) {
    if (!row) return null;
    const ageMs = Math.max(0, this.now() - row.last_observed_at);
    const freshness = row.unavailable_at !== null || ageMs >= this.offlineMs ? 'offline' : ageMs >= this.staleMs ? 'stale' : 'connected';
    return {...parse(row.payload), revision: row.revision, lastObservedAt: row.last_observed_at, freshness, ageMs, ...(row.error ? {connectionError: row.error} : {})};
  }

  getTask(id) { return this._task(this.db.prepare('SELECT * FROM tasks WHERE id=?').get(text(id, 'taskId'))); }

  listTasks() { return this.db.prepare('SELECT * FROM tasks ORDER BY last_observed_at DESC,id').all().map(row => this._task(row)); }

  upsertTask(input, {eventType = 'task.updated', capture = 'native_event'} = {}) {
    const task = redact(clone(input));
    text(task.id, 'taskId');
    text(task.adapter, 'adapter', 100);
    text(task.provider, 'provider', 100);
    text(task.title, '任务名称', 1000);
    if (!PHASES.has(task.status)) throw error('任务状态无效');
    if (task.questions !== undefined && (!Array.isArray(task.questions) || task.questions.length > 100)) throw error('待答问题无效');
    if (task.questions) for (const question of task.questions) {
      text(question.id, 'questionId');
      text(question.text, '问题内容', 16000);
      if (!['question', 'approval'].includes(question.kind)) throw error('问题类型无效');
    }
    const observedAt = task.lastObservedAt ?? this.now();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0 || observedAt > this.now() + 300000) throw error('采集时间无效');
    for (const key of ['lastObservedAt', 'revision', 'freshness', 'ageMs', 'connectionError']) delete task[key];
    task.capture = capture;
    const fingerprint = hash(JSON.stringify(canonical(task)));
    return this._transaction(() => {
      const previous = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id);
      if (previous && observedAt < previous.last_observed_at) return this._task(previous);
      const changed = !previous || previous.fingerprint !== fingerprint;
      const revision = changed ? (previous?.revision || 0) + 1 : previous.revision;
      this.db.prepare(`INSERT INTO tasks(id,payload,fingerprint,revision,last_observed_at) VALUES (?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,fingerprint=excluded.fingerprint,revision=excluded.revision,
        last_observed_at=excluded.last_observed_at,unavailable_at=NULL,error=NULL`).run(task.id, JSON.stringify(task), fingerprint, revision, observedAt);
      const current = this.getTask(task.id);
      if (changed) this._event(eventType, {task: current}, {taskId: task.id, capture});
      else if (previous.unavailable_at !== null) this._event('task.connected', {taskId: task.id, lastObservedAt: observedAt}, {taskId: task.id, capture});
      return current;
    });
  }

  markTaskUnavailable(id, message = '任务来源暂不可达') {
    text(id, 'taskId');
    const reason = String(message).slice(0, 1000);
    return this._transaction(() => {
      const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      if (!row) return null;
      const changed = row.unavailable_at === null || row.error !== reason;
      this.db.prepare('UPDATE tasks SET unavailable_at=COALESCE(unavailable_at,?),error=? WHERE id=?').run(this.now(), reason, id);
      if (changed) this._event('task.connection_lost', {taskId: id, error: reason, lastObservedAt: row.last_observed_at}, {taskId: id, capture: 'connection'});
      return this.getTask(id);
    });
  }

  events({after = 0, limit = 200, epoch} = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw error('事件游标或分页大小无效');
    const water = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get();
    const watermark = water?.seq || 0;
    const first = this.db.prepare('SELECT MIN(seq) AS seq FROM events').get().seq;
    const resetRequired = Boolean((epoch !== undefined && epoch !== this._identity.streamEpoch) || after > watermark || (first !== null && after < first - 1));
    const cursor = resetRequired ? Math.max(0, (first || 1) - 1) : after;
    const events = this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(cursor, limit).map(row => ({seq: row.seq, type: row.type, taskId: row.task_id, projectId: row.project_id, capture: row.capture, observedAt: row.observed_at, payload: parse(row.payload)}));
    return {...this.identity(), events, watermark, nextCursor: events.at(-1)?.seq ?? cursor, resetRequired};
  }

  createPairing({label = '远程设备', scopes: requestedScopes, projectIds} = {}) {
    text(label, '设备名称', 120);
    const allowedScopes = scopes(requestedScopes);
    const allowedProjects = projects(projectIds);
    const id = randomUUID(), code = randomBytes(24).toString('base64url'), expiresAt = this.now() + 300000;
    this._transaction(() => {
      this.db.prepare('DELETE FROM pairings WHERE expires_at<? OR consumed_at IS NOT NULL').run(this.now());
      this.db.prepare('INSERT INTO pairings(id,code_hash,label,scopes,project_ids,expires_at) VALUES (?,?,?,?,?,?)').run(id, hash(code), label, JSON.stringify(allowedScopes), JSON.stringify(allowedProjects), expiresAt);
    });
    return {id, code, label, scopes: allowedScopes, projectIds: allowedProjects, expiresAt};
  }

  claimPairing({code, label} = {}) {
    if (typeof code !== 'string' || code.length < 16 || code.length > 200) throw error('配对码无效或已过期', 401);
    if (label !== undefined) text(label, '设备名称', 120);
    return this._transaction(() => {
      const pairing = this.db.prepare('SELECT * FROM pairings WHERE code_hash=?').get(hash(code));
      if (!pairing || pairing.consumed_at !== null || pairing.expires_at <= this.now()) throw error('配对码无效或已过期', 401);
      const id = randomUUID(), token = randomBytes(32).toString('base64url'), createdAt = this.now();
      this.db.prepare('UPDATE pairings SET consumed_at=? WHERE id=?').run(createdAt, pairing.id);
      this.db.prepare('INSERT INTO devices(id,label,token_hash,scopes,project_ids,created_at) VALUES (?,?,?,?,?,?)').run(id, label || pairing.label, hash(token), pairing.scopes, pairing.project_ids, createdAt);
      const device = this._device(this.db.prepare('SELECT * FROM devices WHERE id=?').get(id));
      this._event('device.paired', {device}, {capture: 'local_control'});
      return {device, token};
    });
  }

  _device(row) {
    return row ? {id: row.id, label: row.label, scopes: parse(row.scopes), projectIds: parse(row.project_ids), createdAt: row.created_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at} : null;
  }

  authenticate(token) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 200) return null;
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash=? AND revoked_at IS NULL').get(hash(token));
    if (!row) return null;
    const lastSeenAt = this.now();
    this.db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(lastSeenAt, row.id);
    return {...this._device(row), lastSeenAt};
  }

  listDevices() { return this.db.prepare('SELECT * FROM devices ORDER BY created_at,id').all().map(row => this._device(row)); }

  revokeDevice(id) {
    text(id, 'deviceId');
    return this._transaction(() => {
      const row = this.db.prepare('SELECT * FROM devices WHERE id=?').get(id);
      if (!row) throw error('设备不存在', 404);
      if (row.revoked_at === null) {
        this.db.prepare('UPDATE devices SET revoked_at=? WHERE id=?').run(this.now(), id);
        this._event('device.revoked', {deviceId: id}, {capture: 'local_control'});
      }
      return this._device(this.db.prepare('SELECT * FROM devices WHERE id=?').get(id));
    });
  }

  _command(row) {
    return row ? {...parse(row.receipt), id: row.id, clientId: row.client_id, input: parse(row.input), status: row.status, createdAt: row.created_at, updatedAt: row.updated_at} : null;
  }

  beginCommand(input, clientId) {
    const payload = clone(input, 65536);
    const id = text(payload.id ?? payload.commandId, 'commandId');
    text(clientId, 'clientId');
    const fingerprint = hash(JSON.stringify(canonical(payload)));
    return this._transaction(() => {
      const previous = this.db.prepare('SELECT * FROM commands WHERE id=?').get(id);
      if (previous) {
        if (previous.client_id !== clientId || previous.fingerprint !== fingerprint) throw error('请求 ID 已用于不同内容或设备', 409);
        return {...this._command(previous), replayed: true};
      }
      const now = this.now(), safe = redact(payload);
      this.db.prepare('INSERT INTO commands(id,client_id,fingerprint,input,receipt,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id, clientId, fingerprint, JSON.stringify(safe), '{}', 'received', now, now);
      const command = this.getCommand(id);
      this._event('command.received', {command}, {taskId: typeof payload.taskId === 'string' ? payload.taskId : null, capture: 'local_control'});
      return {...command, replayed: false};
    });
  }

  _updateCommand(previous, patch) {
    const update = redact(clone(patch, 65536));
    if (update.status !== undefined && !COMMAND_STATES.has(update.status)) throw error('命令回执状态无效');
    for (const key of ['id', 'commandId', 'clientId', 'input', 'createdAt', 'updatedAt', 'replayed']) delete update[key];
    const receipt = {...parse(previous.receipt), ...update};
    const status = update.status || previous.status;
    this.db.prepare('UPDATE commands SET receipt=?,status=?,updated_at=? WHERE id=?').run(JSON.stringify(receipt), status, this.now(), previous.id);
    const command = this.getCommand(previous.id);
    this._event('command.updated', {command}, {taskId: typeof command.input.taskId === 'string' ? command.input.taskId : null, capture: 'local_control'});
    return command;
  }

  updateCommand(id, patch) {
    text(id, 'commandId');
    return this._transaction(() => {
      const previous = this.db.prepare('SELECT * FROM commands WHERE id=?').get(id);
      if (!previous) throw error('请求不存在', 404);
      return this._updateCommand(previous, patch);
    });
  }

  getCommand(id) { return this._command(this.db.prepare('SELECT * FROM commands WHERE id=?').get(text(id, 'commandId'))); }

  listCommands() { return this.db.prepare('SELECT * FROM commands ORDER BY created_at DESC,id LIMIT 500').all().map(row => this._command(row)); }

  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}
