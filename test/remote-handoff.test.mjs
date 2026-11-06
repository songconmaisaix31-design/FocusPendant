import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn, execFileSync} from 'node:child_process';
import {RemoteController} from '../core/remote/controller.mjs';

async function waitFor(read,predicate,timeout=6000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){const state=await read();if(predicate(state))return state;await new Promise(r=>setTimeout(r,20));}
  throw new Error('Timed out waiting for controller lifecycle');
}

function workspace(t) {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'focus-handoff-'));
  const cwd=path.join(base,'repo'),dataDir=path.join(base,'data');
  fs.mkdirSync(path.join(cwd,'a'),{recursive:true});fs.mkdirSync(path.join(cwd,'b'));
  fs.writeFileSync(path.join(cwd,'a','source.txt'),'baseline\n');fs.writeFileSync(path.join(cwd,'b','source.txt'),'baseline\n');
  const git=(...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('add','.');git('commit','-qm','baseline');
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  return {base,cwd,dataDir};
}

function codexSpawn(calls,{live=false}={}) {
  return (executable,args,options)=>{
    calls.push({executable,args,options});
    return spawn(process.execPath,['-e',`console.log(JSON.stringify({type:'thread.started',thread_id:'codex-session'}));console.log(JSON.stringify({type:'turn.started'}));${live?'setInterval(()=>{},1000);':"setTimeout(()=>{console.log(JSON.stringify({type:'turn.completed'}));},30);"}`],options);
  };
}

function claudeSpawn(calls,proofFile,{live=false}={}) {
  return (executable,args,options)=>{
    calls.push({executable,args,options});
    const prompt=args.at(-1),cardPath=prompt.match(/交接材料在本机文件 (.*?)。/)?.[1];
    assert.ok(cardPath,'target prompt references the saved handoff card');
    const script=`const fs=require('node:fs');const card=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));fs.writeFileSync(process.argv[2],JSON.stringify({cwd:process.cwd(),goal:card.goal,todos:card.todos,sourceTrace:card.sourceTrace,head:card.workspace.head}));console.log(JSON.stringify({type:'system',subtype:'init',session_id:'claude-session'}));${live?'setInterval(()=>{},1000);':"console.log(JSON.stringify({type:'result',subtype:'success',session_id:'claude-session'}));"}`;
    return spawn(process.execPath,['-e',script,cardPath,proofFile],options);
  };
}

async function controllerFixture(t,{live=false,targetSettings={},sourceCwd}={}) {
  const dirs=workspace(t),sourceCalls=[],targetCalls=[],proofFile=path.join(dirs.base,'target-proof.json');
  const config={targets:[{id:'source',adapter:'managed',provider:'codex',cwd:sourceCwd?path.join(dirs.cwd,sourceCwd):dirs.cwd,projectId:'project',title:'原任务',prompt:'修复源文件并验证',autoStart:true,spawnImpl:codexSpawn(sourceCalls,{live})}],
    handoffProviders:{claude:{model:'fixture-model',spawnImpl:claudeSpawn(targetCalls,proofFile),...targetSettings}}};
  const controller=new RemoteController({dataDir:dirs.dataDir,ownerToken:'owner-token-at-least-16',config,pollIntervalMs:100});
  t.after(()=>controller.close());
  const owner=controller.authenticate('Bearer owner-token-at-least-16');
  await controller.start();
  await waitFor(()=>controller.refresh('source'),s=>s.sessionId==='codex-session'&&(live?s.status==='running':s.status==='completed'));
  return {...dirs,controller,owner,sourceCalls,targetCalls,proofFile};
}

async function command(controller,owner,action,payload={},taskId='source') {
  const task=await controller.refresh(taskId);
  const input={id:randomUUID(),taskId,action,payload,sessionId:task.sessionId,expectedRevision:task.revision,expiresAt:Date.now()+60000};
  await controller.submit(owner,input);
  const receipt=await waitFor(()=>controller.store.getCommand(input.id),c=>['completed','failed','rejected','unknown'].includes(c?.status));
  return {input,receipt};
}

