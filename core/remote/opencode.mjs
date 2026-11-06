import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import path from 'node:path';

// Explicit protocol versions, not the similarly named @opencode-ai/sdk/v2 package.
// V1: anomalyco/opencode v1.1.35, server/routes/{session,permission,question}.ts,
// question/index.ts and session/status.ts; https://docs.opencode.ai/docs/server/.
// V2: https://opencode.ai/docs/openapi.json (checked 2026-11-06).
// Snapshot polling observes current facts, not an exhaustive native event history.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const MAX_RESPONSE = 4 * 1024 * 1024;

export class OpenCodeError extends Error {
  constructor(code, message, status = 502, outcome = 'rejected') {
    super(message); this.name = 'OpenCodeError'; this.code = code; this.status = status; this.outcome = outcome;
  }
}
const invalid = message => new OpenCodeError('invalid_response', message);

function endpointURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new OpenCodeError('invalid_endpoint', 'OpenCode endpoint 无效', 400); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || (isIP(host) === 4 && host.split('.')[0] === '127') || host === '::1';
  if (!['http:', 'https:'].includes(url.protocol) || !loopback || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new OpenCodeError('invalid_endpoint', 'OpenCode endpoint 必须是回环 HTTP(S) 根地址，不能附带凭证或路径', 400);
  }
  return url.origin;
}

