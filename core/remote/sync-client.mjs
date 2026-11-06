import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const clone = value => JSON.parse(JSON.stringify(value));
const failure = (message, status) => Object.assign(new Error(message), status ? {status} : {});
const secretKey = /^(?:authorization|password|passwd|secret|credentials?|token|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i;

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw failure(`远端 ${name} 无效`);
  return value;
}

function identity(snapshot) {
  const device = snapshot?.device;
  if (!device || typeof device.deviceId !== 'string' || !device.deviceId || typeof device.streamEpoch !== 'string' || !device.streamEpoch) throw failure('远端快照缺少设备和事件流标识');
  integer(snapshot.watermark, 'watermark');
  if (!Array.isArray(snapshot.tasks)) throw failure('远端任务快照无效');
  return device;
}

/** Read-only companion mirror; command delivery remains on the authenticated host. */
export class SyncClient {
  constructor({url, token, dataDir, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 3000} = {}) {
    const address = new URL(url);
    if (address.username || address.password || address.search || address.hash || !['https:', 'http:'].includes(address.protocol)) throw failure('同步地址必须是无内嵌凭据的 HTTP(S) 地址');
    if (address.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)) throw failure('跨设备同步需要 HTTPS 地址');
    if (typeof token !== 'string' || !token || token.length > 1000) throw failure('同步需要设备令牌');
    if (!dataDir || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw failure('同步存储或超时配置无效');
    this.url = address.href.replace(/\/$/, '');
    this.token = token;
    this.fetch = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.file = path.join(path.resolve(dataDir), 'remote-mirror.json');
    fs.mkdirSync(path.dirname(this.file), {recursive: true, mode: 0o700});
    this.state = {schema: 'focus.remote-mirror.v1', origin: this.url, snapshot: null, events: [], streamEpoch: null, cursor: 0, lastReceivedAt: null, historyFromPairing: true, historyGap: false};
    if (fs.existsSync(this.file)) {
      let saved;
      try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { throw failure('镜像文件无法解析，请先备份并修复'); }
      if (saved.schema !== this.state.schema || saved.origin !== this.url || !Array.isArray(saved.events) || !Number.isSafeInteger(saved.cursor) || saved.cursor < 0) throw failure('镜像文件与当前远端不匹配');
      if (saved.snapshot) identity(saved.snapshot);
      this.state = saved;
    }
    // A cached snapshot is not proof that a new client process has a live connection.
    this.connection = {status: 'offline', error: this.state.snapshot ? '尚未连接；显示上次接收状态' : '尚未同步'};
    this.closed = false;
  }

