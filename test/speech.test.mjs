import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createService} from '../core/server.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function wav(){const b=Buffer.alloc(364);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(320,40);return b;}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}
async function upstream(t,handler){
  const server=http.createServer(async(req,res)=>{const chunks=[];for await(const part of req)chunks.push(part);await handler(req,res,Buffer.concat(chunks));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  return `http://127.0.0.1:${server.address().port}`;
}
async function service(t,options={}){
  const dataDir=options.dataDir||fs.mkdtempSync(path.join(os.tmpdir(),'focus-speech-'));
  const app=createService({dataDir,...options});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{if(app.server.listening){app.server.closeAllConnections();await new Promise(r=>app.server.close(r));}fs.rmSync(dataDir,{recursive:true,force:true});});
  const headers=options.token?{Authorization:`Bearer ${options.token}`} : {};
  const call=(url,payload)=>fetch(base+url,{method:payload===undefined?'GET':'POST',headers:{...headers,...(payload===undefined?{}:{'Content-Type':'application/json'})},body:payload===undefined?undefined:JSON.stringify(payload)});
  const record=()=>fetch(base+'/api/voice',{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream'},body:Buffer.alloc(3200)});
  const state=async()=>await (await call('/api/state')).json();
  return {...app,base,headers,call,record,state};
}
async function waitFor(check,message='condition did not become true'){
  const deadline=Date.now()+3000;
  while(Date.now()<deadline){const value=await check();if(value)return value;await delay(10);}
  assert.fail(message);
}

test('background local ASR updates the same note, export, Markdown and durable state',async t=>{
  let requests=0;
  const url=await upstream(t,(req,res,audio)=>{
    requests++;assert.equal(req.url,'/transcribe');assert.equal(req.headers.authorization,'Bearer local-secret-12345');
    assert.equal(req.headers['content-type'],'audio/wav');assert.equal(audio.subarray(0,4).toString(),'RIFF');
    json(res,200,{text:'今天读完了第二章。',backend:'local-whisper',language:'zh'});
  });
  const app=await service(t,{speechURL:url,token:'local-secret-12345'});
  const response=await app.record();assert.equal(response.status,201);const saved=await response.json();assert.equal(saved.status,'saved');
  const note=await waitFor(async()=>{const s=await app.state();return s.notes.find(n=>n.voice?.id===saved.id&&n.voice.status==='transcribed');});
  assert.equal(note.voice.transcript,'今天读完了第二章。');assert.match(note.text,/今天读完了第二章/);
  const exported=await (await app.call('/api/export')).json();assert.equal(exported.notes.length,1);assert.equal(exported.stats.checkins,1);
  assert.match(await (await app.call('/api/report')).text(),/今天读完了第二章/);
  const disk=JSON.parse(fs.readFileSync(path.join(app.dataDir,'state.json'),'utf8'));assert.equal(Object.values(disk.days).flatMap(d=>d.notes)[0].voice.status,'transcribed');
  assert.equal((await app.call('/api/transcribe',{voiceId:saved.id})).status,200);assert.equal(requests,1);
});

test('missing local ASR preserves WAV and retry updates one existing checkin without duplicate work',async t=>{
  let requests=0;const retryArrived=deferred(),release=deferred();
  const url=await upstream(t,async(_req,res)=>{
    requests++;if(requests===1)return json(res,503,{error:'模型未准备'});
    retryArrived.resolve();await release.promise;json(res,200,{text:'重试成功',backend:'local-whisper'});
  });
  const app=await service(t,{speechURL:url});const saved=await (await app.record()).json();
  await waitFor(async()=>{const s=await app.state();return s.notes[0]?.voice.status==='unavailable';});
  const audio=await app.call(saved.url);assert.equal(audio.status,200);assert.equal((await audio.arrayBuffer()).byteLength,3244);
  assert.equal((await app.call('/api/transcribe',{voiceId:saved.id})).status,202);await retryArrived.promise;
  assert.equal((await app.call('/api/transcribe',{voiceId:saved.id})).status,202);assert.equal(requests,2);release.resolve();
  const s=await waitFor(async()=>{const s=await app.state();return s.notes[0]?.voice.status==='transcribed'&&s;});
  assert.equal(s.notes.length,1);assert.equal(s.stats.checkins,1);assert.equal(s.notes[0].voice.transcript,'重试成功');assert.equal(requests,2);
});

test('local TTS browser audio is authenticated and Iris playback is acknowledged separately',async t=>{
  const spoken=[];const url=await upstream(t,(req,res,payload)=>{assert.equal(req.url,'/synthesize');spoken.push(JSON.parse(payload).text);res.writeHead(200,{'Content-Type':'audio/wav'});res.end(wav());});
  const app=await service(t,{speechURL:url,token:'speech-secret-1234'});
  const browser=await app.call('/api/speech',{target:'browser',text:'开始今天的复盘。'});assert.equal(browser.status,201);const b=await browser.json();
  assert.equal((await app.state()).speech,null);assert.equal((await fetch(app.base+b.url)).status,401);
  const audio=await app.call(b.url);assert.equal(audio.headers.get('content-type'),'audio/wav');assert.equal((await audio.arrayBuffer()).byteLength,364);
  const iris=await app.call('/api/speech',{target:'iris',text:'请在眼镜上播放。'});assert.equal(iris.status,201);const i=await iris.json();
  assert.equal((await app.state()).speech.id,i.id);assert.equal((await app.state()).speech.status,'ready');
  await app.call('/api/speech/ack',{id:i.id,status:'started'});assert.equal((await app.state()).speech.status,'started');
  await app.call('/api/speech/ack',{id:'other',status:'completed'});assert.equal((await app.state()).speech.status,'started');
  await app.call('/api/speech/ack',{id:i.id,status:'completed'});assert.equal((await app.state()).speech.status,'completed');
  assert.deepEqual(spoken,['开始今天的复盘。','请在眼镜上播放。']);
});

test('ASR and TTS share a serial local inference queue',async t=>{
  const asrArrived=deferred(),release=deferred();const sequence=[];
  const url=await upstream(t,async(req,res)=>{
    sequence.push(req.url);if(req.url==='/transcribe'){asrArrived.resolve();await release.promise;json(res,200,{text:'一句笔记'});}
    else{res.writeHead(200,{'Content-Type':'audio/wav'});res.end(wav());}
  });
  const app=await service(t,{speechURL:url});await app.record();await asrArrived.promise;
  const speech=app.call('/api/speech',{target:'browser',text:'复盘'});await delay(30);assert.deepEqual(sequence,['/transcribe']);
  release.resolve();assert.equal((await speech).status,201);assert.deepEqual(sequence,['/transcribe','/synthesize']);
});

test('speech endpoint must be local and a redirect cannot forward recordings to another endpoint',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'focus-invalid-speech-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  assert.throws(()=>createService({dataDir:dir,speechURL:'https://example.com/speech'}),/本机 localhost/);
  let redirected=0;const destination=await upstream(t,(_req,res)=>{redirected++;json(res,200,{text:'不该到达这里'});});
  const redirect=await upstream(t,(_req,res)=>{res.writeHead(307,{Location:destination+'/transcribe'});res.end();});
  const app=await service(t,{speechURL:redirect});await app.record();
  const s=await waitFor(async()=>{const s=await app.state();return ['error','unavailable'].includes(s.notes[0]?.voice.status)&&s;});
  assert.equal(redirected,0);assert.equal(s.notes[0].voice.transcript,null);
});

test('an Iris playback request cannot overwrite audio being generated, waiting, or playing',async t=>{
  const arrived=deferred(),release=deferred();let requests=0;
  const url=await upstream(t,async(_req,res)=>{requests++;arrived.resolve();await release.promise;res.writeHead(200,{'Content-Type':'audio/wav'});res.end(wav());});
  t.after(()=>release.resolve());
  const app=await service(t,{speechURL:url});
  const first=app.call('/api/speech',{target:'iris',text:'第一条复盘'});await arrived.promise;
  assert.equal((await app.call('/api/speech',{target:'iris',text:'生成期间第二条'})).status,409);
  release.resolve();const response=await first;assert.equal(response.status,201);const original=await response.json();
  assert.equal((await app.call('/api/speech',{target:'iris',text:'等待期间第二条'})).status,409);
  await app.call('/api/speech/ack',{id:original.id,status:'started'});
  assert.equal((await app.call('/api/speech',{target:'iris',text:'播放期间第二条'})).status,409);
  assert.equal((await app.state()).speech.id,original.id);assert.equal(requests,1);
  await app.call('/api/speech/ack',{id:original.id,status:'completed'});
  assert.equal((await app.call('/api/speech',{target:'iris',text:'播放完成后第二条'})).status,201);assert.equal(requests,2);
});

test('server shutdown aborts in-flight synthesis before waiting for HTTP connections to close',async t=>{
  const arrived=deferred(),release=deferred();
  const url=await upstream(t,async(_req,res)=>{arrived.resolve();await release.promise;if(!res.destroyed){res.writeHead(200,{'Content-Type':'audio/wav'});res.end(wav());}});
  t.after(()=>release.resolve());
  const app=await service(t,{speechURL:url});const pending=app.call('/api/speech',{target:'browser',text:'关闭测试'});
  await arrived.promise;
  let timer;
  try {
    const closed=new Promise(resolve=>app.server.close(resolve));
    await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('shutdown did not abort the speech request')),2000);})]);
    assert.equal((await pending).status,503);assert.equal(app.server.listening,false);
  } finally {clearTimeout(timer);release.resolve();}
});
