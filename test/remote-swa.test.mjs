import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {SwaAdapter} from '../core/remote/swa.mjs';

const TOKEN='local-swa-project-token';
const REQUEST='e6b4e9bc-c9f2-4a70-971d-b541f131aa68';
const scope={project_id:'project-one',controller:'controller-one',run_id:'run-one',task_id:'root-one'};
const config={token:TOKEN,projectId:scope.project_id,controllerId:scope.controller,runId:scope.run_id,taskId:scope.task_id};
const clone=value=>structuredClone(value);

function runView(overrides={}){
  return {
    schema:'swa.run-view.v1',controller:scope.controller,run_id:scope.run_id,root_task_id:scope.task_id,status:'waiting_input',
    root:{id:scope.task_id,status:'dispatched',result:null},
    tasks:[{id:scope.task_id,parent_id:null,status:'dispatched',title:'检查接口',dependencies:[],result:null},
      {id:'child-one',parent_id:scope.task_id,status:'dispatched',title:'Worker',dependencies:[],result:null}],
    dispatches:[{id:'dispatch-one',task_id:'child-one',status:'dispatched',worker_state:'ready',release_state:null,creator_dispatch_id:null,recipient_session_id:'session-one'}],
    questions:[{id:'question-one',task_id:'child-one',dispatch_id:'dispatch-one',question:'采用哪种接口？'}],answered_questions:[],
    handoffs:[],blockers:[{kind:'question',task_id:'child-one',dispatch_id:'dispatch-one',reason:'question-one'}],failures:[],deliverables:[],
    complete:false,acceptance:'unreviewed',observed_at:'2026-11-07T10:00:00.000Z',...overrides
  };
}

function runReply(view=runView()){
  return {ok:true,controller:scope.controller,run_id:scope.run_id,task_id:scope.task_id,runtime_id:'runtime-one',authority_domain:'authority-one',
    result:{scope:{project_id:scope.project_id,controller:scope.controller,run_id:scope.run_id,root_task_id:scope.task_id},native:{run_view:view}}};
}

function answeredQuestion(overrides={}){
  return {question_id:'question-one',task_id:'child-one',dispatch_id:'dispatch-one',question:'采用哪种接口？',answer_message_id:'message-one',answer:'本地接口',
    answered_by_generation:1,answered_at:'2026-11-07T10:01:00.000Z',read_state:'continuation_required',continuation_required:true,...overrides};
}

function command(action='answer',overrides={}){
  return {id:REQUEST,taskId:'bridge-one',action,questionId:'question-one',dispatchId:'dispatch-one',...(action==='answer'?{payload:{answer:'本地接口'}}:{}),...overrides};
}

function nativeRecord(original,overrides={}){
  const base={project_id:scope.project_id,controller:scope.controller,run_id:scope.run_id,request_id:original.request_id,
    native_request_id:`${original.request_id}/native`,dispatch_id:original.dispatch_id};
  const native=original.action==='question.answer'
    ?{...base,root_task_id:scope.task_id,question_id:original.question_id,body:original.text,state:'answered',read_state:'read_unconfirmed',continuation_required:false,
      question:{message_id:original.question_id,run_id:scope.run_id,dispatch_id:original.dispatch_id,status:'answered',answer_message_id:'message-one',answer_body:original.text,answered_by_generation:1,answered_at:'2026-11-07T10:01:00.000Z'},
      message:{id:'message-one',thread_id:original.question_id,run_id:scope.run_id,from_handle:`run:${scope.run_id}`,to_handle:`dispatch:${original.dispatch_id}`,body:original.text},duplicate:false}
    :{...base,agent:'pi',session_id:'session-one',operation_id:'operation-one',state:'accepted'};
  return {project_id:scope.project_id,controller:scope.controller,run_id:scope.run_id,root_task_id:scope.task_id,action:original.action,
    invocation:{command:clone(original)},child_request:`${original.request_id}/native`,native:{...native,...overrides}};
}

function mutationReply(original,overrides={}){
  return {ok:true,request_id:original.request_id,controller:scope.controller,run_id:scope.run_id,task_id:scope.task_id,
    dispatch_id:original.dispatch_id,question_id:original.question_id,result:nativeRecord(original,overrides)};
}

