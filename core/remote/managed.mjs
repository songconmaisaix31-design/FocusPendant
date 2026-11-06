import fs from 'node:fs';
import path from 'node:path';
import {spawn, execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const PROVIDERS = new Set(['codex', 'claude', 'gemini', 'opencode']);
const MAX_LINE = 1024 * 1024;
const MAX_PROMPT = 64000;
const hash = value => createHash('sha256').update(value).digest('hex');
const error = (message, status = 400) => Object.assign(new Error(message), {status});
const clone = value => structuredClone(value);
function text(value, label, max = MAX_PROMPT) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw error(`${label} 无效`);
  return value;
}
function session(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value) ? value : null;
}

// Flags are selected locally. A remote prompt is always one argument, never shell code.
export function managedCommand({provider, prompt, model, sessionId, sandbox}) {
  if (!PROVIDERS.has(provider)) throw error('不支持此 Agent');
  text(prompt, '任务输入');
  if (model !== undefined && (typeof model !== 'string' || !model || model.length > 200 || model.startsWith('-') || model.includes('\0'))) throw error('模型配置无效');
  if (sessionId && !session(sessionId)) throw error('会话 ID 无效');
  if (sandbox && !['read-only', 'workspace-write'].includes(sandbox)) throw error('托管模式仅支持 read-only 或 workspace-write');
  const modelArgs = model ? ['--model', model] : [];
  if (provider === 'codex') return sessionId
    ? ['exec', ...(sandbox ? ['--sandbox', sandbox] : []), 'resume', '--json', ...modelArgs, sessionId, '--', prompt]
    : ['exec', '--json', ...(sandbox ? ['--sandbox', sandbox] : []), ...modelArgs, '--', prompt];
  if (provider === 'claude') return ['-p', '--output-format', 'stream-json', '--verbose', ...modelArgs, ...(sessionId ? ['--resume', sessionId] : []), '--', prompt];
  if (provider === 'gemini') return ['--output-format', 'stream-json', ...modelArgs, ...(sessionId ? ['--resume', sessionId] : []), `--prompt=${prompt}`];
  return ['run', '--format', 'json', ...modelArgs, ...(sessionId ? ['--session', sessionId] : []), '--', prompt];
}

// Preserve native lifecycle facts, not free-form claims that the user's goal is done.
export function normalizeManagedEvent(provider, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string') return null;
  const result = {nativeType: value.type.slice(0,100), type: 'agent.activity'};
  if (provider === 'codex') {
    if (value.type === 'thread.started') result.sessionId = session(value.thread_id);
    if (value.type === 'turn.started') {result.type = 'turn.started'; result.turnStatus = 'running';}
    if (value.type === 'turn.completed') {result.type = 'turn.completed'; result.turnStatus = 'completed';}
    if (value.type === 'turn.failed') {result.type = 'turn.failed'; result.turnStatus = 'failed';}
    if (value.type.startsWith('item.') && ['command_execution','mcp_tool_call','file_change'].includes(value.item?.type)) result.type = value.type === 'item.completed' ? 'tool.completed' : 'tool.activity';
    if (value.type === 'error') result.type = 'agent.error';
  } else if (provider === 'claude') {
    // Child-agent messages can carry a different session; only the root owns this handle.
    if (!value.parent_tool_use_id) result.sessionId = session(value.session_id);
    if (value.type === 'system' && value.subtype === 'init') {result.type = 'turn.started'; result.turnStatus = 'running';}
    if (value.type === 'result' && !value.parent_tool_use_id) {
      result.turnStatus = value.is_error === true || String(value.subtype || '').startsWith('error') ? 'failed' : value.subtype === 'success' ? 'completed' : null;
      result.type = result.turnStatus === 'failed' ? 'turn.failed' : 'turn.completed';
    }
    if (value.type === 'system' && value.subtype === 'permission_denied') result.type = 'permission.denied';
    if (value.type === 'assistant' && value.message?.content?.some?.(item => item.type === 'tool_use')) result.type = 'tool.activity';
    if (value.type === 'user' && value.message?.content?.some?.(item => item.type === 'tool_result')) result.type = 'tool.completed';
  } else if (provider === 'gemini') {
    if (value.type === 'init') {result.sessionId = session(value.session_id); result.type = 'turn.started'; result.turnStatus = 'running';}
    if (value.type === 'tool_use') result.type = 'tool.activity';
    if (value.type === 'tool_result') result.type = 'tool.completed';
    if (value.type === 'error') result.type = 'agent.error';
    if (value.type === 'result') {
      result.turnStatus = value.status === 'success' ? 'completed' : value.status === 'error' || value.error ? 'failed' : null;
      result.type = result.turnStatus === 'failed' ? 'turn.failed' : 'turn.completed';
    }
  } else if (provider === 'opencode') {
    result.sessionId = session(value.sessionID || value.session_id || value.part?.sessionID);
    if (value.type === 'step_start') {result.type = 'turn.started'; result.turnStatus = 'running';}
    if (value.type === 'tool_use') result.type = 'tool.activity';
    if (value.type === 'step_finish' && value.part?.reason === 'stop') {result.type = 'turn.completed'; result.turnStatus = 'completed';}
    if (value.type === 'error') {result.type = 'turn.failed'; result.turnStatus = 'failed';}
  } else return null;
  if (!result.sessionId) delete result.sessionId;
  if (!result.turnStatus) delete result.turnStatus;
  return result;
}

