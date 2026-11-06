import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {ManagedAdapter,managedCommand,normalizeManagedEvent,captureHandoff,verifyWorkspaceCheckpoint,handoffPrompt} from '../core/remote/managed.mjs';

function setup(t) {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'focus-managed-'));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  return cwd;
}
async function until(read,predicate,timeout=4000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const value=await read();if(predicate(value))return value;await new Promise(r=>setTimeout(r,15));}
  throw new Error('Timed out waiting for child lifecycle');
}
function fixture(t,provider,script,extra={}) {
  const cwd=setup(t),calls=[],events=[];
  const adapter=new ManagedAdapter({provider,cwd,prompt:'检查工作区',onUpdate:(s,e)=>events.push({s,e}),spawnImpl:(exe,args,options)=>{calls.push({exe,args,options});return spawn(process.execPath,['-e',script],options);},...extra});
  t.after(()=>adapter.close());
  return {adapter,cwd,calls,events};
}

test('managed command args preserve explicit IDs, prompt boundaries and native permission defaults',()=>{
  for(const provider of ['codex','claude','gemini','opencode']) {
    const args=managedCommand({provider,prompt:'--dangerously-skip-permissions',sessionId:'session-123',model:'vendor/model'});
    assert.ok(args.includes('session-123'));
    assert.equal(args.includes('--last'),false);
    assert.equal(args.includes('--continue'),false);
    assert.equal(args.includes('--auto'),false);
    assert.equal(provider==='gemini'?args.at(-1):args.at(-2),provider==='gemini'?'--prompt=--dangerously-skip-permissions':'--');
  }
  assert.throws(()=>managedCommand({provider:'codex',prompt:'x',sessionId:'--last'}),/会话/);
  assert.throws(()=>managedCommand({provider:'codex',prompt:'x',sandbox:'danger-full-access'}),/托管模式/);
});

test('Codex child JSONL chunks capture session, native turn end and process exit separately',async t=>{
  const script=`process.stdout.write('{"type":"thread.star');setTimeout(()=>{process.stdout.write('ted","thread_id":"codex-123"}\\n');process.stdout.write(JSON.stringify({type:'turn.started'})+'\\n');process.stdout.write('not-json\\n');process.stderr.write('TOKEN=never-publish');process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');setTimeout(()=>process.exit(0),100);},10);`;
  const {adapter,events}=fixture(t,'codex',script);
  await adapter.start();
  const turn=await until(()=>adapter.read(),s=>s.metadata.turnStatus==='completed');
  assert.equal(turn.status,'running');assert.equal(turn.capabilities.resume,false);
  const result=await until(()=>adapter.read(),s=>!s.metadata.processAlive);
  assert.equal(result.status,'completed');assert.equal(result.acceptance,'unreviewed');assert.equal(result.sessionId,'codex-123');assert.equal(result.metadata.malformedLines,1);assert.equal(result.metadata.exitCode,0);assert.equal(result.capabilities.resume,true);assert.equal(result.capabilities.answer,false);
  assert.equal(JSON.stringify(events).includes('never-publish'),false);
});

test('zero exit with no final native event remains unknown; nonzero exit is failed',async t=>{
  const one=fixture(t,'gemini',`console.log(JSON.stringify({type:'init',session_id:'gemini-123'}));`);
  await one.adapter.start();
  const unknown=await until(()=>one.adapter.read(),s=>!s.metadata.processAlive);
  assert.equal(unknown.status,'unknown');assert.equal(unknown.metadata.exitCode,0);
  const two=fixture(t,'claude',`console.log(JSON.stringify({type:'system',subtype:'init',session_id:'claude-123'}));process.exit(42);`);
  await two.adapter.start();assert.equal((await until(()=>two.adapter.read(),s=>!s.metadata.processAlive)).status,'failed');
});

test('normalizers do not mistake child Claude sessions, tool calls or questions for accepted goals',()=>{
  assert.equal(normalizeManagedEvent('claude',{type:'assistant',parent_tool_use_id:'child',session_id:'different'}).sessionId,undefined);
  assert.equal(normalizeManagedEvent('claude',{type:'result',subtype:'success',session_id:'main'}).turnStatus,'completed');
  assert.equal(normalizeManagedEvent('claude',{type:'result',subtype:'error_max_turns',is_error:true}).turnStatus,'failed');
  assert.equal(normalizeManagedEvent('gemini',{type:'result',status:'success'}).turnStatus,'completed');
  assert.equal(normalizeManagedEvent('opencode',{type:'step_finish',sessionID:'ses_a',part:{reason:'tool-calls'}}).turnStatus,undefined);
  assert.equal(normalizeManagedEvent('opencode',{type:'step_finish',sessionID:'ses_a',part:{reason:'stop'}}).turnStatus,'completed');
});