async function fixture(t,handle,options={}){
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    let body;try{body=JSON.parse(text);}catch{body=null;}
    const item={method:req.method,url:req.url,headers:req.headers,body};requests.push(item);
    try{
      const response=await handle(item,res);
      if(response===undefined||res.writableEnded||res.destroyed)return;
      res.writeHead(response.status??200,{'Content-Type':'application/json',...response.headers});
      res.end(response.raw??JSON.stringify(response.body??response));
    }catch{if(!res.headersSent)res.writeHead(500);res.end('{"error":{"code":"fixture_failed"}}');}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const endpoint=`http://127.0.0.1:${server.address().port}`;
  return {adapter:new SwaAdapter({endpoint,...config,...options}),requests,endpoint,server};
}

async function registered(adapter){return {id:'bridge-one',revision:1,...await adapter.read()};}

test('SWA read uses the real local Orca command protocol and retains semantic state only',async t=>{
  let count=0;
  const {adapter,requests}=await fixture(t,()=>{
    const view=runView({observed_at:`2026-11-07T10:00:0${count++}.000Z`});
    view.tasks[0].title=`接口 ${TOKEN}`;
    // Unrelated credentials in an envelope must never reach a public task.
    return {...runReply(view),authorization:TOKEN};
  });
  const first=await adapter.read(),second=await adapter.read();
  assert.deepEqual(first,second,'poll timestamps must not create a new semantic revision');
  assert.equal(first.title,'接口 [REDACTED]');assert.equal(first.provider,'unknown');
  assert.equal(first.source,'swa.run-view.v1');assert.equal(first.capture,'snapshot_diff');assert.equal(first.acceptance,'unreviewed');
  assert.deepEqual(first.questions,[{id:'question-one',text:'采用哪种接口？',kind:'question',dispatchId:'dispatch-one',continuationRequired:false}]);
  assert.deepEqual(first.capabilities,{answer:true,resume:false,interrupt:false,handoff:false});
  assert.equal(first.metadata.questionProvider,'pi');assert.equal(first.sessionId,'session-one');
  assert.equal(JSON.stringify(first).includes(TOKEN),false);assert.equal(JSON.stringify(adapter).includes(TOKEN),false);
  assert.equal(requests[0].method,'POST');assert.equal(requests[0].url,'/api/v1/local-projects/project-one/orca/commands');
  assert.equal(requests[0].headers.authorization,`Bearer ${TOKEN}`);assert.equal(requests[0].headers['idempotency-key'],undefined);
  assert.deepEqual(requests[0].body,{action:'run.show',...scope});
});

test('SWA accepts only explicit loopback HTTP IP endpoints with ports',()=>{
  for(const endpoint of ['https://127.0.0.1:7777','http://localhost:7777','http://127.0.0.1','http://10.0.0.1:7777',
    'http://127.0.0.1:0','http://127.0.0.1:65536','http://user:pass@127.0.0.1:7777','http://127.0.0.1:7777/path',
    'http://127.0.0.1:7777?x=1','http://127.0.0.1:7777#x','http://127.1:7777','http://[::2]:7777']){
    assert.throws(()=>new SwaAdapter({...config,endpoint}),{code:'invalid_endpoint'});
  }
  for(const endpoint of ['http://127.0.0.1:7777','http://127.9.8.7:80/','http://[::1]:7777'])assert.doesNotThrow(()=>new SwaAdapter({...config,endpoint}));
  assert.throws(()=>new SwaAdapter({...config,endpoint:'http://127.0.0.1:7777',token:''}),{code:'missing_token'});
});

test('SWA read refuses absent, mismatched or incomplete Runs instead of publishing success or a new unknown task',async t=>{
  const variants=[
    {body:{ok:false,error:{code:'evidence_missing',message:'Missing exact Run'}},status:409,code:'swa_run_unavailable'},
    {body:{error:{code:'not_found'}},status:404,code:'swa_run_unavailable'},
    {body:{...runReply(),run_id:'other-run'},code:'scope_mismatch'},
    {body:runReply(runView({acceptance:'passed'})),code:'invalid_run_view'},
    {body:runReply(runView({questions:[],answered_questions:[]})),code:'invalid_run_view'},
    {body:runReply(runView({status:'completed',complete:false})),code:'invalid_run_view'},
    {body:runReply(runView({questions:[{id:'question-one',task_id:'child-one',dispatch_id:'other-worker',question:'Confirm?'}]})),code:'invalid_run_view'},
    {body:{ok:true,result:{}},code:'scope_mismatch'}
  ];
  for(const variant of variants){
    const {adapter}=await fixture(t,()=>variant);
    await assert.rejects(adapter.read(),{code:variant.code});
  }
});

