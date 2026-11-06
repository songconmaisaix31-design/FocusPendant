import {isIP} from 'node:net';

// Protocol pinned to swarm-anything 733ee08fb694fe8d8719693ca6b6e05432e005b2:
// internal/adapters/swahttp/commands.go, cmd/swa/run_flow.go and
// runtime/swa-orca/src/{contracts,client,question-answer,run-view}.ts.
// SWA is deliberately kept on loopback. Device authorization belongs to the bridge;
// SWA still performs its own current project/worker/consumer permission checks.
const RUN_SCHEMA='swa.run-view.v1';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES=new Set(['active','waiting_input','blocked','completed','failed','unknown']);
const READ_STATES=new Set(['answer_saved','read_unconfirmed','read_observed','continuation_required','interrupted']);
const UNCERTAIN=new Set(['delivery_unknown','operation_unknown','operation_in_progress','provider_unavailable','start_unknown','stop_unknown','consumer_fenced']);
const MAX_RESPONSE=16*1024*1024;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const nonempty=value=>typeof value==='string'&&value.trim().length>0;

export class SwaError extends Error {
  constructor(code,message,status=502){super(message);this.name='SwaError';this.code=code;this.status=status;}
}

function endpointURL(value){
  // Require a literal IP AND explicit port, just like the SWA CLI. Reject DNS,
  // credentials, proxy paths, query strings and non-HTTP protocols before fetch.
  const match=typeof value==='string'&&value.match(/^http:\/\/(\[[0-9a-fA-F:.]+\]|(?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})\/?$/);
  if(!match)throw new SwaError('invalid_endpoint','SWA endpoint 必须是带端口的回环 HTTP IP 地址',400);
  const host=match[1].replace(/^\[|\]$/g,''),port=Number(match[2]);
  let parsed;
  try{parsed=new URL(value);}catch{throw new SwaError('invalid_endpoint','SWA endpoint 无效',400);}
  const loopback=isIP(host)===4?host.split('.')[0]==='127':isIP(host)===6&&parsed.hostname==='[::1]';
  if(!loopback||port<1||port>65535)throw new SwaError('invalid_endpoint','SWA endpoint 必须是带端口的回环 HTTP IP 地址',400);
  return parsed.origin;
}

function identity(value,name){
  if(!nonempty(value)||value.length>512||/[\u0000-\u001f\u007f]/.test(value))throw new SwaError('invalid_identity',`${name} 必须是明确的原始身份`,400);
  return value;
}

async function readJSON(response){
  if(!response?.body||typeof response.body[Symbol.asyncIterator]!=='function')throw new SwaError('invalid_response','SWA 响应缺少完整 JSON 正文');
  let size=0;const chunks=[];
  for await(const chunk of response.body){
    size+=chunk.length;
    if(size>MAX_RESPONSE)throw new SwaError('invalid_response','SWA 响应超过读取上限');
    chunks.push(Buffer.from(chunk));
  }
  try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(object(value))return value;}catch{}
  throw new SwaError('invalid_response','SWA 响应不是完整 JSON 对象');
}

/** One explicitly registered SWA Run; no terminal discovery or guessed questions. */
export class SwaAdapter {
  #endpoint;#token;#projectId;#controllerId;#runId;#taskId;#fetch;#timeoutMs;

