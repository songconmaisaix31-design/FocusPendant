import fs from 'node:fs';
import path from 'node:path';
import {randomUUID, timingSafeEqual} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {RemoteStore} from './store.mjs';
import {SwaAdapter} from './swa.mjs';
import {ManagedAdapter, captureHandoff,verifyWorkspaceCheckpoint} from './managed.mjs';
import {OpenCodeAdapter} from './opencode.mjs';

const SCOPES=['read','answer','resume','interrupt','handoff'];
const PROVIDERS=['codex','claude','gemini','opencode'];
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);};
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);}

export function loadRemoteConfig(file){
  if(!file||!fs.existsSync(file))return {targets:[],handoffProviders:{}};
  const config=JSON.parse(fs.readFileSync(file,'utf8'));
  if(config.version!==1||!Array.isArray(config.targets)||config.targets.length>100)throw new Error('远程配置需要 version:1 和 targets 数组（最多 100）');
  const ids=new Set();
  for(const target of config.targets){
    if(!/^[a-zA-Z0-9_.-]{1,100}$/.test(target.id)||ids.has(target.id))throw new Error('target.id 无效或重复');
    ids.add(target.id);
    if(!['swa','managed','opencode'].includes(target.adapter))throw new Error('不支持的任务适配器');
    if(target.adapter==='managed'&&(!PROVIDERS.includes(target.provider)||!path.isAbsolute(target.cwd||'')))throw new Error('托管任务需要支持的 provider 和绝对 cwd');
  }
  for(const provider of Object.keys(config.handoffProviders||{}))if(!PROVIDERS.includes(provider))throw new Error('交接 provider 无效');
  return config;
}

/** A local observer and command bridge. Runtime adapters remain the execution authority. */
export class RemoteController {
  constructor({dataDir,ownerToken='',config={targets:[]},now=Date.now,store,adapters={},pollIntervalMs}={}){
    this.dataDir=dataDir;this.ownerToken=ownerToken;this.config=config;this.now=now;
    this.store=store||new RemoteStore({dataDir,now});this.adapters=new Map();this.definitions=new Map();
    this.closed=false;this.locks=new Set();this.writerLocks=new Set();this.polling=new Set();this.refreshes=new Map();this.jobs=new Set();this.pairAttempts=new Map();
    this.handoffFile=path.join(dataDir,'remote-handoffs.json');
    const recovered=fs.existsSync(this.handoffFile)?JSON.parse(fs.readFileSync(this.handoffFile,'utf8')):[];
    for(const definition of [...(config.targets||[]),...recovered])this.addTarget(definition,adapters[definition.id]);
    for(const [id,adapter] of Object.entries(adapters))if(!this.adapters.has(id))this.addTarget({id,adapter:'test'},adapter);
    for(const task of this.store.listTasks())if(!this.adapters.has(task.id))this.store.markTaskUnavailable(task.id,'本地配置已不再观察此任务');
    const interval=pollIntervalMs??config.pollIntervalMs??2000;
    if(!Number.isInteger(interval)||interval<100||interval>60000)throw new Error('pollIntervalMs 应为 100–60000');
    this.timer=setInterval(()=>this.poll(),interval);this.timer.unref();
  }

  addTarget(definition,injected){
    const {id}=definition;if(this.adapters.has(id))throw fail('任务 ID 重复',409);
    const saved=this.store.getTask(id);
    const secret=definition.tokenEnv?process.env[definition.tokenEnv]:definition.token;
    const options={...definition,token:secret};delete options.tokenEnv;
    let adapter=injected;
    if(!adapter){
      if(definition.adapter==='swa')adapter=new SwaAdapter(options);
      else if(definition.adapter==='opencode')adapter=new OpenCodeAdapter(options);
      else if(definition.adapter==='managed'){
        adapter=new ManagedAdapter({...options,sessionId:options.sessionId||saved?.sessionId,
          onUpdate:(snapshot,event)=>{if(this.closed)return;this.record(id,snapshot);if(event)this.store.appendEvent('runtime.observed',{taskId:id,event},{taskId:id});}});
      }else throw fail('不支持的任务适配器');
    }
    this.adapters.set(id,adapter);this.definitions.set(id,definition);
    if(saved)this.store.markTaskUnavailable(id,'服务已重启，正在重新确认任务来源');
  }

