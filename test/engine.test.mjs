import test from 'node:test';
import assert from 'node:assert/strict';
import {AttentionEngine,dateKey} from '../core/engine.mjs';

const T=Date.parse('2026-11-07T01:00:00Z');
const ticks=(e,start,end,step=1000)=>{for(let t=start+step;t<end;t+=step)e.advance(t);e.advance(end);};
const act=(e,action,t=T,extra={})=>e.action({action,...extra},t);
const window=(e,t,id='code',idle=0)=>e.ingest({type:'window',ts:t,app:'Code',windowId:id,idle_sec:idle},t);
const vision=(e,t,scene='reading',confidence=.9,extra={})=>e.ingest({type:'vision',ts:t,scene,confidence,backend:'test',...extra},t);

test('focus / pause / resume / finish accounts only active time',()=>{
  const e=new AttentionEngine({now:T});
  act(e,'start',T,{text:'阅读'});ticks(e,T,T+5000);
  act(e,'pause',T+5000);ticks(e,T+5000,T+10000);
  act(e,'resume',T+10000);ticks(e,T+10000,T+13000);
  act(e,'distraction',T+13000);act(e,'checkin',T+13000,{text:'读到第二章'});
  const s=act(e,'finish',T+13000);
  assert.equal(s.stats.focusSec,8);assert.equal(s.stats.observedSec,0);
  assert.equal(s.sessions[0].focusSec,8);assert.equal(s.sessions[0].distractions,1);
  assert.equal(s.sessions[0].checkins,1);assert.equal(s.phase,'idle');
});

test('focus completion transitions through break without inventing another session',()=>{
  const e=new AttentionEngine({now:T,focusSec:2,breakSec:1});
  act(e,'start');e.advance(T+2500);const middle=e.snapshot(T+2500);
  assert.equal(middle.phase,'break');assert.equal(middle.remainingSec,1);
  assert.equal(middle.sessions[0].status,'completed');assert.equal(middle.stats.focusSec,2);
  e.advance(T+3500);assert.equal(e.snapshot(T+3500).phase,'idle');assert.equal(e.snapshot(T+3500).sessions.length,1);
});

test('uneven millisecond ticks complete a timer at its boundary',()=>{
  const e=new AttentionEngine({now:T,focusSec:2.001,breakSec:1});act(e,'start');
  for(let n=137;n<2001;n+=137)e.advance(T+n);
  e.advance(T+2001);const s=e.snapshot(T+2001);
  assert.equal(s.phase,'break');assert.ok(Math.abs(s.stats.focusSec-2.001)<1e-6);
  assert.ok(Math.abs(s.sessions[0].focusSec-2.001)<1e-6);
});

test('sleep gaps pause timer and are recorded as unobserved',()=>{
  const e=new AttentionEngine({now:T});act(e,'start');ticks(e,T,T+3000);
  e.advance(T+120000);const s=e.snapshot(T+120000);
  assert.equal(s.phase,'paused');assert.equal(s.stats.focusSec,3);assert.equal(s.remainingSec,1497);
  assert.equal(s.timeline.at(-1).source,'unknown');assert.equal(s.timeline.at(-1).end-s.timeline.at(-1).start,117000);
});

test('local midnight splits one real interval into correct dates',()=>{
  const t=Date.parse('2026-11-07T15:59:58Z');const e=new AttentionEngine({now:t});
  act(e,'start',t);ticks(e,t,t+4000);
  assert.equal(e.snapshot(t+4000,'2026-11-07').stats.focusSec,2);
  assert.equal(e.snapshot(t+4000,'2026-11-08').stats.focusSec,2);
});