test('resume binds original session and repeated command returns original receipt without spawning',async t=>{
  const {adapter,calls}=fixture(t,'codex',`console.log(JSON.stringify({type:'thread.started',thread_id:'codex-123'}));console.log(JSON.stringify({type:'turn.completed'}));`);
  await adapter.start();await until(()=>adapter.read(),s=>!s.metadata.processAlive);
  await assert.rejects(adapter.execute({id:'wrong',action:'resume',sessionId:'other',payload:{input:'继续'}}),/会话/);
  const command={id:'resume-1',action:'resume',sessionId:'codex-123',payload:{input:'继续处理'}};
  const result=await adapter.execute(command);
  assert.equal(result.status,'executing');assert.equal(calls.length,2);assert.ok(calls[1].args.includes('resume'));assert.ok(calls[1].args.includes('codex-123'));
  assert.deepEqual(await adapter.execute(command),result);assert.equal(calls.length,2);
  await assert.rejects(adapter.execute({...command,payload:{input:'changed'}}),/内容不一致/);
  await until(()=>adapter.read(),s=>!s.metadata.processAlive);
  assert.equal((await adapter.reconcile(command)).status,'completed');
});

test('interrupt waits for owned process exit before allowing resume or handoff',async t=>{
  const {adapter}=fixture(t,'gemini',`console.log(JSON.stringify({type:'init',session_id:'gemini-live'}));setInterval(()=>{},1000);`,{stopTimeoutMs:100});
  await adapter.start();await until(()=>adapter.read(),s=>s.sessionId==='gemini-live');
  assert.equal((await adapter.read()).capabilities.handoff,false);
  const result=await adapter.execute({id:'stop-1',action:'interrupt',sessionId:'gemini-live'});
  assert.equal(result.stopped,true);const state=await adapter.read();assert.equal(state.status,'blocked');assert.equal(state.metadata.turnStatus,'interrupted');assert.equal(state.capabilities.handoff,true);
});

test('restarted adapter cannot resume an unconfirmed old writer; changed session output remains unknown',async t=>{
  const cwd=setup(t);
  const recovered=new ManagedAdapter({provider:'codex',cwd,prompt:'继续',sessionId:'old'});t.after(()=>recovered.close());
  assert.equal((await recovered.read()).capabilities.resume,false);
  await assert.rejects(recovered.start(),/旧进程状态未知/);
  const {adapter}=fixture(t,'codex',`console.log(JSON.stringify({type:'thread.started',thread_id:'different'}));setTimeout(()=>{},1000);`,{sessionId:'old',recoverable:true});
  await adapter.start();
  assert.equal((await until(()=>adapter.read(),s=>!s.metadata.processAlive)).status,'unknown');
});

test('oversized JSONL is bounded and skipped, then subsequent valid records are read',async t=>{
  const {adapter}=fixture(t,'gemini',`process.stdout.write('x'.repeat(1200000)+'\\n');console.log(JSON.stringify({type:'init',session_id:'gemini-123'}));console.log(JSON.stringify({type:'result',status:'success'}));`);
  await adapter.start();const result=await until(()=>adapter.read(),s=>!s.metadata.processAlive);
  assert.equal(result.status,'completed');assert.equal(result.metadata.malformedLines,1);assert.equal(result.sessionId,'gemini-123');
});

test('handoff captures tracked and untracked checkpoint without committing; target must match',async t=>{
  const cwd=setup(t);
  const git=(...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(cwd,'file.txt'),'before\n');git('add','file.txt');git('commit','-qm','baseline');const head=git('rev-parse','HEAD');
  fs.writeFileSync(path.join(cwd,'file.txt'),'after\n');fs.writeFileSync(path.join(cwd,'new.txt'),'new material');
  const handoff=await captureHandoff({cwd,goal:'修复问题',done:['已定位'],todos:['验证修改'],artifacts:['file.txt'],sourceTrace:['event:123']});
  assert.equal(handoff.workspace.head,head);assert.match(handoff.workspace.diff,/after/);assert.equal(handoff.workspace.untracked[0].path,'new.txt');assert.equal(git('rev-parse','HEAD'),head);
  await verifyWorkspaceCheckpoint(cwd,handoff.workspace);assert.match(handoffPrompt(handoff),/修复问题/);assert.equal(handoffPrompt(handoff).includes('diff --git'),false);
  fs.writeFileSync(path.join(cwd,'new.txt'),'changed');await assert.rejects(verifyWorkspaceCheckpoint(cwd,handoff.workspace),/工作区已变化/);
});