  async start(){
    for(const [id,definition] of this.definitions){
      // Reusing saved state never automatically starts a second native session.
      if(definition.autoStart===true&&!this.store.getTask(id)&&definition.adapter==='managed'){
        try{await this.withWriter(id,()=>this.adapters.get(id).start());}catch(e){this.recordFailure(id,e);}
      }
    }
    await this.poll();
  }

  record(id,snapshot){
    if(this.closed)return null;
    const def=this.definitions.get(id)||{};
    const task={...snapshot,id,title:def.title||snapshot.title||id,projectId:def.projectId||snapshot.projectId||id};
    task.capabilities={...task.capabilities};
    const targets=Object.keys(this.config.handoffProviders||{});
    task.capabilities.handoff=task.adapter==='managed'&&Boolean(task.capabilities.handoff)&&targets.length>0;
    task.capabilities.handoffProviders=task.capabilities.handoff?targets:[];
    return this.store.upsertTask(task,{capture:task.capture||'snapshot_diff'});
  }

  recordFailure(id,error){
    if(this.closed)return;
    if(!this.store.getTask(id)){
      const def=this.definitions.get(id)||{};
      this.record(id,{adapter:def.adapter||'unknown',provider:def.provider||def.adapter||'unknown',title:def.title||id,
        status:'unknown',acceptance:'unreviewed',questions:[],capabilities:{},source:'connection',capture:'connection'});
    }
    this.store.markTaskUnavailable(id,String(error.message||error).slice(0,500));
  }

  async refresh(id){
    if(this.refreshes.has(id))return this.refreshes.get(id);
    const adapter=this.adapters.get(id);if(!adapter)throw fail('此任务未由当前服务管理',409);
    const work=(async()=>{try{return this.record(id,await adapter.read());}catch(e){this.recordFailure(id,e);throw e;}})();
    this.refreshes.set(id,work);
    try{return await work;}finally{if(this.refreshes.get(id)===work)this.refreshes.delete(id);}
  }

  async poll(){
    if(this.closed)return;
    await Promise.all([...this.adapters.keys()].map(async id=>{
      if(this.polling.has(id)||this.locks.has(id))return;this.polling.add(id);
      try{await this.refresh(id);}catch{}finally{this.polling.delete(id);}
    }));
    if(this.closed)return;
    for(const command of this.store.listCommands().filter(c=>['saved','executing'].includes(c.status))){
      const adapter=this.adapters.get(command.input.taskId);if(!adapter?.reconcile||this.locks.has(command.input.taskId))continue;
      try{const result=await adapter.reconcile(command.input,this.store.getTask(command.input.taskId));
        if(this.closed)return;const status=this.receiptState(command.input,result);
        if(status!==command.status&&status!=='unknown')this.store.updateCommand(command.id,{status,result});
      }catch{}
    }
  }

  authenticate(header){
    const supplied=String(header||'').startsWith('Bearer ')?String(header).slice(7):'';
    if(this.ownerToken.length>=16&&equal(supplied,this.ownerToken))return {id:'owner',owner:true,scopes:SCOPES,projectIds:[]};
    const client=this.store.authenticate(supplied);if(!client)throw fail('连接凭据无效或已撤销',401);return client;
  }
  allowed(client,task){return client.owner||!client.projectIds.length||client.projectIds.includes(task.projectId);}
  taskFor(client,id){const task=this.store.getTask(id);if(!task||!this.allowed(client,task))throw fail('任务不存在或无权访问',404);return task;}
  authorize(client,scope){if(!client.owner&&!client.scopes.includes(scope))throw fail('此设备没有该操作权限',403);}
  owner(client){if(!client.owner)throw fail('此操作需要电脑主凭据',403);}

  commandFor(client,id){
    const command=this.store.getCommand(id);
    if(!command||(!client.owner&&command.clientId!==client.id))throw fail('请求不存在或无权访问',404);
    this.taskFor(client,command.input.taskId);return command;
  }
  snapshot(client){
    this.authorize(client,'read');
    return {device:this.store.identity(),tasks:this.store.listTasks().filter(t=>this.allowed(client,t)),
      commands:this.store.listCommands().filter(c=>(client.owner||c.clientId===client.id)&&this.store.getTask(c.input.taskId)&&this.allowed(client,this.store.getTask(c.input.taskId))).slice(0,100),
      watermark:this.store.events({limit:1}).watermark,serverTime:this.now(),permissions:{scopes:client.scopes,projectIds:client.projectIds,owner:Boolean(client.owner)}};
  }
  events(client,options){
    this.authorize(client,'read');const result=this.store.events(options);
    result.events=result.events.filter(e=>{
      if(!e.taskId)return Boolean(client.owner);
      if(!client.owner&&(!e.projectId||(client.projectIds.length&&!client.projectIds.includes(e.projectId))))return false;
      if(e.type.startsWith('command.'))return Boolean(client.owner||e.payload.command?.clientId===client.id);
      return true;
    });return result;
  }
  pair(input,address){
    if(this.ownerToken.length<16)throw fail('请先初始化远程配置和电脑主凭据',503);
    const now=this.now(),key=address||'unknown';
    for(const [k,v] of this.pairAttempts)if(now-v.start>60000)this.pairAttempts.delete(k);
    const window=this.pairAttempts.get(key)||{start:now,count:0};window.count++;this.pairAttempts.set(key,window);
    if(window.count>10||this.pairAttempts.size>1000)throw fail('配对尝试过于频繁，请稍后重试',429);
    return this.store.claimPairing(input);
  }

