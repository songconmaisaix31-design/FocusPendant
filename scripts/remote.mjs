import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadRemoteConfig} from '../core/remote/controller.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataDir=path.resolve(process.env.FOCUS_DATA_DIR||path.join(root,'data'));
const configFile=path.resolve(process.env.FOCUS_REMOTE_CONFIG||path.join(dataDir,'remote-config.json'));
const [command,...args]=process.argv.slice(2),flags={};
for(let i=0;i<args.length;i++){if(!args[i].startsWith('--')||args[i+1]===undefined||args[i+1].startsWith('--'))throw new Error('参数格式：--name value');flags[args[i].slice(2)]=args[++i];}
function writeConfig(config){fs.mkdirSync(path.dirname(configFile),{recursive:true,mode:0o700});const tmp=configFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify(config,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,configFile);}
function required(name){if(!flags[name])throw new Error(`需要 --${name}`);return flags[name];}
async function api(route,body){
  const config=loadRemoteConfig(configFile),token=process.env.FOCUS_TOKEN||config.ownerToken;
  if(!token)throw new Error('先运行 npm run remote -- init');
  const base=process.env.FOCUS_SERVER_URL||`http://127.0.0.1:${process.env.FOCUS_PORT||7788}`;
  const parsed=new URL(base);
  if(parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)))throw new Error('电脑主凭据只能发往 HTTPS 或本机回环');
  const response=await fetch(base.replace(/\/$/,'')+route,{method:body===undefined?'GET':'POST',redirect:'error',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const result=await response.json();if(!response.ok)throw new Error(result.error||`HTTP ${response.status}`);return result;
}
async function main(){
  if(command==='init'){
    if(fs.existsSync(configFile))throw new Error('配置已存在，未覆盖');
    writeConfig({version:1,ownerToken:randomBytes(32).toString('base64url'),pollIntervalMs:2000,targets:[],handoffProviders:{}});
    console.log(`已初始化 ${configFile}\n运行 npm start 后，用 npm run remote -- pair 生成设备配对码。电脑主凭据保存在本机配置中。`);return;
  }
  if(['add-swa','add-managed','add-opencode'].includes(command)){
    if(!fs.existsSync(configFile))throw new Error('先运行 npm run remote -- init');
    const config=loadRemoteConfig(configFile),id=required('id');if(config.targets.some(t=>t.id===id))throw new Error('任务 ID 已存在');
    let target;
    if(command==='add-swa')target={id,adapter:'swa',endpoint:required('endpoint'),tokenEnv:required('token-env'),projectId:required('project'),controllerId:required('controller'),runId:required('run'),taskId:required('task')};
    else if(command==='add-opencode')target={id,adapter:'opencode',endpoint:required('endpoint'),apiVersion:required('api-version'),cwd:path.resolve(required('cwd')),sessionId:required('session'),projectId:flags.project||id,...(flags['token-env']?{tokenEnv:flags['token-env']}:{})};
    else target={id,adapter:'managed',provider:required('provider'),cwd:path.resolve(required('cwd')),prompt:fs.readFileSync(path.resolve(required('prompt-file')),'utf8'),projectId:flags.project||id,autoStart:false,...(flags.model?{model:flags.model}:{}),...(flags.session?{sessionId:flags.session,recoverable:flags['writer-stopped']==='true'}:{}),...(flags.sandbox?{sandbox:flags.sandbox}:{})};
    if(flags.title)target.title=flags.title;
    config.targets.push(target);writeConfig(config);
    console.log(`已登记 ${id}，重启服务加载配置。托管任务由 npm run remote -- start --id ${id} 显式启动。`);return;
  }
  if(command==='pair'){console.log(JSON.stringify(await api('/api/remote/admin/pairings',{label:flags.label||'我的设备',scopes:(flags.scopes||'read').split(','),projectIds:flags.projects?flags.projects.split(','):[]}),null,2));return;}
  if(command==='devices'){console.log(JSON.stringify(await api('/api/remote/admin/devices'),null,2));return;}
  if(command==='revoke'){console.log(JSON.stringify(await api('/api/remote/admin/revoke',{deviceId:required('id')}),null,2));return;}
  if(command==='start'){console.log(JSON.stringify(await api('/api/remote/admin/start',{taskId:required('id')}),null,2));return;}
  if(command==='status'){console.log(JSON.stringify(await api('/api/remote/snapshot'),null,2));return;}
  if(command==='mirror'){
    const {SyncClient}=await import('../core/remote/sync-client.mjs');
    const token=process.env[flags['token-env']||'FOCUS_DEVICE_TOKEN'];if(!token)throw new Error('通过 FOCUS_DEVICE_TOKEN 或 --token-env 指定设备凭据');
    const client=new SyncClient({url:required('url'),token,dataDir:path.resolve(flags.dir||path.join(dataDir,'mirror'))});
    let stopped=false;for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopped=true;});
    do{const snapshot=await client.pollOnce();console.log(JSON.stringify({sync:snapshot.sync,tasks:snapshot.tasks?.map(t=>({id:t.id,status:t.status,freshness:t.freshness,lastObservedAt:t.lastObservedAt}))}));
      if(flags.once==='true'||stopped||snapshot.sync?.status==='auth_error')break;
      await new Promise(resolve=>setTimeout(resolve,2000));
    }while(!stopped);return;
  }
  console.log('Usage: npm run remote -- init | add-swa | add-managed | add-opencode | pair | devices | revoke --id ID | start --id ID | status | mirror\n完整参数见 docs/REMOTE.md。');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