function identity(value, name) {
  if (!nonempty(value) || value.length > 512 || /[\u0000-\u001f\u007f/\\?#]/.test(value)) throw new OpenCodeError('invalid_identity', `${name} 必须是明确的原始身份`, 400);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function formSupported(fields) {
  if (!Array.isArray(fields) || fields.length !== 1) return false;
  const field = fields[0];
  if (!object(field) || !nonempty(field.key) || !['string', 'multiselect'].includes(field.type) || field.hidden || field.when?.length || field.format || field.pattern) return false;
  const allowed = new Set(['key', 'type', 'title', 'description', 'required', 'hidden', 'when', 'minLength', 'maxLength', 'placeholder', 'default', 'options', 'custom', 'minItems', 'maxItems']);
  if (Object.keys(field).some(key => !allowed.has(key))) return false;
  if (['minLength', 'maxLength', 'minItems', 'maxItems'].some(key => field[key] !== undefined && (!Number.isSafeInteger(field[key]) || field[key] < 0))) return false;
  if (field.options !== undefined && (!Array.isArray(field.options) || field.options.some(item => !object(item) || typeof item.value !== 'string' || typeof item.label !== 'string') || new Set(field.options.map(item => item.value)).size !== field.options.length)) return false;
  return field.type !== 'multiselect' || Array.isArray(field.options);
}

function questionSupported(prompts) {
  return Array.isArray(prompts) && prompts.length > 0 && prompts.every(prompt => object(prompt) && nonempty(prompt.question) &&
    Array.isArray(prompt.options) && prompt.options.every(option => object(option) && typeof option.label === 'string') &&
    (prompt.multiple === undefined || typeof prompt.multiple === 'boolean') && (prompt.custom === undefined || typeof prompt.custom === 'boolean'));
}

/** Controls one explicitly registered local OpenCode session; the bridge owns idempotency. */
export class OpenCodeAdapter {
  #endpoint; #apiVersion; #cwd; #sessionId; #token; #fetch; #timeoutMs;

  constructor({endpoint, apiVersion, cwd, sessionId, token, fetchImpl = globalThis.fetch, timeoutMs = 15000} = {}) {
    this.#endpoint = endpointURL(endpoint);
    if (!['v1', 'v2'].includes(apiVersion)) throw new OpenCodeError('invalid_api_version', '必须明确配置 OpenCode apiVersion 为 v1 或 v2', 400);
    if (!nonempty(cwd) || !path.isAbsolute(cwd) || /[\u0000-\u001f\u007f]/.test(cwd)) throw new OpenCodeError('invalid_cwd', '需要 OpenCode 会话的绝对 cwd', 400);
    if (token !== undefined && (!nonempty(token) || /[\r\n]/.test(token))) throw new OpenCodeError('invalid_token', 'OpenCode token 必须为非空本机服务密码', 400);
    if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 150000) throw new OpenCodeError('invalid_client', 'OpenCode HTTP 客户端或超时配置无效', 400);
    this.#apiVersion = apiVersion; this.#cwd = path.normalize(cwd); this.#sessionId = identity(sessionId, 'sessionId');
    this.#token = token; this.#fetch = fetchImpl; this.#timeoutMs = timeoutMs;
  }

  #clean(value) {
    if (!this.#token) return value;
    // Do not leak the native password even if a provider echoes it in a title.
    if (typeof value === 'string') return value.replaceAll(this.#token, '[REDACTED]');
    if (Array.isArray(value)) return value.map(item => this.#clean(item));
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.#clean(item)]));
    return value;
  }

  async #request(route, {method = 'GET', body, query} = {}) {
    const url = new URL(route, this.#endpoint);
    if (this.#apiVersion === 'v1') url.searchParams.set('directory', this.#cwd);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > 64 * 1024) throw new OpenCodeError('invalid_payload', 'OpenCode 输入超过 64 KiB', 400);
    const abort = new AbortController(); let timer;
    const outcome = method === 'GET' ? 'rejected' : 'unknown';
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
      abort.abort(); reject(new OpenCodeError('opencode_timeout', 'OpenCode 请求超时；未自动重发', 504, outcome));
    }, this.#timeoutMs); });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await this.#fetch(url.href, {method, body: encoded, signal: abort.signal, redirect: 'error', headers: {
          Accept: 'application/json', ...(encoded ? {'Content-Type': 'application/json'} : {}),
          ...(this.#token ? {Authorization: `Basic ${Buffer.from(`opencode:${this.#token}`).toString('base64')}`} : {})
        }});
        if (!Number.isInteger(response?.status)) throw invalid('OpenCode 响应缺少 HTTP 状态');
        if (response.status < 200 || response.status >= 300) {
          const uncertain = method !== 'GET' && (response.status >= 500 || response.status === 408 || response.status < 400);
          throw new OpenCodeError('opencode_http_error', `OpenCode 请求未确认（HTTP ${response.status}）`, response.status, uncertain ? 'unknown' : 'rejected');
        }
        if (response.status === 204) return {status: response.status, data: null};
        let size = 0; const chunks = [];
        if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') throw invalid('OpenCode 响应缺少 JSON 正文');
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > MAX_RESPONSE) throw invalid('OpenCode 响应超过读取上限');
          chunks.push(Buffer.from(chunk));
        }
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw invalid('OpenCode 响应不是完整 JSON'); }
        return {status: response.status, data};
      })()]);
    } catch (error) {
      if (error instanceof OpenCodeError) {
        if (method !== 'GET' && error.code === 'invalid_response') error.outcome = 'unknown';
        throw error;
      }
      // Fetch exceptions may contain credentials: return no raw upstream error.
      throw new OpenCodeError('opencode_unavailable', 'OpenCode 本机服务连接或响应未确认', 503, outcome);
    } finally { clearTimeout(timer); abort.abort(); }
  }

  async #get(route) {
    const {data} = await this.#request(route);
    if (this.#apiVersion === 'v1') return data;
    if (!object(data) || !Object.hasOwn(data, 'data')) throw invalid('OpenCode V2 响应缺少 data');
    return data.data;
  }

  async read() {
    const v2 = this.#apiVersion === 'v2', sessionPath = `${v2 ? '/api' : ''}/session/${encodeURIComponent(this.#sessionId)}`;
    const [session, states, permissions, forms] = await Promise.all([
      this.#get(sessionPath), this.#get(v2 ? '/api/session/active' : '/session/status'),
      this.#get(v2 ? `${sessionPath}/permission` : '/permission'), this.#get(v2 ? `${sessionPath}/form` : '/question')
    ]);
    if (!object(session) || session.id !== this.#sessionId || path.normalize((v2 ? session.location?.directory : session.directory) ?? '') !== this.#cwd) {
      throw new OpenCodeError('scope_mismatch', 'OpenCode 会话或 cwd 与登记身份不一致', 409);
    }
    if (!object(states) || !Array.isArray(permissions) || !Array.isArray(forms)) throw invalid('OpenCode 状态或 pending 请求格式无效');
    const present = Object.hasOwn(states, this.#sessionId);
    const nativeStatus = present ? states[this.#sessionId]?.type : 'idle';
    if (!(v2 && present ? ['running'] : v2 ? ['idle'] : ['busy', 'retry', 'idle']).includes(nativeStatus)) throw invalid('OpenCode 返回不支持的会话状态');
    const active = nativeStatus !== 'idle';
    const questions = [];
    for (const item of [...permissions.map(value => ({value, kind: 'approval'})), ...forms.map(value => ({value, kind: 'question'}))]) {
      const request = item.value;
      if (!object(request) || !nonempty(request.sessionID) || !nonempty(request.id)) throw invalid('OpenCode pending 请求缺少身份');
      if (request.sessionID !== this.#sessionId) {
        if (v2) throw new OpenCodeError('scope_mismatch', 'OpenCode 返回其他会话的 pending 请求', 409);
        continue; // V1 endpoints enumerate every session in the directory instance.
      }
      identity(request.id, 'questionId');
      if (questions.some(question => question.id === request.id)) throw invalid('OpenCode pending 请求身份重复');
      let question;
      if (item.kind === 'approval') {
        const action = v2 ? request.action : request.permission, resources = v2 ? request.resources : request.patterns;
        if (!nonempty(action) || !strings(resources)) throw invalid('OpenCode 审批请求缺少动作或资源范围');
        question = {id: request.id, sessionId: request.sessionID, kind: 'approval', text: `${action}: ${resources.join(', ') || '(无资源)'}`,
          action, resources, options: ['once', 'reject'], answerSupported: v2 || active,
          fingerprint: fingerprint(request)};
      } else if (v2) {
        if (!Array.isArray(request.fields) || !nonempty(request.title)) throw invalid('OpenCode Form 缺少字段或标题');
        question = {id: request.id, sessionId: request.sessionID, kind: 'question', text: request.title,
          fields: request.fields, answerSupported: formSupported(request.fields), fingerprint: fingerprint(request),
          ...(request.fields.length === 1 && request.fields[0].options ? {options: request.fields[0].options} : {})};
      } else {
        const supported = questionSupported(request.questions);
        question = {id: request.id, sessionId: request.sessionID, kind: 'question',
          text: supported ? request.questions.map(prompt => prompt.question).join('\n') : '当前 OpenCode 问题格式暂不支持远程回答',
          prompts: request.questions, answerSupported: supported && active, fingerprint: fingerprint(request),
          ...(supported && request.questions.length === 1 ? {options: request.questions[0].options} : {})};
      }
      questions.push(question);
    }
    // An inactive V1 session may retain stale approvals after abort. Never revive
    // such a request merely because it still appears in the pending list.
    const status = questions.length ? (questions.some(question => question.kind === 'question') ? 'waiting_input' : 'blocked') : active ? 'running' : 'idle';
    return this.#clean({adapter: 'opencode', provider: 'opencode', title: nonempty(session.title) ? session.title : `OpenCode ${this.#sessionId}`,
      sessionId: this.#sessionId, status, acceptance: 'unreviewed', questions,
      capabilities: {answer: questions.some(question => question.answerSupported), resume: !active && !questions.length && !session.time?.archived, interrupt: active, handoff: false},
      source: `opencode.http.${this.#apiVersion}`, capture: 'snapshot_diff',
      metadata: {apiVersion: this.#apiVersion, cwd: this.#cwd, nativeStatus, ...(session.outcome ? {nativeOutcome: session.outcome} : {}),
        ...(session.time?.archived ? {archived: true} : {})}});
  }

  #answer(question, payload) {
    if (!question.answerSupported) throw new OpenCodeError('unsupported_question', '当前问题格式或原生会话状态不支持远程回答', 409);
    if (question.kind === 'approval') {
      if (Object.keys(payload).some(key => key !== 'decision') || !['once', 'reject'].includes(payload.decision)) throw new OpenCodeError('invalid_decision', '审批必须明确选择 once 或 reject', 400);
      return this.#apiVersion === 'v1' ? {reply: payload.decision} : {decision: payload.decision};
    }
    if (Object.keys(payload).some(key => !['answer', 'answers'].includes(key)) || (payload.answer !== undefined && payload.answers !== undefined)) throw new OpenCodeError('invalid_answer', '回答只能使用 answer 或 answers 中的一项', 400);
    if (this.#apiVersion === 'v1') {
      const prompts = question.prompts;
      let answers = payload.answers;
      if (payload.answer !== undefined) answers = prompts.length === 1 && typeof payload.answer === 'string' ? [[payload.answer]] : null;
      else if (prompts.length === 1 && strings(answers)) answers = [answers];
      if (!Array.isArray(answers) || answers.length !== prompts.length || !answers.every(strings)) throw new OpenCodeError('invalid_answer', 'V1 answers 必须按问题顺序提供字符串数组；单题可用 answer 文本', 400);
      answers.forEach((answer, index) => {
        const prompt = prompts[index];
        if (!answer.length || answer.some(value => !nonempty(value)) || new Set(answer).size !== answer.length || (!prompt.multiple && answer.length !== 1) ||
          (prompt.custom === false && answer.some(value => !prompt.options.some(option => option.label === value)))) throw new OpenCodeError('invalid_answer', '回答不符合原始问题的选择范围', 400);
      });
      return {answers};
    }
    const field = question.fields[0], value = field.type === 'string' ? payload.answer : payload.answers;
    if (field.type === 'string') {
      if (typeof value !== 'string' || (field.required && !value.length) || (field.minLength !== undefined && [...value].length < field.minLength) || (field.maxLength !== undefined && [...value].length > field.maxLength)) throw new OpenCodeError('invalid_answer', '回答不符合 Form 文本约束', 400);
    } else if (!strings(value) || new Set(value).size !== value.length || (field.required && !value.length) || (field.minItems !== undefined && value.length < field.minItems) || (field.maxItems !== undefined && value.length > field.maxItems)) throw new OpenCodeError('invalid_answer', '回答不符合 Form 多选约束', 400);
    const values = field.type === 'string' ? [value] : value;
    if (field.options?.length && field.custom !== true && values.some(item => !field.options.some(option => option.value === item))) throw new OpenCodeError('invalid_answer', 'Form 回答必须使用原始选项 value', 400);
    return {answer: {[field.key]: value}};
  }

  async execute(command, task) {
    if (!object(command) || !object(task) || task.adapter !== 'opencode' || task.sessionId !== this.#sessionId || command.sessionId !== this.#sessionId || task.metadata?.apiVersion !== this.#apiVersion || task.metadata?.cwd !== this.#cwd) throw new OpenCodeError('scope_mismatch', '命令必须绑定登记的原 OpenCode 会话、cwd 和 API 版本', 409);
    const requestId = identity(command.id, 'command.id');
    if (!['answer', 'resume', 'interrupt'].includes(command.action)) throw new OpenCodeError('unsupported_action', 'OpenCode 仅开放 answer、resume 和 interrupt', 400);
    const payload = command.payload ?? {};
    if (!object(payload)) throw new OpenCodeError('invalid_payload', '命令 payload 必须是对象', 400);
    const fresh = await this.read(); // Recheck scope and native pending state for EVERY action.
    const v2 = this.#apiVersion === 'v2', sessionPath = `${v2 ? '/api' : ''}/session/${encodeURIComponent(this.#sessionId)}`;
    let route, body, query;
    if (command.action === 'answer') {
      const questionId = identity(command.questionId, 'questionId');
      const original = task.questions?.find(question => question.id === questionId);
      const question = fresh.questions.find(item => item.id === questionId);
      if (!original || !question || original.sessionId !== this.#sessionId || original.fingerprint !== question.fingerprint || original.kind !== question.kind) throw new OpenCodeError('question_changed', '原问题已过期或内容发生变化，请刷新任务', 409);
      body = this.#answer(question, payload);
      route = v2 ? `${sessionPath}/${question.kind === 'approval' ? 'permission' : 'form'}/${encodeURIComponent(questionId)}/reply` : `/${question.kind === 'approval' ? 'permission' : 'question'}/${encodeURIComponent(questionId)}/reply`;
    } else if (command.action === 'resume') {
      if (fresh.status !== 'idle' || !fresh.capabilities.resume) throw new OpenCodeError('session_not_idle', '只有原生 idle 且无 pending 请求的会话可以继续', 409);
      if (Object.keys(payload).some(key => key !== 'input') || !nonempty(payload.input)) throw new OpenCodeError('invalid_input', '继续需要明确的 payload.input 文本', 400);
      route = `${sessionPath}/${v2 ? 'prompt' : 'prompt_async'}`;
      body = v2 ? {text: payload.input, resume: true} : {parts: [{type: 'text', text: payload.input}]};
    } else {
      if (Object.keys(payload).length) throw new OpenCodeError('invalid_payload', 'interrupt 不接受自定义 payload', 400);
      if (!fresh.capabilities.interrupt) throw new OpenCodeError('session_not_active', '原会话当前没有可中断的执行', 409);
      route = `${sessionPath}/${v2 ? 'interrupt' : 'abort'}`;
      if (v2) query = {resume: 'false'};
    }
    try {
      const response = await this.#request(route, {method: 'POST', body, query});
      const valid = command.action === 'answer' ? (v2 ? response.status === 204 : response.data === true) : command.action === 'interrupt' ?
        (v2 ? object(response.data) && typeof response.data.interrupted === 'boolean' : response.data === true) :
        (v2 ? object(response.data?.data) : response.status === 204);
      if (!valid) throw new OpenCodeError('invalid_receipt', 'OpenCode 未返回可核对的原生回执', 502, 'unknown');
      // V1 can return true even if a racing reply already removed the request.
      // It acknowledges HTTP handling, not durable saving or agent consumption.
      return {requestId, status: command.action === 'answer' ? (v2 ? 'answered' : 'accepted') : command.action === 'resume' || (v2 && response.data?.interrupted === false) ? 'accepted' : 'interrupted', sessionId: this.#sessionId,
        ...(command.action === 'answer' ? {questionId: command.questionId, readState: 'read_unconfirmed', ...(v2 ? {} : {nativeAcknowledgement: 'http_only'})} : {}),
        ...(v2 && command.action === 'interrupt' ? {interrupted: response.data.interrupted} : {})};
    } catch (error) {
      if (!(error instanceof OpenCodeError) || error.outcome !== 'unknown') throw error;
      // Native endpoints do not share the bridge command ID. No retry or guessed
      // reconciliation can safely turn a transport failure into an applied result.
      return {requestId, status: 'unknown', sessionId: this.#sessionId, error: {code: error.code, message: error.message}, requiredAction: 'inspect_native_session'};
    }
  }
}
