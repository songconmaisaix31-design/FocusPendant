import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createService} from '../core/server.mjs';

const ownerToken='owner-token-for-remote-tests-only';
function adapter(projectId='p1'){
  let calls=0,available=true;
  const state={adapter:'swa',provider:'pi',title:'原任务',projectId,sessionId:'session-one',status:'waiting_input',acceptance:'unreviewed',
    questions:[{id:'question-one',text:'使用哪一个数据库？',kind:'question',dispatchId:'dispatch-one'}],capabilities:{answer:true,resume:false,interrupt:false,handoff:false},capture:'snapshot_diff'};
  return {get calls(){return calls;},state,set available(value){available=value;},async read(){if(!available)throw new Error('fixture disconnected');return structuredClone(state);},
    async execute(command){calls++;state.status='running';state.questions=[];state.capabilities.answer=false;return {status:'answered',readState:'read_observed',requestId:command.id};}};
}
async function fixture(t,{adapters={one:adapter()},dataDir:existing,now}={}){
  const dataDir=existing||fs.mkdtempSync(path.join(os.tmpdir(),'focus-remote-http-'));
  const service=createService({dataDir,token:ownerToken,remoteOptions:{adapters,pollIntervalMs:60000,...(now?{now}:{})}});
  await service.remoteReady;service.server.listen(0,'127.0.0.1');await once(service.server,'listening');
  const base=`http://127.0.0.1:${service.server.address().port}`;
  let closed=false;
  async function close(){if(closed)return;closed=true;service.server.closeAllConnections();await new Promise((resolve,reject)=>service.server.close(e=>e?reject(e):resolve()));}
  t.after(async()=>{await close();if(!existing)fs.rmSync(dataDir,{recursive:true,force:true});});
  async function call(route,body,token=ownerToken,headers={}){return fetch(base+route,{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:`Bearer ${token}`} : {}),'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});}
  async function pair(scopes=['read','answer'],projects=[]){const issued=await(await call('/api/remote/admin/pairings',{scopes,projectIds:projects})).json();return (await call('/api/remote/pair',{code:issued.code,label:'手机'},null)).json();}
  return {...service,base,call,pair,close,dataDir,adapters};
}
const answer=(task,now=Date.now())=>({id:randomUUID(),taskId:task.id,action:'answer',expectedRevision:task.revision,sessionId:task.sessionId,questionId:'question-one',dispatchId:'dispatch-one',expiresAt:now+60000,payload:{answer:'SQLite'}});
async function settle(remote){await Promise.allSettled([...remote.jobs]);}

test('paired project scope, same-origin controls and revocation isolate remote and personal APIs',async t=>{
  const f=await fixture(t,{adapters:{one:adapter('p1'),two:adapter('p2')}}),paired=await f.pair(['read'],['p1']);
  assert.equal((await f.call('/api/remote/snapshot',undefined,null)).status,401);
  const snapshot=await(await f.call('/api/remote/snapshot',undefined,paired.token)).json();assert.deepEqual(snapshot.tasks.map(x=>x.id),['one']);
  assert.equal((await f.call('/api/state',undefined,paired.token)).status,401);
  assert.equal((await f.call('/api/remote/admin/devices',undefined,paired.token)).status,403);
  assert.equal((await f.call('/api/remote/commands',answer(snapshot.tasks[0]),paired.token)).status,403);
  assert.equal((await f.call('/api/remote/admin/pairings',{},ownerToken,{Origin:'https://other.example'})).status,403);
  await f.call('/api/remote/admin/revoke',{deviceId:paired.device.id});
  assert.equal((await f.call('/api/remote/snapshot',undefined,paired.token)).status,401);
});

test('answer consumes the exact original question once, repeat returns original receipt and mismatched payload rejects',async t=>{
  const f=await fixture(t),paired=await f.pair(),snapshot=await(await f.call('/api/remote/snapshot',undefined,paired.token)).json();
  const input=answer(snapshot.tasks[0]);
  const first=await f.call('/api/remote/commands',input,paired.token);assert.equal(first.status,202);await settle(f.remote);
  const receipt=await(await f.call(`/api/remote/commands/${input.id}`,undefined,paired.token)).json();assert.equal(receipt.status,'consumed');
  assert.equal((await f.call('/api/remote/commands',input,paired.token)).status,202);assert.equal(f.adapters.one.calls,1);
  assert.equal((await f.call('/api/remote/commands',{...input,payload:{answer:'Postgres'}},paired.token)).status,409);
  const current=await(await f.call('/api/remote/snapshot',undefined,paired.token)).json();assert.equal(current.tasks[0].status,'running');
  const other=await f.pair();assert.equal((await f.call(`/api/remote/commands/${input.id}`,undefined,other.token)).status,404);
  const events=await(await f.call('/api/remote/events?after=0',undefined,other.token)).json();assert.ok(events.events.every(e=>!e.type.startsWith('command.')));
});

test('wrong revision/session/question/dispatch and expired or disconnected commands never reach runtime',async t=>{
  let now=Date.now();const f=await fixture(t,{now:()=>now}),paired=await f.pair();
  const task=f.remote.store.getTask('one'),input=answer(task,now);
  for(const change of [{expectedRevision:0},{sessionId:'other'},{questionId:'other'},{dispatchId:'other'},{expiresAt:now-1}]){
    assert.equal((await f.call('/api/remote/commands',{...input,id:randomUUID(),...change},paired.token)).status,409);
  }
  f.adapters.one.available=false;await f.remote.poll();
  const snapshot=await(await f.call('/api/remote/snapshot',undefined,paired.token)).json();
  assert.equal(snapshot.tasks[0].status,'waiting_input');assert.equal(snapshot.tasks[0].freshness,'offline');
  assert.equal((await f.call('/api/remote/commands',input,paired.token)).status,409);assert.equal(f.adapters.one.calls,0);
  f.adapters.one.available=true;now+=1000;await f.remote.poll();assert.equal(f.remote.store.getTask('one').freshness,'connected');
});

test('lost response and server restart preserve unknown receipt instead of rerunning the native action',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'focus-remote-restart-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=adapter();a.execute=async()=>({status:'unknown'});
  const f=await fixture(t,{dataDir:dir,adapters:{one:a}}),paired=await f.pair(),input=answer(f.remote.store.getTask('one'));
  await f.call('/api/remote/commands',input,paired.token);await settle(f.remote);await f.close();
  const after=adapter(),restarted=await fixture(t,{dataDir:dir,adapters:{one:after}});
  const receipt=await(await restarted.call('/api/remote/commands',input,paired.token)).json();assert.equal(receipt.status,'unknown');assert.equal(after.calls,0);
  await restarted.close();
});
