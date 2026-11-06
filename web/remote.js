/* Remote viewer. Execution authority and command idempotency stay on the host. */
(() => {
  'use strict';
  const KEY = 'focus.remote.v1';
  const $ = id => document.getElementById(id);
  const phases = {active:'运行中',running:'运行中',starting:'正在启动',waiting_input:'等待输入',blocked:'已阻塞',completed:'已结束',failed:'失败',unknown:'状态未知',interrupted:'已中断',cancelled:'已取消',idle:'等待下一轮',stopped:'已停止'};
  const freshnessLabels = {connected:'状态有效',stale:'状态过期',offline:'设备离线'};
  const acceptanceLabels = {unreviewed:'尚未验收',passed:'验收通过',failed:'验收失败'};
  const receiptLabels = {received:'已接收',consumed:'Agent 已读取',continuing:'正在继续',dispatching:'正在转交',dispatched:'已转交',executing:'正在执行',pending:'等待回执',accepted:'已接受',saved:'答复已提交，读取待确认',completed:'操作已完成',succeeded:'操作已完成',failed:'操作失败',rejected:'已拒绝',expired:'已过期',unknown:'执行结果未知',answer_saved:'回答已保存',read_unconfirmed:'等待读取确认',read_observed:'Agent 已读取',continuation_required:'需要显式继续',interrupted:'已中断'};
  const actionLabels = {answer:'回答问题',resume:'继续任务',interrupt:'中断任务',handoff:'交接任务'};
  const eventLabels = {'task.updated':'任务状态更新','task.created':'任务已登记','task.started':'任务开始','task.completed':'任务结束','task.failed':'任务失败','input.requested':'等待输入','input.resolved':'输入请求已处理','command.updated':'操作回执更新','command.received':'操作已接收','task.unavailable':'任务来源暂不可用','task.available':'任务来源已恢复'};
  const pendingStates = new Set(['received','dispatching','dispatched','executing','pending','accepted','unknown']);
  const readStorage = (storage, key, fallback) => { try { const value=storage.getItem(key); return value===null?fallback:JSON.parse(value); } catch { return fallback; } };
  const writeStorage = (storage, key, value) => { try { if(value===null)storage.removeItem(key);else storage.setItem(key,JSON.stringify(value)); } catch {} };
  const state = {
    token:readStorage(sessionStorage, KEY+'.token', ''), snapshot:null, events:[], commands:new Map(), cursor:0, epoch:'',
    online:false, busy:false, pairing:false, generation:0, lastReceivedAt:0, lastSnapshotAt:0, error:'', drafts:new Map(), renderKey:'', pollTimer:null
  };
  if (typeof state.token!=='string') state.token='';
  if (state.token) {
    const cached=readStorage(localStorage,KEY+'.snapshot',null);
    if(cached && Array.isArray(cached.tasks)) {
      state.snapshot=cached;
      state.lastReceivedAt=Number(cached.cachedAt)||0;
      const cursor=readStorage(localStorage,KEY+'.cursor',{});
      state.epoch=typeof cursor.epoch==='string'?cursor.epoch:'';
      state.cursor=Number.isSafeInteger(cursor.after)&&cursor.after>=0?cursor.after:0;
    }
    const saved=readStorage(sessionStorage,KEY+'.commands',[]);
    if(Array.isArray(saved))for(const c of saved.slice(-100))if(c&&typeof c.id==='string')state.commands.set(c.id,c);
  }
  const text = (tag,content,className) => { const node=document.createElement(tag); if(content!==undefined&&content!==null)node.textContent=String(content); if(className)node.className=className; return node; };
  function button(label,callback,kind='button-secondary') {
    const b=text('button',label,'button '+kind);b.type='button';b.addEventListener('click',callback);return b;
  }
  function stamp(value) { const ts=typeof value==='string'&&!/^\d+(?:\.\d+)?$/.test(value)?Date.parse(value):Number(value);return Number.isFinite(ts)?ts:0; }
  function relative(value) {
    const ts=stamp(value);if(!ts)return '尚无确认';const seconds=Math.max(0,Math.floor((Date.now()-ts)/1000));
    if(seconds<5)return '刚刚';if(seconds<60)return `${seconds} 秒前`;if(seconds<3600)return `${Math.floor(seconds/60)} 分钟前`;if(seconds<86400)return `${Math.floor(seconds/3600)} 小时前`;return `${Math.floor(seconds/86400)} 天前`;
  }
  function time(value) { const ts=stamp(value);return ts?new Date(ts).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'时间未知'; }
  function safeError(value) { if(typeof value==='string')return value.slice(0,500);if(value&&typeof value.message==='string')return value.message.slice(0,500);return ''; }
  function scopes() { return state.snapshot?.permissions?.scopes || []; }
  function allowed(action) { return scopes().includes('*')||scopes().includes(action); }
  function fresh(task) {
    if(!state.online)return 'offline';
    const age=Date.now()-stamp(task.lastObservedAt);
    if(task.freshness==='offline'||age>45000)return 'offline';
    if(task.freshness==='stale'||age>15000)return 'stale';
    return 'connected';
  }
  function pending(taskId) { return [...state.commands.values()].some(c=>(c.taskId||c.request?.taskId)===taskId&&pendingStates.has(c.status)); }
  function writable(task,action) { return state.online&&fresh(task)==='connected'&&allowed(action)&&Boolean(task.capabilities?.[action])&&!pending(task.id); }
  function toast(message) { $('remote-toast').textContent=message;$('remote-toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('remote-toast').hidden=true,5000); }
  function persist() {
    if(!state.token)return;
    if(state.snapshot)writeStorage(localStorage,KEY+'.snapshot',{...state.snapshot,cachedAt:state.lastReceivedAt});
    writeStorage(localStorage,KEY+'.cursor',{epoch:state.epoch,after:state.cursor});
    writeStorage(sessionStorage,KEY+'.commands',[...state.commands.values()].slice(-100));
  }
  function clearAccess(message='') {
    state.generation++;state.token='';state.snapshot=null;state.events=[];state.commands.clear();state.drafts.clear();state.epoch='';state.cursor=0;state.online=false;state.busy=false;state.error=message;state.lastReceivedAt=0;state.lastSnapshotAt=0;state.renderKey='';
    writeStorage(sessionStorage,KEY+'.token',null);writeStorage(sessionStorage,KEY+'.commands',null);writeStorage(localStorage,KEY+'.snapshot',null);writeStorage(localStorage,KEY+'.cursor',null);
    render(true);
  }
  async function api(route,body,{anonymous=false}={}) {
    const headers={'Accept':'application/json'};if(body!==undefined)headers['Content-Type']='application/json';
    if(!anonymous&&state.token)headers.Authorization=`Bearer ${state.token}`;
    const generation=state.generation;
    const response=await fetch(route,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(8000)});
    let data;try{data=await response.json();}catch{throw new Error('服务返回了无法读取的响应');}
    if(generation!==state.generation)throw Object.assign(new Error('连接已切换'),{obsolete:true});
    if(!response.ok){
      const error=Object.assign(new Error(safeError(data.error)||safeError(data.message)||`请求失败（${response.status}）`),{status:response.status});
      if(response.status===401&&!anonymous)clearAccess('访问已失效或被撤销，请重新配对。');
      throw error;
    }
    return data;
  }
  function normalizeCommand(item,previous={}) {
    const request=item.input||item.request||previous.request;
    return {...previous,...item,request,action:item.action||request?.action||previous.action,taskId:item.taskId||request?.taskId||previous.taskId,error:item.error??null};
  }
  function mergeCommands(commands) {
    if(!Array.isArray(commands))return;
    for(const item of commands)if(item&&typeof item.id==='string')state.commands.set(item.id,normalizeCommand(item,state.commands.get(item.id)));
    if(state.commands.size>100){const ids=[...state.commands.keys()];for(const id of ids.slice(0,-100))state.commands.delete(id);}
  }
  async function snapshot({resetCursor=false}={}) {
    const data=await api('/api/remote/snapshot');
    if(!data||!Array.isArray(data.tasks))throw new Error('任务快照格式无效');
    const newEpoch=data.device?.streamEpoch||data.streamEpoch||'';
    if(typeof newEpoch!=='string')throw new Error('事件流标识无效');
    if(resetCursor||!state.epoch||state.epoch!==newEpoch){state.epoch=newEpoch;state.cursor=Number.isSafeInteger(data.watermark)?data.watermark:0;state.events=[];}
    state.snapshot=data;state.lastReceivedAt=Date.now();state.lastSnapshotAt=state.lastReceivedAt;state.online=true;state.error='';mergeCommands(data.commands);persist();render();
  }
  async function poll(force=false) {
    if(!state.token||state.busy)return;
    state.busy=true;const generation=state.generation;
    try {
      if(force||!state.snapshot){await snapshot();return;}
      const batch=await api(`/api/remote/events?after=${state.cursor}&epoch=${encodeURIComponent(state.epoch)}`);
      if(!Array.isArray(batch.events))throw new Error('事件响应格式无效');
      state.lastReceivedAt=Date.now();state.online=true;state.error='';
      if(batch.resetRequired||batch.streamEpoch!==state.epoch){
        $('event-note').textContent='事件历史或来源发生变化，已重新读取当前状态。';
        await snapshot({resetCursor:true});return;
      }
      const existing=new Set(state.events.map(e=>e.seq));
      for(const event of batch.events)if(Number.isSafeInteger(event.seq)&&event.seq>state.cursor&&!existing.has(event.seq)){state.events.push(event);existing.add(event.seq);}
      state.events=state.events.slice(-100);
      if(Number.isSafeInteger(batch.nextCursor)&&batch.nextCursor>=state.cursor)state.cursor=batch.nextCursor;
      else if(batch.events.length)state.cursor=Math.max(state.cursor,...batch.events.map(e=>Number.isSafeInteger(e.seq)?e.seq:0));
      if(batch.events.length||Date.now()-state.lastSnapshotAt>=10000)await snapshot();
      else{persist();render();}
    } catch(error) {
      if(error.obsolete||generation!==state.generation)return;
      state.online=false;state.error=error.status===403?'当前设备没有查看这些任务的权限。':error.status===401?state.error:'连接中断，当前展示为最后确认的状态。';render();
    } finally {if(generation===state.generation)state.busy=false;}
  }
  function dimension(label,value,tone='') {
    const box=text('div',null,'task-dimension');box.dataset.tone=tone;box.append(text('span',label),text('strong',value));return box;
  }
  function inputField(task,key,label,{placeholder='',rows=3,maxLength=12000}={}) {
    const wrapper=text('label',label,'field');const field=document.createElement('textarea');field.rows=rows;field.maxLength=maxLength;field.required=true;field.placeholder=placeholder;field.dataset.draftKey=key;field.value=state.drafts.get(key)||'';
    field.addEventListener('input',()=>state.drafts.set(key,field.value));wrapper.append(field);return {wrapper,field};
  }
  function optionText(option) { return typeof option==='string'?option:String(option?.label||option?.title||option?.value||''); }
  function structuredQuestionForm(task,question) {
    const isV2=Array.isArray(question.fields);
    const definitions=isV2?question.fields:question.prompts;
    if(!Array.isArray(definitions)||!definitions.length)return null;
    const form=text('form',null,'task-form');const getters=[];
    definitions.forEach((definition,index)=>{
      const multiple=isV2?definition.type==='multiselect':definition.multiple===true;
      const custom=isV2?definition.custom===true:definition.custom!==false;
      const options=Array.isArray(definition.options)?definition.options:[];
      const required=isV2?definition.required===true:true;
      const key=`${task.id}:${question.id}:field:${index}`;
      const saved=state.drafts.get(key)||{selected:[],text:''};
      const draft={selected:Array.isArray(saved.selected)?saved.selected:[],text:typeof saved.text==='string'?saved.text:''};
      const section=text('fieldset',null,'question-fieldset');
      section.append(text('legend',definition.question||definition.label||definition.title||definition.key||`问题 ${index+1}`));
      if(multiple){
        const inputs=[];
        for(const option of options){
          const label=text('label',null,'question-choice');const input=document.createElement('input');input.type='checkbox';input.value=String(isV2?option.value:option.label);input.checked=draft.selected.includes(input.value);input.disabled=!writable(task,'answer');
          input.addEventListener('change',()=>{draft.selected=inputs.filter(item=>item.checked).map(item=>item.value);state.drafts.set(key,draft);});inputs.push(input);label.append(input,text('span',option.label||option.value));section.append(label);
        }
        let free=null;
        if(custom){const label=text('label','补充选项','field');free=document.createElement('input');free.type='text';free.dataset.draftKey=key;free.maxLength=12000;free.value=draft.text;free.disabled=!writable(task,'answer');free.addEventListener('input',()=>{draft.text=free.value;state.drafts.set(key,draft);});label.append(free);section.append(label);}
        getters.push(()=>{const values=inputs.filter(item=>item.checked).map(item=>item.value);if(free?.value.trim())values.push(free.value.trim());const unique=[...new Set(values)];if(required&&!unique.length)throw new Error('请至少选择一项。');if(definition.minItems!==undefined&&unique.length<definition.minItems)throw new Error(`请至少选择 ${definition.minItems} 项。`);if(definition.maxItems!==undefined&&unique.length>definition.maxItems)throw new Error(`最多选择 ${definition.maxItems} 项。`);return unique;});
      }else if(options.length&&!custom){
        const label=text('label','选择回答','field');const select=document.createElement('select');select.dataset.draftKey=key;select.required=required;select.disabled=!writable(task,'answer');const empty=text('option','请选择');empty.value='';select.append(empty);
        for(const option of options){const node=text('option',option.label||option.value);node.value=String(isV2?option.value:option.label);select.append(node);}select.value=draft.text;select.addEventListener('change',()=>{draft.text=select.value;state.drafts.set(key,draft);});label.append(select);section.append(label);getters.push(()=>select.value);
      }else{
        const label=text('label','你的回答','field');const input=document.createElement('textarea');input.rows=3;input.dataset.draftKey=key;input.required=required;input.value=draft.text;input.disabled=!writable(task,'answer');input.maxLength=Math.min(Number(definition.maxLength)||12000,12000);if(definition.minLength)input.minLength=definition.minLength;input.addEventListener('input',()=>{draft.text=input.value;state.drafts.set(key,draft);});
        if(options.length){const row=text('div',null,'question-options');for(const option of options){const value=String(isV2?option.value:option.label);const b=button(option.label||value,()=>{input.value=value;draft.text=value;state.drafts.set(key,draft);input.focus();},'button-quiet');b.disabled=!writable(task,'answer');row.append(b);}section.append(row);}label.append(input);section.append(label);getters.push(()=>input.value.trim());
      }
      form.append(section);
    });
    const row=text('div',null,'button-row');const submit=text('button','发送回答','button button-primary');submit.type='submit';submit.disabled=!writable(task,'answer');row.append(submit);form.append(row);
    form.addEventListener('submit',event=>{event.preventDefault();try{const values=getters.map(get=>get());const payload=isV2?(definitions[0].type==='multiselect'?{answers:values[0]}:{answer:values[0]}):{answers:values.map(value=>Array.isArray(value)?value:[value])};sendCommand(task,'answer',payload,question);}catch(error){toast(error.message);}});
    return form;
  }
  function questionCard(task,question) {
    const box=text('section',null,'question-card');
    const isApproval=question.kind==='approval';const continuation=question.continuationRequired===true;
    box.append(text('p',continuation?'回答已保存 · 需要继续':isApproval?'等待你的本次授权':'等待你的回答','question-kicker'));
    box.append(text('p',question.text||question.question||'等待输入','question-text'));
    if(continuation){
      if(task.capabilities?.resume&&allowed('resume')){
        const b=button('让原任务继续',()=>sendCommand(task,'resume',{},question),'button-primary');b.disabled=!writable(task,'resume');box.append(b);
      }else box.append(text('p','此设备没有继续任务的权限。','muted'));
      return box;
    }
    if(question.answerSupported===false){box.append(text('p','此问题包含当前页面未支持的输入形式，请回到原终端回答。','muted'));return box;}
    if(!task.capabilities?.answer||!allowed('answer')){box.append(text('p','当前连接仅可查看此问题。','muted'));return box;}
    if(isApproval){
      const row=text('div',null,'button-row');
      const reject=button('拒绝',()=>sendCommand(task,'answer',{decision:'reject'},question),'button-quiet');
      const allow=button('允许本次',()=>sendCommand(task,'answer',{decision:'once'},question),'button-primary');
      reject.disabled=allow.disabled=!writable(task,'answer');row.append(reject,allow);box.append(row);return box;
    }
    const structured=structuredQuestionForm(task,question);if(structured){box.append(structured);return box;}
    const form=text('form',null,'task-form');const key=`${task.id}:${question.id}:answer`;
    const {wrapper,field}=inputField(task,key,'你的回答',{placeholder:'回答会交回这个问题对应的原任务'});
    if(Array.isArray(question.options)&&question.options.length){
      const options=text('div',null,'question-options');
      for(const value of question.options.slice(0,20)){
        const label=optionText(value);if(!label)continue;
        const b=button(label,()=>{field.value=label;state.drafts.set(key,label);field.focus();},'button-quiet');b.disabled=!writable(task,'answer');options.append(b);
      }
      form.append(options);
    }
    field.disabled=!writable(task,'answer');form.append(wrapper);
    const row=text('div',null,'button-row');row.append(text('span',pending(task.id)?'等待前一条操作的回执':'只回答当前问题','muted'));
    const submit=text('button','发送回答','button button-primary');submit.type='submit';submit.disabled=!writable(task,'answer');row.append(submit);form.append(row);
    form.addEventListener('submit',event=>{event.preventDefault();const answer=field.value.trim();if(answer)sendCommand(task,'answer',{answer},question);});box.append(form);return box;
  }
  function taskCard(task) {
    const card=text('article',null,'panel task-card');card.dataset.taskId=task.id;card.dataset.freshness=fresh(task);
    const heading=text('div',null,'task-heading');const title=text('div');title.append(text('p',`${task.provider||task.adapter||'Agent'} · ${task.adapter==='swa'?'Swarm CLI':'任务执行端'}`,'task-provider'),text('h3',task.title||task.taskId||task.id));heading.append(title);
    if(task.questions?.length){const badge=text('span',`${task.questions.length} 个待处理`,'badge');badge.dataset.tone='warn';heading.append(badge);}card.append(heading);
    card.append(text('p',task.projectId?`项目 ${task.projectId}`:'已登记的本机任务','task-caption'));
    const dimensions=text('div',null,'task-dimensions');const connection=fresh(task);const phaseLabel=phases[task.status]||String(task.status||'状态未知');
    dimensions.append(dimension(connection==='connected'?'任务阶段':'最后确认的阶段',phaseLabel,['failed','unknown'].includes(task.status)?'warn':''),dimension('连接',freshnessLabels[connection],connection==='connected'?'good':'warn'),dimension('成果',acceptanceLabels[task.acceptance]||'尚未验收',task.acceptance==='passed'?'good':task.acceptance==='failed'?'danger':''));card.append(dimensions);
    const age=text('p',null,'task-age');age.dataset.observedAt=task.lastObservedAt||'';age.textContent=`最后确认：${relative(task.lastObservedAt)} · ${time(task.lastObservedAt)}`;card.append(age);
    if(task.error)card.append(text('p',safeError(task.error),'task-error'));
    for(const question of (task.questions||[]))card.append(questionCard(task,question));
    if(task.capabilities?.resume&&allowed('resume')&&!(task.questions||[]).some(q=>q.continuationRequired)){
      const details=text('details',null,'task-inputs');details.dataset.detailsKey=`${task.id}:resume`;details.append(text('summary','继续这个会话'));
      const form=text('form',null,'task-form');const {wrapper,field}=inputField(task,`${task.id}:resume`,'下一步输入',{placeholder:'说明希望原 Agent 接着做什么'});field.disabled=!writable(task,'resume');form.append(wrapper);
      form.append(text('p','使用当前任务的明确会话继续。','form-note'));
      const row=text('div',null,'button-row');const submit=text('button','提交下一步','button button-secondary');submit.type='submit';submit.disabled=!writable(task,'resume');row.append(submit);form.append(row);
      form.addEventListener('submit',event=>{event.preventDefault();const value=field.value.trim();if(value)sendCommand(task,'resume',{input:value});});details.append(form);card.append(details);
    }
    const handoffProviders=task.capabilities?.handoffProviders;
    if(task.capabilities?.handoff&&allowed('handoff')&&Array.isArray(handoffProviders)&&handoffProviders.length){
      const details=text('details',null,'task-inputs');details.dataset.detailsKey=`${task.id}:handoff`;details.append(text('summary','交给另一个 Agent'));
      const form=text('form',null,'task-form');const label=text('label','接手的 Agent','field');const select=document.createElement('select');
      for(const value of handoffProviders){const provider=typeof value==='string'?value:value?.provider;if(!provider)continue;const option=text('option',typeof value==='object'?(value.label||provider):provider);option.value=provider;select.append(option);}label.append(select);form.append(label);
      const {wrapper,field}=inputField(task,`${task.id}:handoff`,'交接目标',{placeholder:'说明下一位 Agent 应完成的剩余工作'});form.append(wrapper,text('p','接手前会核对工作区，并保留原任务的交接来源。','form-note'));
      select.disabled=field.disabled=!writable(task,'handoff');const submit=text('button','创建接手任务','button button-secondary');submit.type='submit';submit.disabled=!writable(task,'handoff');const row=text('div',null,'button-row');row.append(submit);form.append(row);
      form.addEventListener('submit',event=>{event.preventDefault();if(field.value.trim()&&select.value)sendCommand(task,'handoff',{provider:select.value,input:field.value.trim()});});details.append(form);card.append(details);
    }
    if(task.capabilities?.interrupt&&allowed('interrupt')){
      const controls=text('div',null,'task-controls');controls.append(text('span','中断后可按运行时支持的能力接续。','muted'));
      const b=button('中断任务',()=>{if(window.confirm(`中断“${task.title||task.id}”的当前执行？`))sendCommand(task,'interrupt',{});},'button-quiet danger');b.disabled=!writable(task,'interrupt');controls.append(b);card.append(controls);
    }
    if(connection!=='connected')card.append(text('p','状态过期期间暂停操作，重新连接后核对最新问题。','task-actions-note'));
    const details=text('details',null,'task-details');details.dataset.detailsKey=`${task.id}:source`;details.append(text('summary','查看状态来源'));
    const dl=document.createElement('dl');for(const [label,value] of [['来源',task.source],['采集方式',task.capture==='snapshot_diff'?'定时快照差异':task.capture==='native_event'?'原生事件':task.capture],['任务',task.taskId||task.id],['运行',task.runId],['会话',task.sessionId],['版本',task.revision]])if(value!==undefined&&value!==null&&value!=='')dl.append(text('dt',label),text('dd',value));details.append(dl);card.append(details);return card;
  }
  function renderTasks(force=false) {
    const tasks=state.snapshot?.tasks||[];
    const key=JSON.stringify([state.online,scopes(),tasks.map(t=>[t.id,t.revision,t.lastObservedAt,fresh(t),t.capabilities,t.questions,pending(t.id)])]);
    if(!force&&key===state.renderKey){for(const node of document.querySelectorAll('[data-observed-at]'))node.textContent=`最后确认：${relative(node.dataset.observedAt)} · ${time(node.dataset.observedAt)}`;return;}
    state.renderKey=key;const open=new Set([...document.querySelectorAll('details[data-details-key][open]')].map(n=>n.dataset.detailsKey));
    const focus=document.activeElement?.dataset?.draftKey;const selection=focus?[document.activeElement.selectionStart,document.activeElement.selectionEnd]:null;
    const nodes=tasks.map(taskCard);
    if(!nodes.length){const empty=text('div',null,'empty-state');empty.append(text('span','◌','empty-icon'),text('h3',state.snapshot?'还没有登记的任务':'等待任务电脑连接'),text('p',state.snapshot?'在任务电脑登记 SWA Run 或启动托管 Agent 后，状态会出现在这里。':'配对后，这里会显示已登记任务的运行状态与待回答问题。'));nodes.push(empty);}
    $('task-list').replaceChildren(...nodes);
    for(const d of document.querySelectorAll('details[data-details-key]'))if(open.has(d.dataset.detailsKey))d.open=true;
    if(focus)for(const field of document.querySelectorAll('[data-draft-key]'))if(field.dataset.draftKey===focus&&!field.disabled){field.focus({preventScroll:true});try{field.setSelectionRange(...selection);}catch{}break;}
    $('remote-summary').hidden=!state.snapshot;$('total-tasks').textContent=tasks.length;$('waiting-tasks').textContent=tasks.reduce((sum,t)=>sum+(t.questions?.length||0),0);$('stale-tasks').textContent=tasks.filter(t=>fresh(t)!=='connected').length;
  }
  function renderCommands() {
    const commands=[...state.commands.values()].sort((a,b)=>stamp(b.createdAt||b.request?.createdAt)-stamp(a.createdAt||a.request?.createdAt)).slice(0,20);
    const nodes=[];
    for(const command of commands){
      const card=text('div',null,'command-card');const header=text('div',null,'command-header');header.append(text('strong',actionLabels[command.action||command.request?.action]||'任务操作'));
      const badge=text('span',receiptLabels[command.status]||command.status||'等待回执','badge');if(command.status==='unknown')badge.dataset.tone='warn';if(['failed','rejected','expired'].includes(command.status))badge.dataset.tone='danger';header.append(badge);card.append(header);
      const task=state.snapshot?.tasks?.find(t=>t.id===(command.taskId||command.request?.taskId));card.append(text('p',task?.title||command.taskId||command.request?.taskId||'任务操作'));
      const result=command.result||{};const readState=result.read_state||result.readState||result.answer?.read_state;
      if(readState)card.append(text('p',receiptLabels[readState]||readState));
      if(typeof result.message==='string')card.append(text('p',result.message.slice(0,500)));
      const error=safeError(command.error);if(error)card.append(text('p',error,'command-error'));
      card.append(text('p',`${time(command.createdAt||command.request?.createdAt)} · ${command.id.slice(0,8)}`,'command-time'));
      if(pendingStates.has(command.status)){
        const b=button('核对原请求回执',()=>checkReceipt(command.id),'button-quiet');b.disabled=!state.online;card.append(b);
        if(command.status==='unknown')card.append(text('p','结果尚未确认，不会自动重新执行。','muted'));
      }
      if(command.notFound&&command.request&&state.online&&command.request.expiresAt>Date.now()){
        const b=button('重新发送同一请求',()=>retryCommand(command.id),'button-secondary');card.append(b);
      }
      nodes.push(card);
    }
    if(!nodes.length)nodes.push(text('p','尚未发送操作。','empty-copy'));$('command-list').replaceChildren(...nodes);
  }
  function renderEvents() {
    const nodes=state.events.slice(-40).reverse().map(event=>{const li=text('li',null,'event-item');const task=state.snapshot?.tasks?.find(t=>t.id===event.taskId);li.append(text('time',time(event.observedAt||event.receivedAt)),text('p',`${eventLabels[event.type]||event.type}${task?' · '+task.title:''}`));li.append(text('p',`#${event.seq}${event.capture==='snapshot_diff'?' · 快照变化':''}`,'event-source'));return li;});
    if(!nodes.length)nodes.push(text('li','尚未收到新事件。','empty-copy'));$('event-list').replaceChildren(...nodes);$('event-count').textContent=state.events.length;
  }
  function render(force=false) {
    const status=$('remote-connection');status.classList.toggle('connected',state.online);status.lastElementChild.textContent=state.online?'已连接':state.token?'连接已过期':'等待配对';
    $('pairing-panel').hidden=Boolean(state.token);$('remote-disconnect').hidden=!state.token;$('remote-refresh').disabled=!state.token;
    $('remote-device-name').textContent=state.snapshot?.device?.label||state.snapshot?.device?.deviceId||'尚未连接';
    $('remote-last-update').textContent=state.lastReceivedAt?`服务最后响应：${relative(state.lastReceivedAt)}`:'配对后接收状态';
    const banner=$('remote-banner');banner.hidden=!state.error;banner.textContent=state.error;
    $('remote-permissions').textContent=!state.snapshot?'未连接':scopes().some(x=>x!=='read')?'可按授权操作':'只读访问';
    renderTasks(force);renderCommands();renderEvents();
  }
  function uuid() {
    if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
    const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=[...b].map(x=>x.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  }
  async function sendCommand(task,action,payload,question) {
    const current=state.snapshot?.tasks?.find(t=>t.id===task.id);
    if(!current||current.revision!==task.revision||!writable(current,action)){toast('任务状态已变化，请刷新后再操作。');return;}
    const request={id:uuid(),taskId:task.id,action,expectedRevision:task.revision,sessionId:task.sessionId??null,expiresAt:Date.now()+60000,payload};
    if(question){request.questionId=question.id;request.dispatchId=question.dispatchId||task.dispatchId;}
    else if(task.dispatchId)request.dispatchId=task.dispatchId;
    const command={id:request.id,taskId:task.id,action,status:'pending',createdAt:Date.now(),request};state.commands.set(command.id,command);persist();render();
    await dispatch(command);
  }
  async function dispatch(command) {
    const generation=state.generation;
    try{
      const receipt=await api('/api/remote/commands',command.request);
      state.commands.set(command.id,{...normalizeCommand(receipt,command),notFound:false});state.online=true;state.lastReceivedAt=Date.now();
      toast(receiptLabels[receipt.status]||'操作已提交，正在核对回执。');await poll(true);
    }catch(error){
      if(error.obsolete||generation!==state.generation)return;
      if(error.status>=400&&error.status<500&&error.status!==408){state.commands.set(command.id,{...command,status:'rejected',error:error.message});if(error.status===409)toast('任务或问题已变化，已拒绝旧操作。');}
      else{state.commands.set(command.id,{...command,status:'unknown',error:'连接中断，执行结果未知。请核对原请求回执。'});state.online=false;state.error='连接中断，操作结果暂未确认。';}
    }finally{if(generation===state.generation){persist();render();}}
  }
  async function checkReceipt(id) {
    const command=state.commands.get(id);if(!command||!state.online)return;
    const generation=state.generation;
    try{let receipt=await api(`/api/remote/commands/${encodeURIComponent(id)}`);if(receipt.status==='unknown')receipt=await api(`/api/remote/commands/${encodeURIComponent(id)}/reconcile`,{});state.commands.set(id,{...normalizeCommand(receipt,command),notFound:false});toast(receiptLabels[receipt.status]||'已获取原请求回执。');await poll(true);}
    catch(error){if(error.obsolete||generation!==state.generation)return;if(error.status===404){state.commands.set(id,{...command,status:'unknown',notFound:true,error:'服务尚未记录这个请求。可以在有效期内手动重发同一请求。'});}else toast(error.message||'暂时无法核对回执。');}
    finally{if(generation===state.generation){persist();render();}}
  }
  async function retryCommand(id) {
    const command=state.commands.get(id);if(!command?.request||!command.notFound||!state.online)return;
    if(command.request.expiresAt<=Date.now()){toast('原请求已过期，请读取最新任务状态。');return;}
    const retry={...command,status:'pending',notFound:false};state.commands.set(id,retry);persist();render();await dispatch(retry);
  }
  async function connect(token) {
    clearAccess();state.token=token;state.error='正在连接任务电脑…';writeStorage(sessionStorage,KEY+'.token',token);render(true);await poll(true);
  }
  $('pairing-form').addEventListener('submit',async event=>{
    event.preventDefault();if(state.pairing)return;state.pairing=true;$('pair-submit').disabled=true;$('pairing-message').textContent='';
    try{const result=await api('/api/remote/pair',{code:$('pair-code').value.trim(),label:$('pair-label').value.trim()},{anonymous:true});if(typeof result.token!=='string'||!result.token)throw new Error('配对响应缺少设备令牌');$('pair-code').value='';await connect(result.token);}
    catch(error){$('pairing-message').textContent=error.message||'配对失败，请检查配对码。';}
    finally{state.pairing=false;$('pair-submit').disabled=false;}
  });
  $('token-form').addEventListener('submit',event=>{event.preventDefault();const value=$('remote-token').value.trim();if(value){$('remote-token').value='';connect(value);}});
  $('remote-refresh').addEventListener('click',()=>poll(true));
  $('remote-disconnect').addEventListener('click',()=>clearAccess());
  window.addEventListener('online',()=>poll(true));
  window.addEventListener('offline',()=>{state.online=false;state.error='查看设备已离线，展示最后确认的状态。';render();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll(true);});
  render(true);poll(true);state.pollTimer=setInterval(()=>{poll();render();},2000);
})();
