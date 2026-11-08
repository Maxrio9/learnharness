import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'lh-adaptive-'));process.env.LH_DATA_DIR=join(root,'data');process.env.LH_AUTH_FILE=join(root,'auth.json');
const {jobStore}=await import('../src/store/jobs.ts');
const {experimentTool}=await import('../src/agent/tools/experiment.ts');
const {approveExperiment,startAttempt,proposeMore,setExperimentAdapter,readReceipt,keyLines}=await import('../src/server/experiments/service.ts');
const {parsePlan,planDigest,stripAdaptive}=await import('../src/server/experiments/plan.ts');

const PY='/usr/bin/python3';
const plan=(commands:string[][],extra:Record<string,unknown>={})=>({version:3,title:'Adaptive test',purpose:'Synthetic CPU test',commands,downloads:[],inputs:[],
 limits:{wallSeconds:20,memoryMiB:256,tasks:32,diskMiB:64,outputBytes:8192,stagedCacheMiB:1,artifactBytes:4096},network:'off',gpu:false,exports:[{path:'result.txt',maxBytes:1024}],environments:[],...extra});
const failing=[[PY,'-c',"import sys;print('boom: backend missing');sys.exit(3)"]];
const fixed=[[PY,'-c',"open('result.txt','w').write('ok');print('fixed run')"]];
const ctx={chatId:'chat_adaptive',jobStore,spawn:()=>{throw Error('No spawn');}};
let counter=0;
async function propose(p:unknown){const id='call'+(++counter);await experimentTool(ctx).execute(id,{action:'propose',plan:p} as never);return jobStore.findJobByToolCallId(ctx.chatId,id)!;}
async function approveAndSettle(job:{id:string;experiment?:{digest:string}}){
 approveExperiment(job.id,job.experiment!.digest,'learner-browser:local');
 const deadline=Date.now()+90000;while(jobStore.getJob(job.id)!.status==='running'){assert(Date.now()<deadline,'session did not settle');await new Promise(r=>setTimeout(r,50));}
 return jobStore.getJob(job.id)!;
}
const attemptsOf=(id:string)=>jobStore.listJobs(ctx.chatId).filter(j=>j.experiment?.parentJobId===id);

test('the envelope is part of the plan the approval digest covers, and is bounded',()=>{
 const withEnvelope=parsePlan(plan(fixed,{adaptive:{attempts:3,totalWallSeconds:120}}));
 assert.deepEqual(withEnvelope.adaptive,{attempts:3,totalWallSeconds:120});
 assert.notEqual(planDigest(withEnvelope),planDigest(stripAdaptive(withEnvelope)));
 assert.equal(stripAdaptive(withEnvelope).adaptive,undefined);
 for(const bad of [{attempts:1,totalWallSeconds:120},{attempts:7,totalWallSeconds:120},{attempts:3,totalWallSeconds:10},{attempts:3,totalWallSeconds:120,extra:1}])
  assert.throws(()=>parsePlan(plan(fixed,{adaptive:bad})),Error,JSON.stringify(bad));
 assert.throws(()=>parsePlan({...plan(fixed),version:2,adaptive:{attempts:3,totalWallSeconds:120}}),Error,'only version 3 has an envelope');
});

test('proposals get a modest default envelope that the learner sees in the plan',async()=>{
 const job=await propose(plan(fixed));
 const parsed=parsePlan(job.input);
 assert.deepEqual(parsed.adaptive,{attempts:4,totalWallSeconds:600});
 assert.equal(job.experiment?.digest,planDigest(parsed));
});