  async submit(client,input){
    if(!input||typeof input!=='object'||!UUID.test(input.id||''))throw fail('命令需要稳定 UUID');
    const allowedKeys=new Set(['id','taskId','action','expectedRevision','sessionId','questionId','dispatchId','expiresAt','payload']);
    if(Object.keys(input).some(k=>!allowedKeys.has(k)))throw fail('命令包含未支持字段');
    if(!['answer','resume','interrupt','handoff'].includes(input.action))throw fail('不支持的命令');
    this.authorize(client,input.action);this.taskFor(client,input.taskId);
    // Retry an existing command before applying time/revision checks to the original request.
    if(this.store.getCommand(input.id))return this.store.beginCommand(input,client.id);
    if(!Number.isSafeInteger(input.expiresAt)||input.expiresAt<=this.now()||input.expiresAt>this.now()+300000)throw fail('命令已过期或有效期超过五分钟',409);
    if(!Number.isSafeInteger(input.expectedRevision))throw fail('缺少预期任务版本');
    if(!input.payload||typeof input.payload!=='object'||Array.isArray(input.payload))throw fail('命令 payload 无效');
    if(this.locks.has(input.taskId))throw fail('此任务正在处理另一个命令',409);
    const saved=this.taskFor(client,input.taskId);
    if(saved.freshness!=='connected')throw fail('任务来源已过期，重新连接后再操作',409);
    this.locks.add(input.taskId);
    try{
      const current=await this.refresh(input.taskId);
      if(current.revision!==input.expectedRevision)throw fail('任务已变化，请查看最新状态后重新操作',409);
      if((current.sessionId||null)!==(input.sessionId||null))throw fail('原会话不匹配',409);
      if(!current.capabilities?.[input.action])throw fail('当前任务不支持此操作',409);
      if(input.action==='answer'||(input.action==='resume'&&input.questionId)){
        const question=current.questions?.find(q=>q.id===input.questionId);
        if(!question||question.dispatchId&&question.dispatchId!==input.dispatchId)throw fail('原问题已失效或不匹配',409);
        if(input.action==='answer'&&question.continuationRequired)throw fail('此问题已回答，请显式继续',409);
        if(question.kind==='approval'&&!['once','reject'].includes(input.payload.decision))throw fail('审批仅支持允许本次或拒绝');
      }
      const command=this.store.beginCommand(input,client.id);
      this.store.updateCommand(input.id,{status:'dispatching'});
      const job=this.runCommand(command,current).finally(()=>{this.locks.delete(input.taskId);this.jobs.delete(job);});
      this.jobs.add(job);
      return this.store.getCommand(input.id);
    }catch(e){this.locks.delete(input.taskId);throw e;}
  }

  async runCommand(command,task){
    const input=command.input,adapter=this.adapters.get(input.taskId);
    try{
      const result=input.action==='handoff'?await this.withWriter(task.id,()=>this.handoff(input,task)):
        input.action==='resume'&&task.adapter==='managed'?await this.withWriter(task.id,()=>adapter.execute(input,task)):await adapter.execute(input,task);
      if(this.closed)return;
      const status=this.receiptState(input,result);
      this.store.updateCommand(input.id,{status,result});
      try{await this.refresh(input.taskId);}catch{}
    }catch(e){
      if(!this.closed)this.store.updateCommand(input.id,{status:e.outcome==='unknown'||!e.status?'unknown':'rejected',error:String(e.message).slice(0,1000)});
    }
  }