export class ManagedAdapter {
  constructor(options = {}) {
    if (!PROVIDERS.has(options.provider)) throw error('不支持此 Agent');
    this.provider = options.provider;
    this.cwd = fs.realpathSync(text(options.cwd, '工作目录', 4096));
    if (!fs.statSync(this.cwd).isDirectory()) throw error('工作目录不存在');
    this.options = {...options};
    this.prompt = options.prompt;
    this.executable = options.executable || options.provider;
    text(this.executable, '本地可执行程序', 4096);
    this.spawnImpl = options.spawnImpl || spawn;
    this.onUpdate = options.onUpdate || (() => {});
    this.child = null;
    this.groupPid = null;
    this.started = false;
    this.closed = false;
    this.busy = false;
    this.confirmedIdle = !options.sessionId || options.recoverable === true;
    this.sessionTrusted = true;
    this.receipts = new Map();
    this.waiters = new Set();
    this.snapshot = {
      adapter: 'managed', provider: this.provider, title: String(options.title || `${this.provider} 托管任务`).slice(0,200),
      projectId: options.projectId || '', status: options.sessionId ? 'unknown' : 'idle', acceptance: 'unreviewed',
      sessionId: options.sessionId ? session(options.sessionId) : null, questions: [], source: `${this.provider}.jsonl`, capture: 'native_event',
      metadata: {cwd: this.cwd, exitCode: null, exitSignal: null, turnStatus: 'unknown', attemptId: null, eventCount: 0, malformedLines: 0, stderrBytes: 0, protocolWarning: null}
    };
    if (options.sessionId && !this.snapshot.sessionId) throw error('会话 ID 无效');
  }

  _groupAlive() {
    if (!this.groupPid || process.platform === 'win32') return false;
    try {process.kill(-this.groupPid, 0); return true;} catch (e) {return e.code !== 'ESRCH';}
  }
  _active() {return Boolean(this.child) || this._groupAlive();}
  _view() {
    const active = this._active();
    const canControl = !this.closed;
    return {...clone(this.snapshot), capabilities: {answer: false, resume: canControl && !active && this.confirmedIdle && this.sessionTrusted && Boolean(this.snapshot.sessionId), interrupt: canControl && active, handoff: canControl && !active && this.confirmedIdle && this.started},
      metadata: {...clone(this.snapshot.metadata), processAlive: Boolean(this.child), writerReleased: !active && this.confirmedIdle}};
  }
  _emit(event) {
    const safeEvent = {...event, observedAt: Date.now(), attemptId: this.snapshot.metadata.attemptId};
    try {const pending = this.onUpdate(this._view(), safeEvent); if (pending?.catch) pending.catch(() => {});} catch {}
  }
  async read() {return this._view();}

  async start() {
    if (this.started) throw error('任务已启动，请使用明确的 resume 命令',409);
    if (this.snapshot.sessionId && !this.confirmedIdle) throw error('重启后旧进程状态未知，需在本机确认原写入者已停止',409);
    return this._launch(text(this.prompt, '任务输入'), this.snapshot.sessionId);
  }