  _safe(value) {
    if (typeof value === 'string') return value.replaceAll(this.token, '[redacted]');
    if (Array.isArray(value)) return value.map(item => this._safe(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? '[redacted]' : this._safe(item)]));
    return value;
  }

  _commit(next) {
    const safe = this._safe(next);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(safe)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try { fs.renameSync(temporary, this.file); }
    catch (cause) { try { fs.unlinkSync(temporary); } catch {} throw cause; }
    this.state = safe;
  }

  async _request(route) {
    const response = await this.fetch(this.url + route, {
      headers: {Authorization: `Bearer ${this.token}`, Accept: 'application/json'},
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), this.controller.signal])
    });
    if (response.status === 401 || response.status === 403) throw failure('设备令牌无效、已撤销或无权读取此项目', response.status);
    if (!response.ok) throw failure(`远端同步失败：HTTP ${response.status}`, response.status);
    if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024) throw failure('远端同步响应过大');
    const bytes = await response.text();
    if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw failure('远端同步响应过大');
    try { return JSON.parse(bytes); } catch { throw failure('远端返回了无效 JSON'); }
  }

  async _snapshot({forceReset = false, reason} = {}) {
    const snapshot = await this._request('/api/remote/snapshot');
    const device = identity(snapshot);
    const previous = this.state;
    const first = !previous.snapshot;
    const changed = !first && (device.streamEpoch !== previous.streamEpoch || device.deviceId !== previous.snapshot.device.deviceId);
    const rewind = !first && !changed && snapshot.watermark < previous.cursor;
    const reset = first || changed || rewind || forceReset;
    const next = {...previous, snapshot, lastReceivedAt: this.now()};
    if (reset) {
      next.events = [];
      next.streamEpoch = device.streamEpoch;
      // On pairing/reset, this is a new snapshot baseline, not an assertion of historical completeness.
      next.cursor = snapshot.watermark;
      next.historyStartedAt = this.now();
      next.historyGap = !first || previous.historyGap;
      next.gapReason = !first ? (reason || (changed ? '远端设备或事件流已重置' : rewind ? '远端事件游标已回退' : '远端事件历史已清理')) : undefined;
    }
    this._commit(next);
  }

  _page(page) {
    if (!page || !Array.isArray(page.events) || page.events.length > 1000) throw failure('远端事件分页无效');
    const nextCursor = integer(page.nextCursor, 'nextCursor');
    const watermark = integer(page.watermark, 'watermark');
    if (nextCursor < this.state.cursor || nextCursor > watermark) throw failure('远端事件游标倒退或越界');
    const bySequence = new Map(this.state.events.map(event => [event.seq, event]));
    const snapshot = clone(this.state.snapshot);
    for (const event of page.events) {
      integer(event.seq, '事件序号');
      if (!event.seq || event.seq > nextCursor) throw failure('远端事件序号越界');
      if (typeof event.type !== 'string') throw failure('远端事件类型无效');
      const prior = bySequence.get(event.seq);
      if (prior && JSON.stringify(prior) !== JSON.stringify(this._safe(event))) throw failure('同一事件序号返回了不同内容');
      if (event.seq > this.state.cursor) bySequence.set(event.seq, event);
      // The start-of-poll snapshot already contains events through its watermark.
      // Project only later task snapshots so a concurrent event cannot rewind that snapshot.
      const task = event.payload?.task;
      if (event.seq > snapshot.watermark && task && typeof task.id === 'string') {
        const index = snapshot.tasks.findIndex(item => item.id === task.id);
        if (index < 0) snapshot.tasks.push(task);
        else snapshot.tasks[index] = task;
      }
    }
    const events = [...bySequence.values()].sort((a, b) => a.seq - b.seq).slice(-5000);
    this._commit({...this.state, snapshot, events, cursor: nextCursor, lastReceivedAt: this.now()});
    return nextCursor < watermark;
  }

  async _poll() {
    this.controller = new AbortController();
    try {
      // Refresh even when no task change event was emitted: lastObservedAt is a heartbeat.
      await this._snapshot();
      let catchingUp = false;
      for (let count = 0; count < 10; count++) {
        const previousCursor = this.state.cursor;
        const page = await this._request(`/api/remote/events?after=${previousCursor}&epoch=${encodeURIComponent(this.state.streamEpoch)}&limit=200`);
        if (page?.resetRequired || page?.streamEpoch !== this.state.streamEpoch || (page.deviceId && page.deviceId !== this.state.snapshot.device.deviceId)) {
          await this._snapshot({forceReset: true, reason: '事件流变化或保留历史不足，已重新获取快照'});
          catchingUp = true;
          continue;
        }
        catchingUp = this._page(page);
        if (!catchingUp || this.state.cursor === previousCursor) break;
      }
      this.connection = {status: 'connected', catchingUp};
    } catch (cause) {
      this.connection = {status: [401, 403].includes(cause.status) ? 'auth_error' : 'offline', error: this._safe(cause.message || '远端连接失败'), ...(cause.status ? {httpStatus: cause.status} : {})};
    } finally { this.controller = null; }
    return this.getSnapshot();
  }

  pollOnce() {
    if (this.closed) return Promise.resolve(this.getSnapshot());
    if (!this.polling) this.polling = this._poll().finally(() => { this.polling = null; });
    return this.polling;
  }

  getSnapshot() {
    const snapshot = clone(this.state.snapshot || {device: null, tasks: [], watermark: 0});
    const isConnected = this.connection.status === 'connected';
    if (!isConnected) snapshot.tasks = snapshot.tasks.map(task => ({...task, freshness: 'offline'}));
    return {...snapshot, sync: {
      ...this.connection,
      streamEpoch: this.state.streamEpoch,
      cursor: this.state.cursor,
      lastReceivedAt: this.state.lastReceivedAt,
      historyFromPairing: this.state.historyFromPairing,
      historyGap: this.state.historyGap,
      ...(this.state.gapReason ? {gapReason: this.state.gapReason} : {})
    }};
  }

  getEvents() { return clone(this.state.events); }

  close() {
    this.closed = true;
    this.controller?.abort();
    this.connection = {status: 'offline', error: '同步客户端已停止'};
  }
}
