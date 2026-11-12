import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// Public scheduling API fixture only. No wakeJob/tick, fake clock, or direct DB writes.
if(process.argv[2]==='--schedule') {
 const [,source,ws,ticket,due,tag]=process.argv.slice(2);
 const {buildRuntime}=await import(pathToFileURL(join(source,'runtime/build.ts')).href);
 const {DEFAULT_QUIET}=await import(pathToFileURL(join(source,'contracts.ts')).href);
 const b=buildRuntime({workspaceRoot:ws,policy:'P3',quiet:{...DEFAULT_QUIET,timezone:'UTC',fromHour:0,toHour:0,minGapMs:1500,reminderQuotaPerHour:100}});
 const task=b.runtime.getTask(ticket);
 const job=b.runtime.scheduler.schedule({ticketId:ticket,taskRevision:task.taskRevision,assignmentId:null,reason:'catch_up',decisionId:tag,dueAt:due,detail:'independent real-clock API scheduling fixture'});
 console.log(JSON.stringify({clock:b.clock.kind,job}));b.db.close();process.exit(0);
}
const [sourceArg,outArg]=process.argv.slice(2);
if(!sourceArg||!outArg)throw Error('usage: node realtime-service.mjs <task-followup-source> <NEW-output-dir>');
const source=resolve(sourceArg),out=resolve(outArg),self=fileURLToPath(import.meta.url);
if(existsSync(out))throw Error('output must be new');mkdirSync(out,{recursive:true});
const checks=[],results={},commands=[];let serial=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function check(scope,name,ok,detail=null){checks.push({scope,name,ok:Boolean(ok),detail});}
function save(path,obj){writeFileSync(path,JSON.stringify(obj,null,2));}
function wsFor(n){const p=join(out,n);mkdirSync(p,{recursive:true});return p;}
function argsFor(ws){return ['--workspace',ws,'--timezone','UTC','--quiet-from','0','--quiet-to','0','--min-gap-ms','1500','--reminder-quota','100'];}
function cli(ws,cmd,args=[],env={}){
 const startedAt=new Date().toISOString(),argv=['--experimental-transform-types','--no-warnings',join(source,'run.mjs'),cmd,...args,...argsFor(ws)];
 const clean={...process.env};delete clean.PET_FOLLOWUP_CRASH_AT;
 const r=spawnSync(process.execPath,argv,{cwd:source,encoding:'utf8',env:{...clean,...env},timeout:20000,maxBuffer:8*1024*1024});
 let json=null;try{json=JSON.parse(r.stdout);}catch{}
 const rec={startedAt,finishedAt:new Date().toISOString(),argv,exit:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr,json};save(join(out,`${String(++serial).padStart(3,'0')}-${cmd}.json`),rec);commands.push({cmd,exit:r.status});return rec;
}
function delegate(ws,name){const r=cli(ws,'delegate',['--title',name,'--goal','Independent realtime followup']);if(r.exit!==0||!r.json.ticketId)throw Error('delegate failed');return r.json.ticketId;}
function snapshot(ws,label){
 const db=new DatabaseSync(join(ws,'state/followup.sqlite'),{readOnly:true});const obj={at:new Date().toISOString()};
 for(const table of ['tasks','effects','receipts','attentions','notifications','wake_jobs','driver_log'])obj[table]=db.prepare('select * from '+table).all();db.close();save(join(ws,label+'.json'),obj);return obj;
}
function schedule(ws,ticket,delay,tag){
 const due=new Date(Date.now()+delay).toISOString(),argv=['--experimental-transform-types','--no-warnings',self,'--schedule',source,ws,ticket,due,tag];
 const r=spawnSync(process.execPath,argv,{encoding:'utf8',timeout:20000});let json=null;try{json=JSON.parse(r.stdout);}catch{}
 save(join(out,`${String(++serial).padStart(3,'0')}-schedule.json`),{argv,exit:r.status,stdout:r.stdout,stderr:r.stderr,json});if(r.status!==0||json?.clock!=='real')throw Error('real scheduling fixture failed');return json.job;
}
async function waitFor(fn,ms){const end=Date.now()+ms;while(Date.now()<end){const x=fn();if(x)return x;await sleep(80);}return null;}
function start(ws,name,limits=['--max-minutes','0.09']){
 const argv=['--experimental-transform-types','--no-warnings',join(source,'run.mjs'),'serve','--scheduler',...argsFor(ws),'--interval-ms','150','--wake-after-ms','1500',...limits];
 const child=spawn(process.execPath,argv,{cwd:source,env:{...process.env}});let stdout='',stderr='',exit=null;
 child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('exit',(code,signal)=>exit={code,signal});
 return {child,async running(){return await waitFor(()=>{try{const j=JSON.parse(readFileSync(join(ws,'state/service.json'),'utf8'));return j.pid===child.pid&&j.state==='running'?j:null;}catch{return null;}},12000);},async done(){await waitFor(()=>exit,15000);if(!exit){child.kill('SIGTERM');await waitFor(()=>exit,3000);}save(join(ws,name+'-process.json'),{argv,pid:child.pid,exit,stdout,stderr});return exit;}};
}
function serviceLog(ws){const p=join(ws,'state/service.log');return existsSync(p)?readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];}
try{
 // Actual app path: missing input -> persistent continuation -> restore while service runs.
 {const n='natural-continuation',ws=wsFor(n),t=delegate(ws,n);cli(ws,'seed',['--experiment','E17','--run','rt','--status','partial']);const observed=cli(ws,'observe',['--ticket',t,'--experiment','E17']);check(n,'initial question exists',observed.json?.task?.openAttention);
  const p=join(ws,'inbox/E17/result.json'),bytes=readFileSync(p);unlinkSync(p);const rejected=cli(ws,'answer',['--ticket',t,'--option','analyze_failing','--panel']);check(n,'known input refusal persisted',rejected.json?.task?.continuation&&rejected.json.task.attempt===1);
  const svc=start(ws,'service1');const meta=await svc.running();check(n,'independent service running on real clock',meta?.clock==='real'&&meta.timezone==='UTC');const before=snapshot(ws,'before-restoration');check(n,'before restoration no tool receipt',before.receipts.length===0&&before.effects.filter(x=>x.kind==='tool').length===1);
  writeFileSync(p,bytes);const visible=await waitFor(()=>{const z=snapshot(ws,'live-last');return z.attentions.find(a=>a.ticket_id===t&&a.state==='open'&&a.decision_key.startsWith('continuation:')&&(a.delivered_at||a.presented_at))??null;},9000);
  check(n,'without browser or CLI tick restored input automatically asks',visible);const after=snapshot(ws,'automatic-visible');check(n,'automatic question does not authorize execution',after.receipts.length===0&&after.tasks.find(x=>x.ticket_id===t)?.attempt===1);const noteCount=after.notifications.filter(x=>x.attention_id===visible?.attention_id).length;
  const end=await svc.done();check(n,'bounded real service exits normally',end?.code===0);const final=snapshot(ws,'after-service');check(n,'repeated service cycles do not repeat question delivery',final.notifications.filter(x=>x.attention_id===visible?.attention_id).length===noteCount);const quietJobs=final.wake_jobs.filter(x=>x.reason==='quiet'&&x.decision_id===visible?.decision_id);check(n,'one logical min-gap wait has at most one persisted job',quietJobs.length<=1,{count:quietJobs.length,jobs:quietJobs.map(j=>({id:j.job_id,due:j.due_at,status:j.status,attempts:j.attempts}))});
  const answer=cli(ws,'answer',['--ticket',t,'--option','retry_analysis','--panel']);check(n,'new visible authorization completes exactly once',answer.json?.task?.status==='completed'&&answer.json.task.attempt===2);const completed=snapshot(ws,'completed');check(n,'one actual tool receipt after new authorization',completed.receipts.length===1);results[n]={automaticAttention:visible?.attention_id,serviceClock:meta?.clock,notifications:noteCount,receipts:completed.receipts.length,wakeLog:serviceLog(ws).filter(x=>x.event==='wake').length};
 }
 // Deliberately scheduled future job, handled only by the real service, not a manual wake call.
 for(const mode of ['future-online','offline-cross-due']){
  const ws=wsFor(mode),t=delegate(ws,mode),job=schedule(ws,t,2200,mode);const before=snapshot(ws,'scheduled-before-service');check(mode,'future job persisted before due',before.wake_jobs.some(j=>j.job_id===job.jobId&&j.status==='scheduled'&&j.attempts===0)&&Date.now()<Date.parse(job.dueAt));
  if(mode==='offline-cross-due'){await sleep(Math.max(0,Date.parse(job.dueAt)-Date.now()+200));const offline=snapshot(ws,'overdue-service-absent');check(mode,'due passed while no service with no processing',Date.now()>Date.parse(job.dueAt)&&offline.wake_jobs.find(j=>j.job_id===job.jobId)?.attempts===0);}
  const svc=start(ws,'service1',mode==='future-online'?['--max-minutes','0.07']:['--max-iterations','4']);await svc.running();check(mode,'service exits normally',(await svc.done())?.code===0);const after=snapshot(ws,'after-service');const row=after.wake_jobs.find(j=>j.job_id===job.jobId),logs=serviceLog(ws).filter(x=>x.event==='wake'&&x.jobId===job.jobId);check(mode,'persisted job actually claimed and completed once',row?.status==='done'&&row.attempts===1);check(mode,'actual wake logged after due',logs.length===1&&logs[0].action==='woken'&&Date.parse(logs[0].at)>=Date.parse(job.dueAt));
  const repeat=start(ws,'service2',['--max-iterations','4']);await repeat.running();await repeat.done();const last=snapshot(ws,'after-repeat');check(mode,'restart does not reprocess same job',last.wake_jobs.find(j=>j.job_id===job.jobId)?.attempts===1&&serviceLog(ws).filter(x=>x.event==='wake'&&x.jobId===job.jobId).length===1);results[mode]={jobId:job.jobId,dueAt:job.dueAt,state:row?.status,attempts:row?.attempts,wakes:logs};
 }
 {const n='cancel-stale-unknown',ws=wsFor(n),cancel=delegate(ws,'cancel'),old=delegate(ws,'old-version'),unknown=delegate(ws,'unknown');const jc=schedule(ws,cancel,1200,'cancel'),jo=schedule(ws,old,1200,'old'),ju=schedule(ws,unknown,1200,'unknown');cli(ws,'cancel',['--ticket',cancel]);cli(ws,'change',['--ticket',old,'--goal','New current goal']);cli(ws,'seed',['--experiment','E17','--run','rt','--status','partial']);cli(ws,'observe',['--ticket',unknown,'--experiment','E17']);const cr=cli(ws,'answer',['--ticket',unknown,'--option','analyze_failing','--panel'],{PET_FOLLOWUP_CRASH_AT:'effect_running'});check(n,'unknown state from real process crash42',cr.exit===42);const before=snapshot(ws,'before-service');await sleep(Math.max(0,Date.parse(ju.dueAt)-Date.now()+100));const svc=start(ws,'service',['--max-iterations','5']);await svc.running();await svc.done();const after=snapshot(ws,'after-service');
  check(n,'cancel and obsolete task version cannot notify',after.notifications.filter(x=>x.ticket_id===cancel||x.ticket_id===old).length===before.notifications.filter(x=>x.ticket_id===cancel||x.ticket_id===old).length);check(n,'cancel and old-version job no longer runnable',[jc,jo].every(j=>after.wake_jobs.find(x=>x.job_id===j.jobId)?.status==='cancelled'));
  check(n,'unknown effect keeps reconciliation block and zero receipts',after.tasks.find(x=>x.ticket_id===unknown)?.stage==='needs_reconciliation'&&after.receipts.length===0&&after.effects.filter(x=>x.kind==='tool').length===1);check(n,'unknown cannot gain a new reminder',after.notifications.filter(x=>x.ticket_id===unknown).length===before.notifications.filter(x=>x.ticket_id===unknown).length);results[n]={cancelledJob:jc.jobId,oldJob:jo.jobId,unknownJob:ju.jobId,serviceEvents:serviceLog(ws)};
 }
}catch(error){check('harness','unexpected exception',false,{message:error.message,stack:error.stack});}
const summary={schema:'independent-r5-real-service/v1',source,out,node:process.version,platform:process.platform,createdAt:new Date().toISOString(),noFakeClock:true,noManualTickOrWake:true,noBrowser:true,checks,total:checks.length,failed:checks.filter(x=>!x.ok),results,commands};save(join(out,'summary.json'),summary);console.log(JSON.stringify({total:summary.total,failed:summary.failed,results},null,2));process.exitCode=summary.failed.length?1:0;