test('a failed attempt is corrected inside the same approval and the lesson hears about it once',async()=>{
 const seen:{tail:string;remaining:unknown}[]=[];let rejected='';
 setExperimentAdapter(async(request)=>{
  seen.push({tail:request.attempts[0]!.tail,remaining:request.remaining});
  try{startAttempt(request.parent.id,{commands:fixed,limits:{memoryMiB:512}});}catch(error){rejected=String((error as Error).message);}
  startAttempt(request.parent.id,{commands:fixed,title:'Adaptive test (fixed)'});
  return {note:''};
 });
 const job=await propose(plan(failing,{adaptive:{attempts:3,totalWallSeconds:120}}));
 const done=await approveAndSettle(job);
 assert.equal(seen.length,1);
 assert.match(seen[0]!.tail,/boom: backend missing/);
 assert.match(seen[0]!.tail,/outcome error, exit code \d+/);
 assert.equal((seen[0]!.remaining as {attempts:number}).attempts,2);assert.ok((seen[0]!.remaining as {wallSeconds:number}).wallSeconds<=120);
 assert.match(rejected,/cannot exceed the approved 256/,'limits can only go down');
 const kids=attemptsOf(job.id);assert.equal(kids.length,1);
 assert.equal(done.status,'done');
 const result=done.result as {outcome:string;receiptId:string;evidence?:string;artifacts?:{name:string}[]};
 assert.equal(result.outcome,'done');assert.equal(result.receiptId,kids[0]!.id);
 assert.match(result.evidence??'',/attempt 1: error/);assert.match(result.evidence??'',/attempt 2: done/);
 assert.deepEqual(result.artifacts?.map(a=>a.name),['result.txt']);
 const grant=JSON.parse(readFileSync(join(process.env.LH_DATA_DIR!,'admin/experiments/grants',kids[0]!.id+'.json'),'utf8'));
 assert.equal(grant.source,'approval-envelope:'+job.id);assert.equal(grant.chatId,ctx.chatId);
 assert.equal(grant.approvedAt,JSON.parse(readFileSync(join(process.env.LH_DATA_DIR!,'admin/experiments/grants',job.id+'.json'),'utf8')).approvedAt,'the learner\'s approval time is carried over');
 const receipt=readReceipt(kids[0]!.id) as {authorization:{source:string}};assert.equal(receipt.authorization.source,'approval-envelope:'+job.id);
 assert.equal(kids[0]!.status,'done');assert.equal(kids[0]!.delivery,undefined,'intermediate attempts never post to the lesson');
});

test('attempt and time budgets end the session with the honest final failure',async()=>{
 let calls=0;
 setExperimentAdapter(async(request)=>{calls++;startAttempt(request.parent.id,{commands:failing});return {note:''};});
 const job=await propose(plan(failing,{adaptive:{attempts:2,totalWallSeconds:120}}));
 const done=await approveAndSettle(job);
 assert.equal(calls,1,'the second failure has no attempt left to adjust');
 assert.equal(done.status,'error');
 const result=done.result as {outcome:string;evidence?:string};
 assert.equal(result.outcome,'error');assert.match(result.evidence??'',/All approved attempts were used/);assert.match(result.evidence??'',/attempt 2: error/);
 assert.equal(attemptsOf(job.id).length,1);
});

test('giving up, no agent, and plans without an envelope all settle at once',async()=>{
 setExperimentAdapter(async()=>({note:'The agent stopped adjusting: it needs a new download'}));
 let done=await approveAndSettle(await propose(plan(failing,{adaptive:{attempts:3,totalWallSeconds:120}})));
 assert.equal(done.status,'error');assert.match((done.result as {evidence:string}).evidence,/needs a new download/);
 setExperimentAdapter(undefined);
 done=await approveAndSettle(await propose(plan(failing,{adaptive:{attempts:3,totalWallSeconds:120}})));
 assert.equal(done.status,'error');assert.match((done.result as {evidence:string}).evidence,/No adjusting agent was available/);
 let called=false;setExperimentAdapter(async()=>{called=true;return {note:''};});
 const job=await propose(plan(failing)); // default envelope
 parsePlan(job.input);
 const strict=jobStore.createJob({kind:'experiment',chatId:ctx.chatId,toolCallId:'strict',input:parsePlan(plan(failing)),activity:'awaiting approval'});
 jobStore.updateJob(strict.id,{experiment:{state:'awaiting_approval',digest:planDigest(parsePlan(plan(failing))),expiresAt:Date.now()+60000}});
 done=await approveAndSettle(jobStore.getJob(strict.id)!);
 assert.equal(done.status,'error');assert.equal(called,false,'a plan approved without an envelope is never adjusted');
});

test('a new proposal supersedes an older one that was never approved',async()=>{
 const first=await propose(plan(fixed));const second=await propose(plan(fixed,{title:'Second'}));
 const old=jobStore.getJob(first.id)!;
 assert.equal(old.status,'error');assert.equal(old.experiment?.state,'revoked');assert.match(old.error??'',/Superseded/);
 assert.equal(jobStore.getJob(second.id)!.experiment?.state,'awaiting_approval');
 assert.throws(()=>approveExperiment(first.id,first.experiment!.digest,'learner-browser:local'));
});