  async _launch(prompt, sessionId) {
    if (this.closed || this._active()) throw error('原进程尚未停止或适配器已关闭',409);
    if (fs.realpathSync(this.cwd) !== this.cwd) throw error('工作目录已变化',409);
    const args = managedCommand({...this.options, provider: this.provider, prompt, sessionId});
    this.started = true; this.confirmedIdle = false;
    const attemptId = randomUUID();
    this.snapshot.status = 'running';
    this.snapshot.metadata = {cwd:this.cwd,exitCode:null,exitSignal:null,turnStatus:'running',attemptId,eventCount:0,malformedLines:0,stderrBytes:0,protocolWarning:null};
    let child;
    try {child = this.spawnImpl(this.executable, args, {cwd:this.cwd, shell:false, detached:process.platform !== 'win32', stdio:['ignore','pipe','pipe'], windowsHide:true});}
    catch (e) {this.confirmedIdle=true;this.snapshot.status='failed';this.snapshot.metadata.protocolWarning='Agent 无法启动';this._emit({type:'process.failed'});throw error('Agent 无法启动，请检查本地安装与配置',503);}
    this.child = child; this.groupPid = child.pid || null;
    const decoder = new StringDecoder('utf8');
    let buffer = '', dropping = false, finished = false, protocolMismatch = false, interruptRequested = false;
    const update = value => {
      const event = normalizeManagedEvent(this.provider, value);
      if (!event) {this.snapshot.metadata.malformedLines++;return;}
      this.snapshot.metadata.eventCount++;
      if (event.sessionId) {
        if (sessionId && event.sessionId !== sessionId || this.snapshot.sessionId && event.sessionId !== this.snapshot.sessionId) {
          protocolMismatch = true; this.sessionTrusted=false; this.snapshot.metadata.protocolWarning = '原生会话 ID 与绑定会话不一致';
          this._emit({type:'session.mismatch'}); this._signal('SIGTERM'); return;
        }
        this.snapshot.sessionId = event.sessionId;
      }
      if (event.turnStatus) this.snapshot.metadata.turnStatus = event.turnStatus;
      this.snapshot.metadata.lastEventType = event.nativeType;
      this._emit(event);
    };
    const line = raw => {
      if (!raw.trim()) return;
      if (Buffer.byteLength(raw) > MAX_LINE) {this.snapshot.metadata.malformedLines++;this.snapshot.metadata.protocolWarning='结构化输出行超过限制';return;}
      try {update(JSON.parse(raw));} catch {this.snapshot.metadata.malformedLines++;this.snapshot.metadata.protocolWarning='收到无法解析的结构化输出';}
    };
    const consume = text => {
      for (const part of text.split(/(?<=\n)/)) {
        if (!dropping) buffer += part;
        if (Buffer.byteLength(buffer)>MAX_LINE) {buffer='';dropping=true;this.snapshot.metadata.malformedLines++;this.snapshot.metadata.protocolWarning='结构化输出行超过限制';}
        if (part.endsWith('\n')) {if (!dropping) line(buffer);buffer='';dropping=false;}
      }
    };
    child.stdout?.on('data', chunk => consume(decoder.write(chunk)));
    // Never mirror stderr; it can contain credentials, source code or private prompts.
    child.stderr?.on('data', chunk => {this.snapshot.metadata.stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, this.snapshot.metadata.stderrBytes + chunk.length);});
    const finish = (code, signal, startFailed = false) => {
      if (finished) return; finished=true;
      consume(decoder.end()); if (!dropping && buffer) line(buffer);
      this.child = null; this.confirmedIdle = true;
      this.snapshot.metadata.exitCode = Number.isInteger(code) ? code : null;
      this.snapshot.metadata.exitSignal = signal || null;
      if (startFailed) this.snapshot.metadata.protocolWarning='Agent 无法启动，请检查本地安装与配置';
      if (protocolMismatch) this.snapshot.status='unknown';
      else if (interruptRequested) {this.snapshot.status='blocked';this.snapshot.metadata.turnStatus='interrupted';}
      else if (startFailed || code !== 0 || this.snapshot.metadata.turnStatus === 'failed') this.snapshot.status='failed';
      else this.snapshot.status=this.snapshot.metadata.turnStatus === 'completed' ? 'completed' : 'unknown';
      if (this._groupAlive()) {this.snapshot.status='blocked';this.snapshot.metadata.protocolWarning='Agent 已退出，所属进程组仍有运行进程';}
      else this.groupPid=null;
      for (const saved of this.receipts.values()) if(saved.receipt.attemptId===attemptId && saved.receipt.status==='executing') {
        saved.receipt={...saved.receipt,status:this.snapshot.status==='unknown' || this._active()?'unknown':this.snapshot.status==='failed'?'failed':'completed',exitCode:this.snapshot.metadata.exitCode,turnStatus:this.snapshot.metadata.turnStatus};
      }
      this._emit({type:'process.exited',exitCode:this.snapshot.metadata.exitCode,exitSignal:signal || null});
      for (const done of this.waiters) done(); this.waiters.clear();
    };
    child.once('error', () => finish(null,null,true));
    child.once('close', (code,signal) => finish(code,signal));
    child.__focusInterrupt = () => {interruptRequested=true;};
    this._emit({type:'process.started'});
    return {status:'executing',attemptId,sessionId:this.snapshot.sessionId};
  }

  _signal(signal) {
    if (process.platform !== 'win32' && this.groupPid) {
      try {process.kill(-this.groupPid,signal);return true;} catch(e) {if(e.code!=='ESRCH')throw e;}
    }
    return Boolean(this.child?.kill(signal));
  }
  async _wait(ms) {
    if (!this.child) return;
    await new Promise(resolve=>{const finish=()=>{clearTimeout(timer);this.waiters.delete(finish);resolve();};const timer=setTimeout(finish,ms);this.waiters.add(finish);});
  }
  async _interrupt() {
    if (!this._active()) return {status:'completed',stopped:true};
    this.child?.__focusInterrupt?.();
    this._signal('SIGINT');
    await this._wait(this.options.stopTimeoutMs || 1500);
    if (this._active()) {this._signal('SIGTERM');await this._wait(this.options.stopTimeoutMs || 1500);}
    if (this._active()) {this._signal('SIGKILL');await this._wait(1000);}
    // A surviving descendant makes ownership unknown; never start a second writer.
    const stopped=!this._active();
    this._emit({type:stopped?'process.stopped':'process.stop_unknown'});
    return {status:stopped?'completed':'unknown',stopped,attemptId:this.snapshot.metadata.attemptId};
  }

  async execute(command) {
    if (!command || !['resume','interrupt'].includes(command.action)) throw error('此托管适配器只支持 resume 与 interrupt',422);
    const id=text(command.id || command.commandId || command.requestId,'命令 ID',200);
    const fingerprint=hash(JSON.stringify({action:command.action,sessionId:command.sessionId,payload:command.payload || {}}));
    if (this.receipts.has(id)) {const saved=this.receipts.get(id);if(saved.fingerprint!==fingerprint)throw error('同一命令 ID 的内容不一致',409);return clone(saved.receipt);}
    if (this.busy) throw error('另一项操作尚在处理',409);
    if (this.closed) throw error('适配器已关闭',409);
    if (this.snapshot.sessionId && command.sessionId!==this.snapshot.sessionId) throw error('操作与原生会话不匹配',409);
    if (!this.snapshot.sessionId && command.sessionId) throw error('尚未确认此原生会话',409);
    this.busy=true;
    try {
      let receipt;
      if(command.action==='resume') {
        if(!this.snapshot.sessionId || !this.confirmedIdle || !this.sessionTrusted || this._active())throw error('原会话尚不能接续',409);
        receipt=await this._launch(text(command.payload?.input,'接续输入'),this.snapshot.sessionId);
      } else receipt=await this._interrupt();
      this.receipts.set(id,{fingerprint,receipt});
      return clone(receipt);
    } finally {this.busy=false;}
  }

  async reconcile(command) {
    const saved=this.receipts.get(command.id || command.commandId || command.requestId);
    if(!saved)return {status:'unknown',reason:'此进程没有该命令的执行记录'};
    const receipt=clone(saved.receipt);
    if(receipt.status==='executing' && receipt.attemptId===this.snapshot.metadata.attemptId && !this._active())return {...receipt,status:this.snapshot.status==='unknown'?'unknown':this.snapshot.status==='failed'?'failed':'completed',exitCode:this.snapshot.metadata.exitCode,turnStatus:this.snapshot.metadata.turnStatus};
    return receipt;
  }
  async close() {if(this.closed)return;await this._interrupt();this.closed=true;}
}