test('provider approval objects and prose do not become remote Pi questions',async t=>{
  const view=runView({status:'active',questions:[],blockers:[],approvals:[{id:'approval-one',question:'Allow tool?'}]});
  view.tasks[1].result='May I execute this command?';
  const {adapter}=await fixture(t,()=>runReply(view));
  const task=await adapter.read();assert.deepEqual(task.questions,[]);assert.equal(task.capabilities.answer,false);assert.equal(task.capabilities.resume,false);
  const {adapter:bad}=await fixture(t,()=>runReply(runView({questions:[{...runView().questions[0],kind:'approval'}]})));
  await assert.rejects(bad.read(),{code:'invalid_run_view'});
});

test('answer uses root Task and exact question/dispatch, original UUID and text without invoking resume',async t=>{
  const {adapter,requests}=await fixture(t,({body})=>body.action==='run.show'?runReply():mutationReply(body));
  const task=await registered(adapter),result=await adapter.execute(command(),task);
  assert.deepEqual(result,{requestId:REQUEST,status:'answered',state:'answered',readState:'read_unconfirmed',continuationRequired:false});
  const mutation=requests.find(item=>item.body.action==='question.answer');
  assert.deepEqual(mutation.body,{action:'question.answer',...scope,dispatch_id:'dispatch-one',question_id:'question-one',request_id:REQUEST,text:'本地接口'});
  assert.equal(mutation.headers['idempotency-key'],REQUEST);assert.equal(mutation.body.task_id,'root-one');
  assert.equal(requests.filter(item=>item.body.action==='question.answer').length,1);
  assert.equal(requests.some(item=>item.body.action==='question.resume'),false);
});

test('binding, unsupported actions, question changes and malformed answers fail before mutation',async t=>{
  const {adapter,requests}=await fixture(t,()=>runReply());
  const task=await registered(adapter);
  const invalid=[
    [command('answer',{taskId:'another-bridge'}),task,'scope_mismatch'],
    [command(),{...task,runId:'another-run'},'scope_mismatch'],
    [command('answer',{runId:'another-run'}),task,'scope_mismatch'],
    [command('answer',{id:'not-a-uuid'}),task,'invalid_request_id'],
    [command('answer',{requestId:'132c32ad-24a9-479d-aea0-b75a129d7515'}),task,'invalid_request_id'],
    [command('interrupt'),task,'unsupported_action'],
    [command('handoff'),task,'unsupported_action'],
    [command('answer',{questionId:'other-question'}),task,'question_not_actionable'],
    [command('answer',{dispatchId:'other-worker'}),task,'question_not_actionable'],
    [command('resume'),task,'question_not_actionable'],
    [command('answer',{payload:{answer:'   '}}),task,'invalid_answer'],
    [command('answer',{payload:{answer:'中'.repeat(10667)}}),task,'invalid_answer'],
    [command('answer',{payload:{answer:'\ud800'}}),task,'invalid_answer'],
    [command('answer',{payload:{answer:'yes',shell:'whoami'}}),task,'invalid_payload'],
    [command('resume',{payload:{answer:'custom new instruction'}}),task,'invalid_payload']
  ];
  for(const [input,target,code] of invalid)await assert.rejects(adapter.execute(input,target),{code});
  assert.equal(requests.some(item=>item.body.action!=='run.show'),false);
});

test('only answered native questions requiring continuation expose resume; accepted input is not completed work',async t=>{
  const view=runView({questions:[],answered_questions:[answeredQuestion()]});
  const {adapter,requests}=await fixture(t,({body})=>body.action==='run.show'?runReply(view):mutationReply(body,{state:'queued'}));
  const task=await registered(adapter);
  assert.equal(task.capabilities.answer,false);assert.equal(task.capabilities.resume,true);
  assert.equal(task.questions[0].continuationRequired,true);assert.equal(task.questions[0].readState,'continuation_required');
  await assert.rejects(adapter.execute(command(),task),{code:'question_not_actionable'});
  const receipt=await adapter.execute(command('resume'),task);
  assert.equal(receipt.status,'accepted');assert.equal(receipt.state,'queued');assert.equal(receipt.sessionId,'session-one');
  const original=requests.find(item=>item.body.action==='question.resume').body;
  assert.deepEqual(original,{action:'question.resume',...scope,dispatch_id:'dispatch-one',question_id:'question-one',request_id:REQUEST});
  assert.equal('text' in original,false);assert.equal('input_file' in original,false);
  const {adapter:unconfirmed}=await fixture(t,()=>runReply(runView({questions:[],answered_questions:[answeredQuestion({read_state:'read_unconfirmed',continuation_required:false})]})));
  const unconfirmedTask=await unconfirmed.read();assert.equal(unconfirmedTask.capabilities.resume,false);assert.deepEqual(unconfirmedTask.questions,[]);
});

