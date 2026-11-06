// An explicitly separate demo service. It never writes to normal data/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AttentionEngine} from '../core/engine.mjs';
import {createService} from '../core/server.mjs';
const now=Date.now(),start=now-90*60000;
const e=new AttentionEngine({now:start});e.isDemo=true;
e.action({action:'mode',mode:'flow'},start);
e.action({action:'start',text:'演示：阅读论文'},start);
for(let t=start;t<now;t+=5000){
  const mins=(t-start)/60000;
  if(mins<30)e.ingest({type:'window',app:'示例 · 阅读器',windowId:'demo-reader',idle_sec:2},t);
  else if(mins<60)e.ingest({type:'window',app:'示例 · Code',windowId:'demo-code',idle_sec:1},t);
  else if(mins<75){if((t-start)%300000===0)e.ingest({type:'manual',scene:'reading',label:'示例 · 纸质阅读'},t);else e.advance(t);}
  else if(mins<85)e.advance(t);
  else e.ingest({type:'window',app:'示例 · 资料检索',windowId:`demo-browser-${Math.floor(mins)%2}`,idle_sec:2},t);
}
e.advance(now);e.action({action:'checkin',text:'演示数据：这条记录由演示脚本生成，未采集任何真实窗口或画面。'},now);
const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'focuspendant-demo-'));
fs.writeFileSync(path.join(dataDir,'state.json'),JSON.stringify(e.serialize()));
const {server}=createService({dataDir,host:'127.0.0.1'});
server.listen(7789,'127.0.0.1',()=>console.log('演示数据（与日常记录隔离）→ http://localhost:7789'));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>process.exit(0)));