test('controller hands a stopped source to a fresh provider session using the saved local card',async t=>{
  const f=await controllerFixture(t,{targetSettings:{sessionId:'must-not-resume',recoverable:true}});
  fs.writeFileSync(path.join(f.cwd,'a','source.txt'),'source implementation\n');
  const head=execFileSync('git',['-C',f.cwd,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const {input,receipt}=await command(f.controller,f.owner,'handoff',{provider:'claude',input:'补充验证',done:['完成源文件修改'],artifacts:['a/source.txt']});
  assert.equal(receipt.status,'completed',receipt.error);
  assert.equal(f.targetCalls.length,1);
  assert.equal(f.targetCalls[0].args.includes('--resume'),false,'handoff must not inherit a configured previous session');
  const targetId=receipt.result.targetTaskId;
  const target=await waitFor(()=>f.controller.refresh(targetId),s=>s.status==='completed');
  assert.equal(target.provider,'claude');assert.equal(target.sessionId,'claude-session');assert.equal(target.acceptance,'unreviewed');assert.equal(target.projectId,'project');
  const proof=JSON.parse(fs.readFileSync(f.proofFile,'utf8'));
  assert.equal(proof.cwd,f.cwd);assert.equal(proof.goal,'修复源文件并验证');assert.deepEqual(proof.todos,['补充验证']);assert.equal(proof.head,head);assert.match(proof.sourceTrace[0],/codex-session/);
  const source=f.controller.store.getTask('source');assert.equal(source.metadata.writerReleased,true);
  const again=await f.controller.submit(f.owner,input);assert.equal(again.id,input.id);assert.equal(f.targetCalls.length,1);
});

test('live source cannot handoff until its interrupt command observes real child exit',async t=>{
  const f=await controllerFixture(t,{live:true});
  const current=await f.controller.refresh('source');
  assert.equal(current.capabilities.handoff,false);
  await assert.rejects(f.controller.submit(f.owner,{id:randomUUID(),taskId:'source',action:'handoff',payload:{provider:'claude'},sessionId:current.sessionId,expectedRevision:current.revision,expiresAt:Date.now()+60000}),/不支持/);
  assert.equal(f.targetCalls.length,0);
  const stopped=await command(f.controller,f.owner,'interrupt');assert.equal(stopped.receipt.status,'completed');
  assert.equal(f.controller.store.getTask('source').metadata.writerReleased,true);
  const handed=await command(f.controller,f.owner,'handoff',{provider:'claude'});assert.equal(handed.receipt.status,'completed',handed.receipt.error);
  await waitFor(()=>f.controller.refresh(handed.receipt.result.targetTaskId),s=>s.status==='completed');
});

test('workspace mutation after card capture rejects handoff and leaves no registered target',async t=>{
  const f=await controllerFixture(t);
  const original=fs.writeFileSync;let injected=false;
  fs.writeFileSync=function(filename,...args){
    const result=original.call(fs,filename,...args);
    if(!injected&&String(filename).includes(`${path.sep}handoffs${path.sep}`)&&String(filename).endsWith('.json.tmp')){
      injected=true;original(path.join(f.cwd,'a','source.txt'),'changed after capture\n');
    }
    return result;
  };
  let outcome;
  try{outcome=await command(f.controller,f.owner,'handoff',{provider:'claude'});}finally{fs.writeFileSync=original;}
  assert.equal(injected,true);assert.equal(outcome.receipt.status,'rejected');assert.match(outcome.receipt.error,/工作区已变化/);assert.equal(f.targetCalls.length,0);
  assert.equal([...f.controller.adapters.keys()].filter(id=>id.startsWith('handoff-')).length,0);
  const saved=fs.existsSync(f.controller.handoffFile)?JSON.parse(fs.readFileSync(f.controller.handoffFile,'utf8')):[];
  assert.equal(saved.length,0,'rejected verification must not create a recovered target on next startup');
});

test('writer exclusion covers different subdirectories of one Git worktree',async t=>{
  const dirs=workspace(t),calls=[];
  const targets=['a','b'].map((folder,index)=>({id:`worker-${index}`,adapter:'managed',provider:'codex',cwd:path.join(dirs.cwd,folder),projectId:'project',prompt:'检查',spawnImpl:codexSpawn(calls,{live:true})}));
  const controller=new RemoteController({dataDir:dirs.dataDir,ownerToken:'owner-token-at-least-16',config:{targets},pollIntervalMs:100});
  t.after(()=>controller.close());await controller.start();
  const owner=controller.authenticate('Bearer owner-token-at-least-16');
  await controller.startTarget(owner,'worker-0');
  await waitFor(()=>controller.refresh('worker-0'),s=>s.sessionId==='codex-session');
  await assert.rejects(controller.startTarget(owner,'worker-1'),/工作区|worktree/);
  assert.equal(calls.length,1);
});

test('controller resume routes the explicit native session and reuses the same command receipt',async t=>{
  const f=await controllerFixture(t);
  const {input,receipt}=await command(f.controller,f.owner,'resume',{input:'继续验证'});
  assert.equal(receipt.status,'completed',receipt.error);assert.equal(f.sourceCalls.length,2);
  const args=f.sourceCalls[1].args;assert.ok(args.includes('resume'));assert.ok(args.includes('codex-session'));assert.equal(args.includes('--last'),false);
  const again=await f.controller.submit(f.owner,input);assert.equal(again.id,input.id);assert.equal(f.sourceCalls.length,2);
});