test('permission denial is not success and upstream secrets are redacted',async t=>{
  const {adapter}=await fixture(t,({body})=>body.action==='run.show'?runReply():{status:403,body:{error:{code:'scope_denied',message:`Denied ${TOKEN}`}}});
  const receipt=await adapter.execute(command(),await registered(adapter));
  assert.equal(receipt.status,'rejected');assert.equal(receipt.error.code,'scope_denied');assert.equal(JSON.stringify(receipt).includes(TOKEN),false);
  const {adapter:readDenied}=await fixture(t,()=>({status:401,body:{error:{code:'scope_denied',message:'Invalid project grant'}}}));
  await assert.rejects(readDenied.read(),{code:'scope_denied',status:401});
});

test('timeout or lost/malformed mutation response stays unknown with the same request ID',async t=>{
  for(const mode of ['timeout','broken-json','wrong-id','unconfirmed-native','server-failure']){
    const {adapter,requests}=await fixture(t,({body})=>{
      if(body.action==='run.show')return runReply();
      if(mode==='timeout')return undefined;
      if(mode==='broken-json')return {raw:'{"ok":'};
      if(mode==='wrong-id')return {...mutationReply(body),request_id:'another-request'};
      if(mode==='unconfirmed-native')return mutationReply(body,{state:'unknown'});
      return {status:503,body:{error:{code:'provider_unavailable',message:'Unavailable'}}};
    },{timeoutMs:100});
    const receipt=await adapter.execute(command(),await registered(adapter));
    assert.equal(receipt.status,'unknown',mode);assert.equal(receipt.requestId,REQUEST);assert.equal(receipt.requiredAction,'inspect_original_request');
    assert.equal(requests.filter(item=>item.body.action==='question.answer').length,1);
  }
  const {adapter:slow}=await fixture(t,()=>undefined,{timeoutMs:25});
  await assert.rejects(slow.read(),{code:'swa_timeout'});
});

test('redirects are not followed or given the local SWA token',async t=>{
  let redirected=0;
  const target=await fixture(t,()=>{redirected++;return runReply();});
  const {adapter}=await fixture(t,()=>({status:302,headers:{Location:target.endpoint},body:{}}));
  await assert.rejects(adapter.read(),{code:'swa_unavailable'});assert.equal(redirected,0);
});

test('reconcile reads the durable original request receipt and never resends the mutation',async t=>{
  const original={action:'question.answer',...scope,dispatch_id:'dispatch-one',question_id:'question-one',request_id:REQUEST,text:'本地接口'};
  const {adapter,requests}=await fixture(t,({body})=>body.action==='run.show'?runReply():{
    ok:true,request_id:REQUEST,controller:scope.controller,result:{request_id:REQUEST,method:'swa.controllerDeliver',state:'completed',receipt:nativeRecord(original),children:[]}
  });
  const receipt=await adapter.reconcile(command(),await registered(adapter));
  assert.equal(receipt.status,'answered');
  assert.deepEqual(requests.at(-1).body,{action:'request.show',project_id:scope.project_id,controller:scope.controller,request_id:REQUEST});
  assert.equal(requests.at(-1).headers['idempotency-key'],REQUEST);
  assert.equal(requests.some(item=>['question.answer','question.resume'].includes(item.body.action)),false);
});

test('reconcile absent/pending/fenced/mismatched receipts stays unknown without replay',async t=>{
  const original={action:'question.answer',...scope,dispatch_id:'dispatch-one',question_id:'question-one',request_id:REQUEST,text:'本地接口'};
  const mismatched=nativeRecord(original);mismatched.invocation.command.text='different answer';
  const variants=[{state:'absent'},{state:'pending'},{state:'unknown'},{state:'completed',receipt:mismatched},
    {state:'completed',receipt:{...nativeRecord(original),project_id:'other-project'}}];
  for(const result of variants){
    const {adapter,requests}=await fixture(t,({body})=>body.action==='run.show'?runReply():{ok:true,request_id:REQUEST,controller:scope.controller,result});
    assert.equal((await adapter.reconcile(command(),await registered(adapter))).status,'unknown');
    assert.equal(requests.some(item=>item.body.action==='question.answer'),false);
  }
});