  receiptState(input,result){
    if(result?.status==='unknown')return 'unknown';
    if(result?.status==='rejected')return 'rejected';
    if(result?.status==='failed')return 'failed';
    if(input.action==='answer')return result?.readState==='read_observed'?'consumed':'saved';
    if(result?.status==='executing')return 'executing';
    return 'completed'; // The command completed; the task has a separate outcome and acceptance.
  }

  async withWriter(id,work){
    const definition=this.definitions.get(id),cwd=definition?.cwd;
    if(!cwd)return work();
    const workspace=directory=>{
      const real=fs.realpathSync(directory);
      try{return fs.realpathSync(execFileSync('git',['--no-optional-locks','-C',real,'rev-parse','--show-toplevel'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:3000}).trim());}
      catch{return real;}
    };
    const real=workspace(cwd);
    if(this.writerLocks.has(real))throw fail('这个工作区正在交接或启动另一个 Agent',409);
    this.writerLocks.add(real);
    try{
      for(const [otherId,other] of this.definitions){
        if(otherId===id||other.adapter!=='managed'||!other.cwd||workspace(other.cwd)!==real)continue;
        const state=await this.adapters.get(otherId).read();
        if(state.metadata?.writerReleased!==true)throw fail('另一个托管 Agent 仍持有此工作区，请先停止或使用独立 worktree',409);
      }
      return await work();
    }finally{this.writerLocks.delete(real);}
  }

  async handoff(input,task){
    const provider=input.payload.provider,settings=this.config.handoffProviders?.[provider];
    if(!settings||!task.capabilities.handoffProviders?.includes(provider))throw fail('目标 Agent 未在电脑上配置',409);
    const source=this.definitions.get(task.id);
    const card=await captureHandoff({cwd:source.cwd,goal:source.prompt||task.title,
      done:input.payload.done||[],decisions:input.payload.decisions||[],artifacts:input.payload.artifacts||[],
      todos:input.payload.input?[input.payload.input]:['读取工作区和已有成果，继续完成原任务，并报告验证结果'],
      sourceTrace:[JSON.stringify({taskId:task.id,sessionId:task.sessionId,revision:task.revision})]});
    const cardFile=path.join(this.dataDir,'handoffs',input.id+'.json');atomic(cardFile,card);
    const targetId='handoff-'+input.id;
    const definition={...settings,id:targetId,adapter:'managed',provider,cwd:source.cwd,projectId:task.projectId,
      title:`${task.title} · ${provider} 接手`,autoStart:false,
      prompt:`接续已有任务。交接材料在本机文件 ${cardFile}。先读取并核对工作区、目标与已完成证据，再继续剩余工作。不要把尚未验收的成果当作通过。原任务 ${task.id}，原会话 ${task.sessionId||'无'}。`};
    delete definition.sessionId;delete definition.recoverable;
    await verifyWorkspaceCheckpoint(source.cwd,card.workspace);
    const persisted=fs.existsSync(this.handoffFile)?JSON.parse(fs.readFileSync(this.handoffFile,'utf8')):[];
    persisted.push(definition);atomic(this.handoffFile,persisted);
    this.addTarget(definition);
    await this.adapters.get(targetId).start();await this.refresh(targetId);
    this.store.appendEvent('task.handoff',{sourceTaskId:task.id,targetTaskId:targetId,provider,sourceSessionId:task.sessionId,commandId:input.id},{taskId:task.id});
    return {status:'accepted',targetTaskId:targetId,provider,acceptance:'unreviewed'};
  }

  async startTarget(client,id){
    this.owner(client);const definition=this.definitions.get(id);if(definition?.adapter!=='managed')throw fail('只有本地配置的托管 CLI 可启动',409);
    if(this.locks.has(id))throw fail('任务正在处理命令',409);
    this.locks.add(id);try{await this.withWriter(id,()=>this.adapters.get(id).start());return await this.refresh(id);}finally{this.locks.delete(id);}
  }
  async reconcile(client,id){
    const command=this.commandFor(client,id);if(command.status!=='unknown')return command;
    const adapter=this.adapters.get(command.input.taskId);
    if(!adapter?.reconcile)return command;
    const result=await adapter.reconcile(command.input,this.taskFor(client,command.input.taskId));
    if(result?.status&&result.status!=='unknown')this.store.updateCommand(id,{status:this.receiptState(command.input,result),result});
    return this.store.getCommand(id);
  }
  async close(){
    if(this.closed)return;this.closed=true;clearInterval(this.timer);
    await Promise.allSettled([...this.adapters.values()].map(a=>a.close?.()));
    await Promise.allSettled([...this.jobs]);this.store.close();
  }
}