test('the agent can ask for extra downloads in one new proposal, and the session ends pointing at it',async()=>{
 const wheel={name:'cuda_tool-1.0-py3-none-any.whl',url:'https://files.pythonhosted.org/packages/aa/bb/cuda_tool-1.0-py3-none-any.whl',sha256:'a'.repeat(64),maxBytes:50*1048576};
 let proposedId='';let rejected='';
 setExperimentAdapter(async(request)=>{
  try{proposeMore(request.parent.id,{reason:'x',downloads:[{...wheel,sha256:'b'.repeat(64),name:'cuda_tool-1.0-py3-none-any.whl'},{...wheel}],commands:fixed});}catch(error){rejected=String((error as Error).message);}
  proposedId=proposeMore(request.parent.id,{reason:'The kernels need the CUDA compiler.',downloads:[wheel],environments:[{name:'cuda',addWheels:[wheel.name],maxInstalledMiB:1024}],commands:fixed,title:'With the CUDA compiler'}).jobId;
  return {note:'The agent asked the learner for additional downloads in a new proposal ('+proposedId+')'};
 });
 const done=await approveAndSettle(await propose(plan(failing,{adaptive:{attempts:3,totalWallSeconds:120}})));
 assert.match(rejected,/already exists with a different identity/);
 const fresh=jobStore.getJob(proposedId)!;
 const asked=parsePlan(fresh.input);
 assert.equal(fresh.experiment?.state,'awaiting_approval');assert.equal(fresh.status,'running');
 assert.deepEqual(asked.downloads.map(d=>d.name),[wheel.name]);
 assert.deepEqual(asked.environments?.map(e=>({n:e.name,w:e.wheels})),[{n:'cuda',w:[wheel.name]}]);
 assert.deepEqual(asked.adaptive,{attempts:4,totalWallSeconds:600});
 assert.match(asked.purpose,/^The kernels need the CUDA compiler\./);
 assert.equal(asked.title,'With the CUDA compiler');
 assert.equal(done.status,'error');assert.match((done.result as {evidence:string}).evidence,/additional downloads in a new proposal/);
 assert.equal(fresh.experiment?.digest,planDigest(asked));
});

test('failure evidence keeps root-cause lines from the middle of a long log',()=>{
 const filler=Array.from({length:400},(_,i)=>`progress step ${i} ok`).join('\n');
 const log=`start\n${filler}\nerror: #error -- unsupported GNU version! gcc versions later than 15 are not supported!\nfatal: posix_spawn: Resource temporarily unavailable\n${filler}\nRuntimeError: Engine core initialization failed`;
 const keys=keyLines(log);
 assert.match(keys,/unsupported GNU version/);assert.match(keys,/posix_spawn/);assert.match(keys,/Engine core initialization failed/);
 assert.ok(!/progress step/.test(keys));assert.ok(keys.length<=2300);
 assert.equal(keyLines(log+'\n'+log).split('\n').filter(l=>/unsupported GNU/.test(l)).length,1,'duplicates collapse');
});

test('an attempt can only start while the server holds a session open',()=>{
 assert.throws(()=>startAttempt('job_unknown_0000',{commands:fixed}),/No adjustment is open/);
});

test('the agent tool decodes string-encoded arguments and can only act through the service',async()=>{
 const {attemptTool,prepareAttemptArguments}=await import('../src/agent/tools/experiment-attempt.ts');
 let gaveUp='';let outcome='';
 setExperimentAdapter(async(request)=>{
  const tool=attemptTool(request.parent.id,(reason)=>{gaveUp=reason;});
  const decoded=prepareAttemptArguments({action:'retry',commands:JSON.stringify(fixed),limits:'{"memoryMiB":128}'}) as {commands:unknown;limits:unknown};
  assert.ok(Array.isArray(decoded.commands)&&typeof decoded.limits==='object');
  const result=await tool.execute('t1',{action:'retry',...decoded} as never,new AbortController().signal) as {content:{text:string}[]};
  outcome=result.content.map(c=>c.text).join(' ');
  await tool.execute('t2',{action:'give_up',reason:'not needed'} as never,new AbortController().signal);
  return {note:''};
 });
 const done=await approveAndSettle(await propose(plan(failing,{adaptive:{attempts:3,totalWallSeconds:120}})));
 assert.match(outcome,/Attempt 2 started/);assert.equal(gaveUp,'not needed');assert.equal(done.status,'done');
});

test('cancelling while the agent is adjusting ends the session as cancelled',async()=>{
 let started!:()=>void;const adapting=new Promise<void>(resolve=>{started=resolve;});
 setExperimentAdapter(async(_request,signal)=>{started();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));return {note:''};});
 const job=await propose(plan(failing,{adaptive:{attempts:3,totalWallSeconds:120}}));
 approveExperiment(job.id,job.experiment!.digest,'learner-browser:local');
 await adapting;
 const {abortJob}=await import('../src/server/jobs.ts');
 assert.deepEqual(abortJob(job.id),{ok:true});
 const deadline=Date.now()+30000;while(jobStore.getJob(job.id)!.status==='running'){assert(Date.now()<deadline,'cancelled session did not settle');await new Promise(r=>setTimeout(r,50));}
 const done=jobStore.getJob(job.id)!;
 assert.equal(done.status,'error');assert.equal(done.experiment?.state,'revoked');assert.equal(attemptsOf(job.id).length,0);
 assert.throws(()=>startAttempt(job.id,{commands:fixed}),/No adjustment is open/);
});
process.on('exit',()=>rmSync(root,{recursive:true,force:true}));
