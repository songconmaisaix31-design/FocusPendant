import { randomUUID } from 'node:crypto';

export const SCENES = {reading:'阅读',writing:'书写',meeting:'交流',screen_work:'屏幕工作',eating:'用餐',exercise:'运动',away:'离开桌面',other:'其他',unknown:'未识别'};
const MODES = ['lite','flow','vision'];
const TTL = 90_000;
const clean = (v,n=120) => typeof v === 'string' ? v.replace(/[\x00-\x1f]/g,' ').slice(0,n) : '';
export function dateKey(ts,zone='Asia/Shanghai') {
  const p = new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ts));
  return ['year','month','day'].map(k=>p.find(v=>v.type===k).value).join('-');
}
const emptyDay = () => ({timeline:[],sessions:[],notes:[],switches:[],distractions:[],checkins:[]});

export class AttentionEngine {
  constructor({now=Date.now(),saved=null,timezone='Asia/Shanghai',focusSec=1500,breakSec=300}={}) {
    this.timezone=timezone; this.focusDuration=focusSec; this.breakDuration=breakSec;
    this.days=saved?.days??{};this.isDemo=saved?.isDemo===true;
    this.settings={cameraEnabled:false,flowEnabled:true,localOnly:true,...saved?.settings,cameraEnabled:false};
    this.modeRequested=MODES.includes(saved?.modeRequested)?saved.modeRequested:'lite';
    this.phase='idle'; this.remainingSec=focusSec; this.session=null;
    // A restart never turns an unobserved gap into focused work.
    if(saved?.session) { this.session=saved.session; this.phase='paused'; this.remainingSec=saved.remainingSec??focusSec; }
    this.lastTick=now; this.flow=null; this.vision=null; this.candidate=null; this.manual=null;
    this.statusMessage=''; this.statusUntil=0; this.previousMode=null;
    this.ensureDay(now);
  }
  ensureDay(ts) { const d=dateKey(ts,this.timezone); return this.days[d]??(this.days[d]=emptyDay()); }
  online(kind,now) { const x=this[kind]; return !!x && now-x.receivedAt<TTL && (kind==='vision'?this.settings.cameraEnabled:this.settings.flowEnabled); }
  mode(now) { if(this.modeRequested==='vision'&&this.online('vision',now))return 'vision'; if(this.modeRequested!=='lite'&&this.online('flow',now))return 'flow'; return 'lite'; }
  context(now) {
    if(this.manual && now<this.manual.expiresAt) return {label:this.manual.label,scene:this.manual.scene,source:'manual',confidence:null,evidence:'用户主动标记，有效期 5 分钟'};
    const mode=this.mode(now), f=this.online('flow',now)?this.flow:null;
    if(mode==='vision' && this.vision?.stable) {
      const v=this.vision;
      return {label:SCENES[v.scene],scene:v.scene,source:'vision',confidence:v.confidence,evidence:`连续 ${v.samples} 次视觉采样；${v.backend}；仅为场景推测${f?`；前台 ${f.app}`:''}`};
    }
    if(mode!=='lite' && f) {
      if(f.idle_sec>=120)return {label:'电脑空闲',scene:'unknown',source:'flow',confidence:null,evidence:`操作系统 ${Math.floor(f.idle_sec)} 秒无输入；不能据此推断离开或分心`};
      return {label:f.app||'电脑活动',scene:'screen_work',source:'flow',confidence:null,evidence:`前台应用 ${f.app}${f.project?`；项目 ${f.project}`:''}；窗口名不等于注意力`};
    }
    if(this.phase==='focus')return {label:this.session?.intent||'计划专注',scene:'unknown',source:'timer',confidence:null,evidence:'用户开启的专注计时，未验证实际专注程度'};
    if(this.phase==='break')return {label:'休息计时',scene:'unknown',source:'timer',confidence:null,evidence:'休息计时'};
    return {label:'未观测',scene:'unknown',source:'unknown',confidence:null,evidence:'没有足够的新鲜数据'};
  }
  appendInterval(start,end,context,focused=false) {
    if(end<=start)return;
    // Split at local midnight (supports IANA zones, including DST).
    while(start<end) {
      let stop=end;
      if(dateKey(start,this.timezone)!==dateKey(end-1,this.timezone)) {
        let lo=start,hi=end; const key=dateKey(start,this.timezone);
        while(hi-lo>1){const m=Math.floor((lo+hi)/2); if(dateKey(m,this.timezone)===key)lo=m; else hi=m;}
        stop=hi;
      }
      const d=this.ensureDay(start), last=d.timeline.at(-1);
      const key=JSON.stringify([context.label,context.source,context.scene,focused]);
      if(last && last.end===start && last.key===key && !last.corrected){last.end=stop;last.evidence=context.evidence;last.confidence=context.confidence;}
      else d.timeline.push({id:randomUUID(),start,end:stop,...context,focused,key,corrected:false});
      start=stop;
    }
  }
  advance(now=Date.now()) {
    if(now<=this.lastTick)return;
    let start=this.lastTick;
    // Suspended/laptop-asleep time is explicitly unknown, timers pause after a long gap.
    if(now-start>10_000) {
      this.appendInterval(start,now,{label:'未观测',scene:'unknown',source:'unknown',confidence:null,evidence:'服务暂停或电脑休眠'},false);
      if(this.phase==='focus'||this.phase==='break'){this.pausedFrom=this.phase;this.phase='paused';}
      this.lastTick=now; return;
    }
    while(start<now) {
      const boundaries=[now,...[this.flow,this.vision].filter(Boolean).map(x=>x.receivedAt+TTL),this.manual?.expiresAt].filter(x=>x>start);
      if(this.phase==='focus'||this.phase==='break')boundaries.push(start+this.remainingSec*1000);
      const end=Math.min(...boundaries); const focused=this.phase==='focus';
      this.appendInterval(start,end,this.context(start),focused);
      if(focused||this.phase==='break') {
        const elapsed=(end-start)/1000; this.remainingSec=Math.max(0,this.remainingSec-elapsed);
        if(focused&&this.session)this.session.focusSec+=elapsed;
        if(this.remainingSec<=0.000001) {
          if(focused){this.closeSession(end,'completed');this.phase='break';this.remainingSec=this.breakDuration;}
          else {this.phase='idle';this.remainingSec=this.focusDuration;}
        }
      }
      start=end;
    }
    this.lastTick=now;
    const m=this.mode(now);
    if(this.previousMode&&m!==this.previousMode){this.statusMessage=`感知模式：${m.toUpperCase()}`;this.statusUntil=now+5000;}
    this.previousMode=m;
  }
  closeSession(now,status) { if(this.session){this.ensureDay(this.session.start).sessions.push({...this.session,end:now,status});this.session=null;} }
  ingest(event,now=Date.now()) {
    this.advance(now);
    if(!event||typeof event!=='object')throw new Error('事件必须是 JSON 对象');
    if(event.ts!==undefined && (!Number.isFinite(event.ts)||Math.abs(event.ts-now)>120000))throw new Error('事件时间偏差超过 120 秒；请同步电脑时间');
    const d=this.ensureDay(now);
    if(event.type==='window') {
      if(!this.settings.flowEnabled)throw new Error('窗口采集已关闭');
      const app=clean(event.app,80); if(!app)throw new Error('window 缺少 app');
      const id=clean(event.windowId||app,160), old=this.flow;
      if(old&&now-old.receivedAt<TTL&&old.windowId!==id)d.switches.push(now);
      const idle=Math.max(0,Math.min(86400,Number(event.idle_sec)||0));
      const continuous=old&&old.windowId===id&&now-old.receivedAt<TTL&&old.idle_sec<120&&idle<120;
      this.flow={app,project:clean(event.project,80),windowId:id,idle_sec:idle,receivedAt:now,sameSince:continuous?old.sameSince:now};
      return {accepted:true};
    }
    if(event.type==='vision') {
      if(!this.settings.cameraEnabled)throw new Error('摄像头采集未开启');
      if(event.observed===false)return {accepted:false,reason:clean(event.quality?.reason||event.reason)||'无有效视觉证据'};
      if(!Object.hasOwn(SCENES,event.scene))throw new Error('未知场景标签');
      const conf=Number(event.confidence); if(!Number.isFinite(conf)||conf<0||conf>1)throw new Error('confidence 必须位于 0..1');
      if(event.scene==='unknown'||conf<0.7){this.candidate=null;return {accepted:false,reason:'置信度不足，等待后续采样'};}
      if(this.candidate&&now-this.candidate.lastAt<1000)return {accepted:false,reason:'采样间隔至少 1 秒'};
      const same=this.candidate?.scene===event.scene&&now-this.candidate.lastAt<TTL;
      this.candidate={scene:event.scene,count:same?this.candidate.count+1:1,lastAt:now};
      // An old classification cannot be kept alive by an unrelated heartbeat.
      if(this.candidate.count>=3)this.vision={scene:event.scene,confidence:conf,backend:clean(event.backend,40)||'external',samples:this.candidate.count,stable:true,receivedAt:now};
      return {accepted:true,stable:this.candidate.count>=3,samples:this.candidate.count};
    }
    if(event.type==='manual') {
      const scene=Object.hasOwn(SCENES,event.scene)?event.scene:'other'; const label=clean(event.label,40)||SCENES[scene];
      this.manual={scene,label,expiresAt:now+300000};d.notes.push({id:randomUUID(),ts:now,text:`自报活动：${label}`,source:'manual'});return {accepted:true};
    }
    throw new Error('不支持的事件类型');
  }
  action(input,now=Date.now()) {
    this.advance(now);const d=this.ensureDay(now);const a=input.action;
    if(a==='start'){
      if(this.phase==='focus'||this.phase==='paused')throw new Error('已有进行中的计时');
      this.phase='focus';this.remainingSec=this.focusDuration;this.session={id:randomUUID(),start:now,focusSec:0,intent:clean(input.text,40)||'计划专注',distractions:0,checkins:0};
    } else if(a==='pause') { if(this.phase!=='focus'&&this.phase!=='break')throw new Error('当前不能暂停');this.pausedFrom=this.phase;this.phase='paused';
    } else if(a==='resume'){if(this.phase!=='paused')throw new Error('当前未暂停');this.phase=this.pausedFrom||'focus';
    } else if(a==='finish'){this.closeSession(now,'ended');this.phase='idle';this.remainingSec=this.focusDuration;
    } else if(a==='distraction'){d.distractions.push(now);if(this.session)this.session.distractions++;this.statusMessage='已标记一次分心';this.statusUntil=now+5000;
    } else if(a==='checkin'){d.checkins.push(now);if(this.session)this.session.checkins++;d.notes.push({id:randomUUID(),ts:now,text:clean(input.text,1000)||'完成一次打卡',source:'manual',voice:input.voice||null});this.statusMessage='打卡已保存';this.statusUntil=now+5000;
    } else if(a==='mode'){if(!MODES.includes(input.mode))throw new Error('模式须为 lite / flow / vision');this.modeRequested=input.mode;
    } else if(a==='settings'){
      for(const key of ['cameraEnabled','flowEnabled','localOnly'])if(typeof input.settings?.[key]==='boolean')this.settings[key]=input.settings[key];
      if(!this.settings.cameraEnabled){this.vision=null;this.candidate=null;}
      if(!this.settings.flowEnabled)this.flow=null;
    } else if(a==='correct'){
      const label=clean(input.label,40);if(!label)throw new Error('修正标签不能为空');
      const seg=Object.values(this.days).flatMap(x=>x.timeline).find(x=>x.id===input.segmentId);if(!seg)throw new Error('时间段不存在');
      seg.original??={label:seg.label,source:seg.source,evidence:seg.evidence};seg.label=label;seg.corrected=true;seg.source='manual';seg.evidence=`用户修正；原始：${seg.original.label}（${seg.original.source}）`;
    } else throw new Error('不支持的操作');
    return this.snapshot(now);
  }
  statistics(day) {
    const stats={observedSec:0,focusSec:0,distractions:day.distractions.length,switches:day.switches.length,checkins:day.checkins.length};
    for(const s of day.timeline){const t=(s.end-s.start)/1000;if(!['unknown','timer'].includes(s.source))stats.observedSec+=t;if(s.focused)stats.focusSec+=t;}
    return stats;
  }
  report(day) {
    const s=this.statistics(day), groups={};for(const x of day.timeline){if(x.source!=='unknown')groups[x.label]=(groups[x.label]||0)+(x.end-x.start)/60000;}
    const top=Object.entries(groups).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([l,m])=>`${l} ${Math.round(m)} 分钟`).join('、');
    return {source:'local',summary:[s.observedSec?`有来源记录覆盖 ${Math.round(s.observedSec/60)} 分钟；${top||'尚无活动片段'}。`:'还没有窗口、视觉或自报活动，全天情况暂不能判断。',`主动专注计时 ${Math.round(s.focusSec/60)} 分钟；切换窗口 ${s.switches} 次。`,`你标记了 ${s.distractions} 次分心，留下 ${s.checkins} 次打卡。`],suggestion:s.switches>20?'挑选一个切换较多的时段，核对这些切换是否服务于同一任务。':'下次结束一段工作时留一句打卡，帮助复盘区分计划与实际活动。',limitations:'场景、窗口和计时是活动线索，不是对认知注意力的测量；未观测时段不计入观测覆盖。'};
  }
  snapshot(now=Date.now(),date=dateKey(now,this.timezone)) {
    const day=this.days[date]||emptyDay(),current=this.context(now),mode=this.mode(now),stats=this.statistics(day);
    const mm=Math.floor(this.remainingSec/60).toString().padStart(2,'0'),ss=Math.floor(this.remainingSec%60).toString().padStart(2,'0');
    const status=now<this.statusUntil?this.statusMessage:current.label;
    const insights=[];const switches5m=day.switches.filter(t=>now-t<300000).length;
    if(switches5m>=10)insights.push(`最近 5 分钟切换窗口 ${switches5m} 次；可以核对它们是否服务于同一任务。`);
    if(mode==='vision'&&['reading','writing'].includes(current.scene)&&this.online('flow',now)&&this.flow.idle_sec<30)insights.push(`桌面线索为“${current.label}”，电脑前台为 ${this.flow.app}；可能是配合使用，请自行确认。`);
    const deepWork=!!(this.flow&&this.online('flow',now)&&this.flow.idle_sec<120&&now-this.flow.sameSince>=1500000);
    if(deepWork)insights.push('同一窗口保持活动已满 25 分钟；这是一条持续工作线索。');
    return {date,now,isDemo:this.isDemo,timezone:this.timezone,modeRequested:this.modeRequested,modeEffective:mode,phase:this.phase,remainingSec:Math.ceil(this.remainingSec),settings:this.settings,current,stats,insights,timeline:day.timeline.map(({key,...s})=>s),sessions:day.sessions,notes:day.notes,report:this.report(day),daily:Object.entries(this.days).sort(([a],[b])=>a.localeCompare(b)).slice(-7).map(([date,d])=>({date,...this.statistics(d)})),sources:{flow:{online:this.online('flow',now),lastSeen:this.flow?.receivedAt??null},vision:{online:this.online('vision',now),lastSeen:this.vision?.receivedAt??null,pendingSamples:this.candidate?.count??0}},deepWork,hudLines:[`FocusPendant · ${mode.toUpperCase()}`,this.phase==='idle'?status:`${this.phase==='paused'?'暂停':this.phase==='break'?'休息':'专注'} ${mm}:${ss} · ${status}`,`今日计时${Math.floor(stats.focusSec/60)}分 · 切窗${stats.switches}次`].map(s=>Array.from(s).slice(0,22).join(''))};
  }
  serialize(){return {version:1,isDemo:this.isDemo,days:this.days,settings:this.settings,modeRequested:this.modeRequested,session:this.session,remainingSec:this.remainingSec};}
}