  constructor({endpoint,token,projectId,controllerId,runId,taskId,fetchImpl=globalThis.fetch,timeoutMs=15000}={}){
    this.#endpoint=endpointURL(endpoint);
    if(!nonempty(token)||/[\r\n]/.test(token))throw new SwaError('missing_token','需要本机 SWA 项目授权令牌',400);
    this.#token=token;
    this.#projectId=identity(projectId,'projectId');
    if(/[\/\\?#]/.test(projectId))throw new SwaError('invalid_identity','projectId 不能包含路径分隔符',400);
    this.#controllerId=identity(controllerId,'controllerId');
    this.#runId=identity(runId,'runId');
    this.#taskId=identity(taskId,'taskId');
    if(typeof fetchImpl!=='function')throw new SwaError('invalid_fetch','需要有效的 HTTP 客户端',400);
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>150000)throw new SwaError('invalid_timeout','SWA timeoutMs 应为 1–150000 毫秒',400);
    this.#fetch=fetchImpl;this.#timeoutMs=timeoutMs;
  }

  #clean(text){return typeof text==='string'?text.replaceAll(this.#token,'[REDACTED]'):(text===null||text===undefined||typeof text==='boolean'||typeof text==='number'?text:undefined);}
  #scope(){return {project_id:this.#projectId,controller:this.#controllerId,run_id:this.#runId,task_id:this.#taskId};}

  async #post(command){
    const body=JSON.stringify(command);
    if(Buffer.byteLength(body)>64*1024)throw new SwaError('invalid_command','SWA 命令超过 64 KiB 上限',400);
    const abort=new AbortController();let timer;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new SwaError('swa_timeout','SWA 请求超时；原命令结果须按原请求 ID 查询',504));},this.#timeoutMs);});
    try{
      return await Promise.race([timeout,(async()=>{
        const response=await this.#fetch(`${this.#endpoint}/api/v1/local-projects/${encodeURIComponent(this.#projectId)}/orca/commands`,{
          method:'POST',redirect:'error',signal:abort.signal,
          headers:{Authorization:`Bearer ${this.#token}`,'Content-Type':'application/json',...(command.request_id?{'Idempotency-Key':command.request_id}:{})},body
        });
        if(response.status>=300&&response.status<400)throw new SwaError('swa_redirect','拒绝 SWA 重定向');
        return {status:response.status,reply:await readJSON(response)};
      })()]);
    }catch(error){
      if(error instanceof SwaError)throw error;
      // Never return raw fetch errors (injected clients can include Authorization).
      throw new SwaError('swa_unavailable','SWA 本机服务连接或响应未确认',503);
    }finally{clearTimeout(timer);abort.abort();}
  }

  #failure(reply,status){
    const error=object(reply?.error)?reply.error:{};
    return new SwaError(nonempty(error.code)?this.#clean(error.code):'swa_http_error',
      nonempty(error.message)?this.#clean(error.message):`SWA 未确认请求（HTTP ${status}）`,status>=400?status:502);
  }

  #envelope(reply,{requestId,dispatchId,questionId}={}){
    if(!object(reply)||typeof reply.ok!=='boolean'||reply.controller!==this.#controllerId||reply.run_id!==this.#runId||reply.task_id!==this.#taskId||
      (requestId!==undefined&&reply.request_id!==requestId)||(dispatchId!==undefined&&reply.dispatch_id!==dispatchId)||
      (questionId!==undefined&&reply.question_id!==questionId))throw new SwaError('scope_mismatch','SWA 响应改变了原 Controller、Run、根 Task 或请求身份');
  }

  async read(){
    const {status,reply}=await this.#post({action:'run.show',...this.#scope()});
    if(status!==200||reply.ok!==true){
      const error=this.#failure(reply,status);
      if(status===404||['not_found','evidence_missing'].includes(error.code))throw new SwaError('swa_run_unavailable','无法读取已登记的原 SWA Run；请核对 Controller、Run 和根 Task',404);
      throw error;
    }
    this.#envelope(reply);
    const view=reply.result?.native?.run_view;
    if(!object(view)||view.schema!==RUN_SCHEMA||view.controller!==this.#controllerId||view.run_id!==this.#runId||view.root_task_id!==this.#taskId||view.root?.id!==this.#taskId||
      !STATES.has(view.status)||view.acceptance!=='unreviewed'||!nonempty(view.observed_at)||!Number.isFinite(Date.parse(view.observed_at))||typeof view.complete!=='boolean'||
      ['tasks','dispatches','questions','answered_questions','blockers','failures','deliverables','handoffs'].some(key=>!Array.isArray(view[key])))throw new SwaError('invalid_run_view','SWA 未提供完整且身份一致的 swa.run-view.v1');
    const taskIds=new Set(),dispatches=new Map(),questionIds=new Set();
    for(const task of view.tasks){
      if(!object(task)||!nonempty(task.id)||taskIds.has(task.id))throw new SwaError('invalid_run_view','SWA 任务库存缺少唯一身份');
      taskIds.add(task.id);
    }
    if(!taskIds.has(this.#taskId))throw new SwaError('swa_run_unavailable','SWA 视图缺少已登记的根 Task',404);
    for(const dispatch of view.dispatches){
      if(!object(dispatch)||!nonempty(dispatch.id)||dispatches.has(dispatch.id)||!taskIds.has(dispatch.task_id))throw new SwaError('invalid_run_view','SWA Worker 库存身份不一致');
      dispatches.set(dispatch.id,dispatch);
    }
    const question=(item,answered)=>{
      const id=answered?item?.question_id:item?.id;
      if(!object(item)||!nonempty(id)||questionIds.has(id)||!taskIds.has(item.task_id)||dispatches.get(item.dispatch_id)?.task_id!==item.task_id||!nonempty(item.question)||
        (item.kind!==undefined&&item.kind!=='question')||(answered&&(!READ_STATES.has(item.read_state)||typeof item.continuation_required!=='boolean'))||
        (item.continuation_required===true&&item.read_state!=='continuation_required'))throw new SwaError('invalid_run_view','SWA 问题缺少准确的原 Task、Dispatch 或读取状态');
      questionIds.add(id);
      return {id:this.#clean(id),text:this.#clean(item.question),kind:'question',dispatchId:this.#clean(item.dispatch_id),
        continuationRequired:answered&&item.continuation_required===true,...(answered?{readState:item.read_state}:{})};
    };
    const pending=view.questions.map(item=>question(item,false));
    const answered=view.answered_questions.map(item=>question(item,true));
    if(view.status==='waiting_input'&&!pending.length&&!answered.length)throw new SwaError('invalid_run_view','SWA 等待输入状态没有提供原始问题');
    if(view.status==='completed'&&!view.complete)throw new SwaError('invalid_run_view','SWA 完成状态缺少完整结算');
    const resumable=answered.filter(item=>item.continuationRequired);
    const questions=[...pending,...resumable];
    const single=view.dispatches.length===1?view.dispatches[0]:null;
    const root=view.tasks.find(task=>task.id===this.#taskId);
    return {
      adapter:'swa',provider:'unknown',title:this.#clean(nonempty(root.title)?root.title:`SWA Run ${this.#runId}`),
      projectId:this.#clean(this.#projectId),runId:this.#clean(this.#runId),taskId:this.#clean(this.#taskId),
      ...(single?{dispatchId:this.#clean(single.id),...(nonempty(single.recipient_session_id)?{sessionId:this.#clean(single.recipient_session_id)}:{})}:{}),
      status:view.status,acceptance:view.acceptance,questions,
      capabilities:{answer:pending.length>0,resume:resumable.length>0,interrupt:false,handoff:false},
      source:RUN_SCHEMA,capture:'snapshot_diff',
      metadata:{controllerId:this.#clean(this.#controllerId),complete:view.complete,rootStatus:this.#clean(view.root.status),
        taskCount:view.tasks.length,dispatchCount:view.dispatches.length,questionProvider:questionIds.size?'pi':null,
        answeredQuestions:answered,
        blockers:view.blockers.map(item=>({kind:this.#clean(item.kind),taskId:this.#clean(item.task_id),dispatchId:this.#clean(item.dispatch_id),reason:this.#clean(item.reason)})),
        failures:view.failures.map(item=>({taskId:this.#clean(item.task_id),dispatchId:this.#clean(item.dispatch_id),reason:this.#clean(item.reason)}))}
    };
  }

  #command(command,task){
    if(!object(command)||!object(task)||task.adapter!=='swa'||task.projectId!==this.#projectId||task.runId!==this.#runId||task.taskId!==this.#taskId)throw new SwaError('scope_mismatch','命令必须绑定已登记的原 SWA Run 和根 Task',409);
    if(command.taskId!==undefined&&command.taskId!==task.id)throw new SwaError('scope_mismatch','命令必须绑定原桥接任务 ID',409);
    for(const [key,value] of Object.entries({projectId:this.#projectId,runId:this.#runId,controllerId:this.#controllerId})){
      if(command[key]!==undefined&&command[key]!==value)throw new SwaError('scope_mismatch',`命令 ${key} 与原身份不同`,409);
    }
    const requestId=command.requestId??command.id;
    if(!UUID.test(requestId??'')||(command.requestId!==undefined&&command.id!==undefined&&command.id!==command.requestId))throw new SwaError('invalid_request_id','命令需要唯一且稳定的原请求 UUID',400);
    if(!['answer','resume'].includes(command.action))throw new SwaError('unsupported_action','当前 SWA 适配器仅开放原 Pi 问题回答与显式继续',400);
    const questionId=identity(command.questionId,'questionId'),dispatchId=identity(command.dispatchId,'dispatchId');
    if(command.payload!==undefined&&!object(command.payload))throw new SwaError('invalid_payload','命令 payload 必须是对象',400);
    if(command.action==='answer'){
      const answer=command.payload?.answer;
      if(!nonempty(answer)||Buffer.byteLength(answer,'utf8')>32000||Buffer.from(answer,'utf8').toString('utf8')!==answer)throw new SwaError('invalid_answer','回答必须为非空 UTF-8 文本，且不超过 32000 字节',400);
      if(Object.keys(command.payload).some(key=>key!=='answer'))throw new SwaError('invalid_payload','回答仅接受 payload.answer',400);
    }else if(command.payload&&Object.keys(command.payload).length)throw new SwaError('invalid_payload','显式继续不接受自定义输入',400);
    return {action:`question.${command.action}`,...this.#scope(),dispatch_id:dispatchId,question_id:questionId,request_id:requestId,
      ...(command.action==='answer'?{text:command.payload.answer}:{})};
  }

  #receipt(requestId,status,details={}){return {requestId,status,...details};}
  #unknown(requestId,error){return this.#receipt(requestId,'unknown',{error:{code:error?.code??'operation_unknown',message:this.#clean(error?.message??'原请求结果尚未确认')},requiredAction:'inspect_original_request'});}

  #boundRecord(record,original){
    if(!object(record)||record.project_id!==this.#projectId||record.controller!==this.#controllerId||record.run_id!==this.#runId||record.root_task_id!==this.#taskId||record.action!==original.action)throw new SwaError('receipt_mismatch','回执不属于原请求范围');
    const saved=record.invocation?.command;
    if(!object(saved)||Object.entries(original).some(([key,value])=>saved[key]!==value))throw new SwaError('receipt_mismatch','回执中的原命令身份或内容不一致');
    const native=record.native;
    if(!object(native)||native.request_id!==original.request_id||native.dispatch_id!==original.dispatch_id||
      native.project_id!==this.#projectId||native.controller!==this.#controllerId||native.run_id!==this.#runId||
      (original.action==='question.answer'&&(native.question_id!==original.question_id||native.root_task_id!==this.#taskId||native.body!==original.text)))throw new SwaError('receipt_mismatch','原生回执未确认准确的问题或 Worker 身份');
    return native;
  }

  #nativeReceipt(original,native){
    const requestId=original.request_id;
    if(native.state==='rejected'&&native.effects_applied===false)return this.#receipt(requestId,'rejected',{state:'rejected',error:{code:this.#clean(native.error?.code??'scope_denied'),message:this.#clean(native.error?.message??'SWA 拒绝了原请求')}});
    if(original.action==='question.answer'&&native.state==='answered'){
      if(!READ_STATES.has(native.read_state)||typeof native.continuation_required!=='boolean'||(native.continuation_required&&native.read_state!=='continuation_required'))return this.#unknown(requestId,new SwaError('invalid_receipt','回答回执缺少准确的读取状态'));
      return this.#receipt(requestId,'answered',{state:'answered',readState:native.read_state,continuationRequired:native.continuation_required});
    }
    if(original.action==='question.resume'&&['accepted','queued','journaled'].includes(native.state))return this.#receipt(requestId,'accepted',{state:native.state,
      ...(nonempty(native.session_id)?{sessionId:this.#clean(native.session_id)}:{}),...(nonempty(native.operation_id)?{operationId:this.#clean(native.operation_id)}:{})});
    return this.#unknown(requestId,new SwaError('operation_unknown','原生回执尚未确认保存回答或接受继续输入'));
  }

  async execute(command,task){
    const original=this.#command(command,task);
    // Recheck against the current native snapshot. A previously rendered question
    // or a forged public capability is not authorization to answer another Worker.
    const fresh=await this.read();
    const question=fresh.questions.find(item=>item.id===original.question_id&&item.dispatchId===original.dispatch_id);
    if(!question||(command.action==='answer'&&question.continuationRequired)||(command.action==='resume'&&!question.continuationRequired))throw new SwaError('question_not_actionable','原问题已变化，或尚不满足 continuation_required；请刷新原 Run',409);
    try{
      const {status,reply}=await this.#post(original);
      if(status!==200||reply.ok!==true){
        const error=this.#failure(reply,status);
        // A timeout, server failure or malformed reply says nothing about effects.
        if(status>=500||status===408||UNCERTAIN.has(error.code)||(![400,401,403,404,409,422,429].includes(status)&&typeof reply.ok!=='boolean'))return this.#unknown(original.request_id,error);
        return this.#receipt(original.request_id,'rejected',{error:{code:error.code,message:error.message}});
      }
      this.#envelope(reply,{requestId:original.request_id,dispatchId:original.dispatch_id,questionId:original.question_id});
      return this.#nativeReceipt(original,this.#boundRecord(reply.result,original));
    }catch(error){return this.#unknown(original.request_id,error);}
  }

  async reconcile(command,task){
    const original=this.#command(command,task);
    try{
      // This is an observation of the SAME request UUID, never a mutation retry.
      const {status,reply}=await this.#post({action:'request.show',project_id:this.#projectId,controller:this.#controllerId,request_id:original.request_id});
      if(status!==200||reply.ok!==true)return this.#unknown(original.request_id,this.#failure(reply,status));
      // request.show has no run/task in its command. Do not demand run-view fields
      // on its envelope; validate them in the durable original receipt instead.
      if(reply.request_id!==original.request_id||reply.controller!==this.#controllerId)throw new SwaError('receipt_mismatch','查询返回了其他原请求身份');
      const request=reply.result;
      if(!object(request)||request.state!=='completed')return this.#unknown(original.request_id,new SwaError('operation_unknown','原请求回执不存在、仍待定或结果未知；未重新发送'));
      return this.#nativeReceipt(original,this.#boundRecord(request.receipt,original));
    }catch(error){return this.#unknown(original.request_id,error);}
  }
}
