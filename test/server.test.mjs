import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createService} from '../core/server.mjs';

async function fixture(t,options={}){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'focus-http-'));
  const service=createService({dataDir,...options});service.server.listen(0,'127.0.0.1');await once(service.server,'listening');
  const base=`http://127.0.0.1:${service.server.address().port}`;
  t.after(async()=>{service.server.closeAllConnections();await new Promise(r=>service.server.close(r));fs.rmSync(dataDir,{recursive:true,force:true});});
  const call=(p,body,headers={})=>fetch(base+p,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  return {...service,base,call};
}

test('HTTP timer, event, correction, export and persisted state round trip',async t=>{
  const {call,engine,dataDir}=await fixture(t);
  assert.equal((await call('/api/state')).status,200);
  assert.equal((await call('/api/action',{action:'mode',mode:'flow'})).status,200);
  assert.equal((await call('/api/events',{type:'window',app:'Code',windowId:'a',ts:Date.now()})).status,200);
  assert.equal((await call('/api/action',{action:'start',text:'检查接口'})).status,200);
  assert.equal((await call('/api/action',{action:'checkin',text:'已实现主流程'})).status,200);
  const s=await (await call('/api/export')).json();assert.equal(s.stats.checkins,1);assert.equal(s.notes[0].text,'已实现主流程');
  const md=await (await call('/api/report')).text();assert.match(md,/已实现主流程/);assert.match(md,/不是对认知注意力的测量/);
  const saved=JSON.parse(fs.readFileSync(path.join(dataDir,'state.json'),'utf8'));
  assert.equal(saved.session.intent,'检查接口');assert.equal(saved.modeRequested,'flow');
  assert.equal((await call('/events',{type:'window',app:'Code',ts:Date.now()-121000})).status,400);
});

test('optional token and same-origin controls protect personal state/actions',async t=>{
  const {call,base}=await fixture(t,{token:'test-token-at-least-16'});
  assert.equal((await call('/api/state')).status,401);
  const headers={Authorization:'Bearer test-token-at-least-16'};
  assert.equal((await call('/api/state',undefined,headers)).status,200);
  assert.equal((await call('/api/action',{action:'start'},{...headers,Origin:'https://unrelated.example'})).status,403);
  assert.equal((await call('/api/action',{action:'start'},{...headers,Origin:base})).status,200);
});

test('PCM recording uploads as playable WAV and creates a local-only untranscribed checkin',async t=>{
  const {call,base}=await fixture(t);const pcm=Buffer.alloc(3200);
  const response=await fetch(base+'/api/voice',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Audio-Sample-Rate':'16000'},body:pcm});
  assert.equal(response.status,201);const saved=await response.json();assert.equal(saved.transcript,null);
  const audio=await fetch(base+saved.url);assert.equal(audio.headers.get('content-type'),'audio/wav');
  const bytes=Buffer.from(await audio.arrayBuffer());assert.equal(bytes.subarray(0,4).toString(),'RIFF');assert.equal(bytes.length,3244);
  assert.equal(bytes.readUInt32LE(24),16000);assert.equal(bytes.readUInt16LE(22),1);
  const s=await (await call('/api/state')).json();assert.equal(s.stats.checkins,1);assert.equal(s.notes[0].voice.id,saved.id);
  assert.equal((await fetch(base+'/api/voice',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Buffer.alloc(1)})).status,400);
});

test('camera disabled blocks upload; local-only header is forwarded; closing camera discards in-flight result',async t=>{
  let observedHeader=null,resolveArrival;const arrival=new Promise(r=>resolveArrival=r);let release;
  const upstream=http.createServer((req,res)=>{observedHeader=req.headers['x-focus-local-only'];req.resume();req.on('end',()=>{release=()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({scene:'reading',confidence:.9,objects:[],backend:'fake-local',observed:true}));};resolveArrival();});});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  t.after(async()=>{upstream.closeAllConnections();await new Promise(r=>upstream.close(r));});
  const {base,call}=await fixture(t,{visionURL:`http://127.0.0.1:${upstream.address().port}`});
  const frame=Buffer.from([255,216,255,217]);const send=()=>fetch(base+'/api/frame',{method:'POST',headers:{'Content-Type':'image/jpeg'},body:frame});
  assert.equal((await send()).status,409);
  await call('/api/action',{action:'settings',settings:{cameraEnabled:true}});
  const pending=send();await arrival;assert.equal(observedHeader,'true');
  await call('/api/action',{action:'settings',settings:{cameraEnabled:false}});release();
  const outcome=await (await pending).json();assert.equal(outcome.observed,false);assert.match(outcome.reason,/丢弃/);
  const s=await (await call('/api/state')).json();assert.equal(s.sources.vision.online,false);
});

test('vision unavailable reports failure while timer and local report remain usable',async t=>{
  const {base,call}=await fixture(t,{visionURL:'http://127.0.0.1:1'});
  await call('/api/action',{action:'settings',settings:{cameraEnabled:true}});
  const r=await fetch(base+'/api/frame',{method:'POST',headers:{'Content-Type':'image/jpeg'},body:Buffer.from([255,216,255,217])});
  assert.equal(r.status,503);assert.equal((await call('/api/action',{action:'start'})).status,200);
  const s=await (await call('/api/state')).json();assert.equal(s.phase,'focus');assert.equal(s.report.source,'local');assert.equal(s.sources.vision.online,false);
});