test('vision requires three fresh observations and stale sources degrade Vision → Flow → Lite',()=>{
  const e=new AttentionEngine({now:T});act(e,'mode',T,{mode:'vision'});
  act(e,'settings',T,{settings:{cameraEnabled:true}});window(e,T);
  assert.equal(e.mode(T),'flow');vision(e,T);
  assert.equal(vision(e,T+500).accepted,false);
  vision(e,T+1000);assert.equal(e.mode(T+1000),'flow');vision(e,T+2000);
  assert.equal(e.mode(T+2000),'vision');assert.equal(e.context(T+2000).scene,'reading');
  ticks(e,T+2000,T+90000);window(e,T+90000);
  e.advance(T+92000);assert.equal(e.mode(T+92000),'flow');
  ticks(e,T+92000,T+180000);assert.equal(e.mode(T+180000),'lite');
});

test('unknown low-confidence vision cannot become fresh evidence; camera off clears classification',()=>{
  const e=new AttentionEngine({now:T});act(e,'mode',T,{mode:'vision'});act(e,'settings',T,{settings:{cameraEnabled:true}});
  vision(e,T);vision(e,T+1000);vision(e,T+2000);assert.equal(e.mode(T+2000),'vision');
  assert.equal(vision(e,T+3000,'writing',.4).accepted,false);
  ticks(e,T+3000,T+92000);assert.equal(e.mode(T+92000),'lite');
  act(e,'settings',T+92000,{settings:{cameraEnabled:false}});
  assert.throws(()=>vision(e,T+92000),/未开启/);assert.equal(e.snapshot(T+92000).sources.vision.online,false);
});

test('manual correction retains original evidence; a new observation is not absorbed by correction',()=>{
  const e=new AttentionEngine({now:T});act(e,'mode',T,{mode:'flow'});window(e,T);e.advance(T+1000);
  const segment=e.snapshot(T+1000).timeline[0];
  act(e,'correct',T+1000,{segmentId:segment.id,label:'查阅接口文档'});e.advance(T+2000);
  const s=e.snapshot(T+2000);assert.equal(s.timeline[0].source,'manual');assert.equal(s.timeline[0].original.source,'flow');
  assert.equal(s.timeline[0].label,'查阅接口文档');assert.equal(s.timeline[1].source,'flow');
});

test('restart preserves history, pauses active session, and defaults camera to off',()=>{
  const e=new AttentionEngine({now:T});act(e,'settings',T,{settings:{cameraEnabled:true}});act(e,'start');ticks(e,T,T+5000);
  const restored=new AttentionEngine({now:T+3600000,saved:structuredClone(e.serialize())});
  const s=restored.snapshot(T+3600000);assert.equal(s.phase,'paused');assert.equal(s.remainingSec,1495);
  assert.equal(s.settings.cameraEnabled,false);assert.equal(s.stats.focusSec,5);
});

test('rejects stale events and disabled window input',()=>{
  const e=new AttentionEngine({now:T});
  assert.throws(()=>e.ingest({type:'window',app:'Code',ts:T-121000},T),/时间偏差/);
  act(e,'settings',T,{settings:{flowEnabled:false}});assert.throws(()=>window(e,T),/已关闭/);
});

test('a stale collector gap resets deep-work continuity on reconnect',()=>{
  const e=new AttentionEngine({now:T});act(e,'mode',T,{mode:'flow'});window(e,T);
  ticks(e,T,T+1600000);window(e,T+1600000);
  assert.equal(e.snapshot(T+1600000).deepWork,false);
});

test('fresh active samples in the same window can reach the deep-work rule',()=>{
  const e=new AttentionEngine({now:T});act(e,'mode',T,{mode:'flow'});window(e,T);
  for(let t=T+5000;t<=T+1500000;t+=5000){e.advance(t);window(e,t);}
  assert.equal(e.snapshot(T+1500000).deepWork,true);
  window(e,T+1501000,'browser');assert.equal(e.snapshot(T+1501000).deepWork,false);
});

test('computer idle breaks deep-work continuity',()=>{
  const e=new AttentionEngine({now:T});act(e,'mode',T,{mode:'flow'});window(e,T);
  for(let t=T+5000;t<=T+1600000;t+=5000){e.advance(t);window(e,t,'code',t>T+20000?600:0);}
  window(e,T+1601000,'code',0);
  assert.equal(e.snapshot(T+1601000).deepWork,false);
});