async function git(cwd,args,maxBuffer=1024*1024) {
  try {return (await execFileAsync('git',['--no-optional-locks','-C',cwd,...args],{encoding:'utf8',timeout:10000,maxBuffer,windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_PAGER:'cat'}})).stdout;}
  catch {throw error('无法完整读取 Git 工作区检查点，请检查仓库及差异大小',409);}
}

export async function workspaceCheckpoint(cwd) {
  const real=fs.realpathSync(text(cwd,'工作目录',4096));
  const root=fs.realpathSync((await git(real,['rev-parse','--show-toplevel'])).trim());
  const head=(await git(root,['rev-parse','--verify','HEAD'])).trim();
  const status=await git(root,['status','--porcelain=v1','-z','--untracked-files=all']);
  const diff=await git(root,['diff','--no-ext-diff','--no-textconv','--binary','HEAD','--']);
  const paths=(await git(root,['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean).sort();
  if(paths.length>200)throw error('未跟踪文件过多，请先整理工作区再交接',409);
  const untracked=[];let bytes=0;
  for(const filename of paths) {
    const absolute=path.resolve(root,filename);
    if(!absolute.startsWith(root+path.sep))throw error('工作区路径异常',409);
    const info=fs.lstatSync(absolute);
    if(!info.isFile()&&!info.isSymbolicLink())throw error('交接仅支持普通文件与符号链接',409);
    bytes+=info.size;if(bytes>20*1024*1024)throw error('未跟踪文件超过交接检查限制',409);
    const content=info.isSymbolicLink()?fs.readlinkSync(absolute):fs.readFileSync(absolute);
    untracked.push({path:filename,size:info.size,type:info.isSymbolicLink()?'symlink':'file',sha256:hash(content)});
  }
  const snapshot={cwd:real,root,head,status,diff,diffSha256:hash(diff),untracked};
  snapshot.fingerprint=hash(JSON.stringify({cwd:real,root,head,status,diffSha256:snapshot.diffSha256,untracked}));
  return snapshot;
}

export async function verifyWorkspaceCheckpoint(cwd,expected) {
  const actual=await workspaceCheckpoint(cwd);
  if(!expected || actual.fingerprint!==expected.fingerprint)throw error('工作区已变化，请重新生成交接检查点',409);
  return actual;
}

export async function captureHandoff({cwd,goal,done=[],decisions=[],artifacts=[],todos=[],sourceTrace=[]}) {
  text(goal,'交接目标',16000);
  const list=(value,label)=>{if(!Array.isArray(value)||value.length>100)throw error(`${label} 无效`);return value.map(item=>text(item,label,4000));};
  return {schema:'focus.handoff.v1',createdAt:Date.now(),goal,done:list(done,'已完成工作'),decisions:list(decisions,'决策'),artifacts:list(artifacts,'成果'),todos:list(todos,'待办'),sourceTrace:list(sourceTrace,'来源'),workspace:await workspaceCheckpoint(cwd)};
}

export function handoffPrompt(handoff) {
  if(handoff?.schema!=='focus.handoff.v1'||!handoff.workspace?.fingerprint)throw error('交接材料无效');
  return `继续以下任务。先核对工作区与现有成果，再执行剩余事项。原 Agent 的会话没有迁移；文件已位于当前工作区。\n${JSON.stringify({goal:handoff.goal,done:handoff.done,decisions:handoff.decisions,artifacts:handoff.artifacts,todos:handoff.todos,sourceTrace:handoff.sourceTrace,workspace:{cwd:handoff.workspace.cwd,head:handoff.workspace.head,fingerprint:handoff.workspace.fingerprint}},null,2)}`;
}
