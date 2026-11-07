import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { parsePlan, planDigest } from '../src/server/experiments/plan.ts';

const wheel = {
 name:'six-1.17.0-py2.py3-none-any.whl',
 url:'https://files.pythonhosted.org/packages/b7/ce/149a00dd41f10bc29e5921b496af8b574d8413afcd5e30dfa0ed46c2cc5e/six-1.17.0-py2.py3-none-any.whl',
 sha256:'4721f391ed90541fddacab5acf947aa0d3dc7d27b2e1e8eda2be8970586c3274',
 maxBytes:11050,
};
const idna={name:'idna-3.10-py3-none-any.whl',url:'https://files.pythonhosted.org/packages/76/c6/c88e154df9c4e1a2a66ccf0005a88dfb2650c1dffb6f5ce603dfbd452ce3/idna-3.10-py3-none-any.whl',sha256:'946d195a0d259cbba61165e88e65941f16e9b36ea6ddb97f00452bae8b1287d3',maxBytes:70442};
const plan={
 version:3,title:'Reusable environment integration check',purpose:'Compare two isolated processes through one approval.',
 commands:[['/environments/first/python','-c',"import six; print(six.__version__); open('/workspace/result.txt','w').write(six.__version__)"],['/environments/second/python','-c',"import idna,os; print(idna.__version__); assert idna.__file__.startswith('/environments/second/'); assert os.statvfs(idna.__file__).f_flag & os.ST_RDONLY"]],
 downloads:[wheel,idna],inputs:[],limits:{wallSeconds:90,memoryMiB:256,tasks:32,diskMiB:8,outputBytes:4096,stagedCacheMiB:1,artifactBytes:1024},network:'off',gpu:false,exports:[{path:'result.txt',maxBytes:1024}],
 environments:[{name:'first',wheels:[wheel.name],maxInstalledMiB:4},{name:'second',wheels:[idna.name],maxInstalledMiB:4}],
};
test('approval digest binds distinct environment definitions and rejects implicit wheel inputs',()=>{
 assert.notEqual(planDigest(plan),planDigest({...plan,environments:[plan.environments[0]]}));
 assert.throws(()=>parsePlan({...plan,environments:[{...plan.environments[0],wheels:['missing.whl']}]}),/declared wheel/);
 assert.throws(()=>parsePlan({...plan,environments:[plan.environments[0],plan.environments[0]]}),/Duplicate environments/);
 const model={repo:'Qwen/Qwen3-1.7B',revision:'a'.repeat(40),files:[{name:'config.json',sha256:'b'.repeat(64),bytes:123}]};
 assert.notEqual(planDigest(plan),planDigest({...plan,model}));
 assert.throws(()=>parsePlan({...plan,model:{...model,files:[{...model.files[0],name:'../config.json'}]}}),/Invalid model file/);
});

const cuda=`import ctypes as c
lib=c.CDLL("libcuda.so.1")
def call(name,*args):
 r=getattr(lib,name)(*args)
 if r:raise RuntimeError(f"{name}: CUDA status {r}")
d=c.c_int(); ctx=c.c_void_p(); ptr=c.c_uint64(); out=c.c_uint32()
call("cuInit",0);call("cuDeviceGet",c.byref(d),0);call("cuCtxCreate_v2",c.byref(ctx),0,d)
try:
 call("cuMemAlloc_v2",c.byref(ptr),c.c_size_t(16*1024*1024))
 try:
  call("cuMemsetD32_v2",ptr,c.c_uint32(0x1234),c.c_size_t(16*1024*1024//4))
  call("cuMemcpyDtoH_v2",c.byref(out),ptr,c.c_size_t(4))
  assert out.value==0x1234
  print("verified CUDA fill and readback")
 finally:call("cuMemFree_v2",ptr)
finally:call("cuCtxDestroy_v2",ctx)
`;

test('one browser approval runs both prepared environments, then a new run reuses them and exports evidence',
 {skip:process.env.LH_EXPERIMENT_V3_PILOT!=='1',timeout:240000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'lh-experiment-v3-'));
 process.env.LH_DATA_DIR=join(root,'data');process.env.LH_AUTH_FILE=join(root,'auth.json');
 try {
  const {jobStore}=await import('../src/store/jobs.ts');
  const {chatStore}=await import('../src/store/chats.ts');
  const {createJobRunner,researchModelOverride}=await import('../src/agent/subagents/runner.ts');
  const {experimentDispatchTool}=await import('../src/agent/tools/experiment-dispatch.ts');
  const {POST}=await import('../app/api/experiments/[jobId]/approve/route.ts');
  const {inspectExperiments,readReceipt,recoverExperiment}=await import('../src/server/experiments/service.ts');
  const {artifactResponse}=await import('../src/server/experiments/artifacts.ts');
  const {setTurnRunner,noteSteersDurable}=await import('../src/server/jobs.ts');
  setTurnRunner(async(id,input)=>{if(input.type!=='steers')return 500;chatStore.saveMessages(id,[...chatStore.getChat(id)!.messages,...input.steers]);noteSteersDurable(id,input.steers);return 200;});
  const runner=createJobRunner({chatStore,jobStore,deliver:async()=>{}});
  const chat=chatStore.createChat('isolated reusable environments pilot');
  const lockDir=join(root,'data','admin','experiments','environment-locks');mkdirSync(lockDir,{recursive:true,mode:0o700});
  const locks=plan.environments.map((e,i)=>{const bytes=JSON.stringify({label:e.name,maxInstalledMiB:e.maxInstalledMiB,wheels:[plan.downloads[i]]});const lockId=createHash('sha256').update(bytes).digest('hex');writeFileSync(join(lockDir,lockId+'.json'),bytes,{mode:0o600});return {name:e.name,lockId};});
  const recipeDir=join(root,'data','admin','experiments','recipes');mkdirSync(recipeDir,{mode:0o700});
  const recipeBytes=JSON.stringify(plan),recipeId=createHash('sha256').update(recipeBytes).digest('hex');
  writeFileSync(join(recipeDir,recipeId+'.json'),recipeBytes,{mode:0o600});
  assert.deepEqual((inspectExperiments().recipes as {id:string}[]).map(r=>r.id),[recipeId]);
  async function execute(input:typeof plan,toolCallId:string,useRecipe=false){
   const faux=createFauxCore({tokenSize:{min:64,max:64}});
   const {downloads:_downloads,environments:_environments,...draft}=input;
   faux.setResponses([fauxAssistantMessage([fauxToolCall('experiment',useRecipe?{action:'propose_recipe',recipeId}:{action:'propose_locked',plan:draft,locks},{id:'propose'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Ready for review.')])]);
   researchModelOverride.current={model:faux.getModel(),streamFn:faux.streamSimple};
   let planned:Promise<void>|undefined;
   await experimentDispatchTool({chatId:chat.id,jobStore,spawn:(job,task)=>{planned=runner.runJob(job.id,task);}}).execute(toolCallId,{question:'Run the approved integration fixture'});
   await planned;
   const planner=jobStore.findJobByToolCallId(chat.id,toolCallId)!;
   const proposal=jobStore.findJobByToolCallId(chat.id,`experiment-proposal-${planner.id}`)!;
   assert.equal(proposal.experiment?.state,'awaiting_approval',planner.error);
   if(useRecipe)assert.equal(proposal.experiment!.digest,planDigest(input));
   assert(!existsSync(join(root,'data','admin','experiments','grants',proposal.id+'.json')));
   const approve=()=>POST(new Request(`http://localhost:3934/api/experiments/${proposal.id}/approve`,{method:'POST',headers:{origin:'http://localhost:3934','sec-fetch-site':'same-origin','sec-fetch-mode':'cors','content-type':'application/json'},body:JSON.stringify({digest:proposal.experiment!.digest})}),{params:Promise.resolve({jobId:proposal.id})});
   assert.equal((await approve()).status,200);
   assert.equal((await approve()).status,409);
   const deadline=Date.now()+110000;
   while(jobStore.getJob(proposal.id)!.status==='running'){assert(Date.now()<deadline,'operator timeout');await new Promise(r=>setTimeout(r,50));}
   const receipt=readReceipt(proposal.id) as {outcome:string;stdout:string;stderr:string;error?:string;cleanup:{empty:boolean};gpuReleasedAfterCleanup?:boolean;environments:{name:string;id:string;reused:boolean}[];artifacts:{name:string;sha256:string}[]};
   assert.equal(receipt.outcome,'done',JSON.stringify({error:receipt.error,stdout:receipt.stdout,stderr:receipt.stderr}));
   assert(receipt.cleanup.empty);
   while(jobStore.getJob(proposal.id)!.delivery?.status!=='delivered'){assert(Date.now()<deadline,'delivery timeout');await new Promise(r=>setTimeout(r,50));}
   return {receipt,id:proposal.id};
  }
  const first=await execute(plan,'build');
  assert.deepEqual(first.receipt.environments.map(x=>x.name),['first','second']);
  assert.match(first.receipt.stdout,/1.17.0/);
  assert.equal(await (await artifactResponse(first.id,first.receipt.artifacts[0]!.sha256)).text(),'1.17.0');
  const second=await execute(plan,'reuse',true);
  assert(second.receipt.environments.every(e=>e.reused));
  assert.deepEqual(second.receipt.environments.map(e=>e.id),first.receipt.environments.map(e=>e.id));
  if(process.env.LH_EXPERIMENT_V3_GPU_PILOT==='1'){
   const profile=await execute({...plan,title:'Nsight CUDA profile',gpu:true,commands:[['/usr/bin/nsys','profile','--trace=cuda','--sample=none','--cpuctxsw=none','--force-overwrite=true','--output=/workspace/gpu-trace','/environments/first/python','-c',cuda]],limits:{...plan.limits,memoryMiB:3072,tasks:64,diskMiB:256,artifactBytes:32*1048576},exports:[{path:'gpu-trace.nsys-rep',maxBytes:32*1048576}]},'profile');
   assert.match(profile.receipt.stdout,/verified CUDA fill and readback/);
   assert(profile.receipt.gpuReleasedAfterCleanup);
   const artifact=profile.receipt.artifacts.find(a=>a.name==='gpu-trace.nsys-rep')!;
   const file=join(root,'gpu-trace.nsys-rep');
   writeFileSync(file,Buffer.from(await (await artifactResponse(profile.id,artifact.sha256)).arrayBuffer()));
   const report=execFileSync('/usr/bin/nsys',['stats','--report','cuda_gpu_mem_time_sum','--format','csv',file],{encoding:'utf8',timeout:20000});
   assert.match(report,/CUDA (?:memcpy|memset)|DtoH/i);
   const reportCopy=process.env.LH_EXPERIMENT_V3_PROFILE_REPORT;
   if(reportCopy)writeFileSync(reportCopy,report,{mode:0o600,flag:'wx'});
  }
  const interrupted=jobStore.createJob({chatId:chat.id,kind:'experiment',toolCallId:'interrupted-before-launch',input:plan});
  jobStore.updateJob(interrupted.id,{experiment:{state:'consumed',digest:planDigest(plan),expiresAt:Date.now()+30000}});
  await recoverExperiment(jobStore.getJob(interrupted.id)!);
  assert.equal(jobStore.getJob(interrupted.id)?.status,'error');
  assert(existsSync(join(root,'data','admin','experiments','launches',interrupted.id+'.cancel')));
  assert.deepEqual((readReceipt(interrupted.id) as {cleanup:{empty:boolean;launched:boolean}}).cleanup.launched,false);
  const recoveryDeadline=Date.now()+5000;
  while(jobStore.getJob(interrupted.id)?.delivery?.status!=='delivered'){assert(Date.now()<recoveryDeadline,'recovery delivery timeout');await new Promise(r=>setTimeout(r,50));}
  const terminalPlan={...plan,downloads:[],environments:[],exports:[],commands:[['/usr/bin/true']]};
  const terminal=jobStore.createJob({chatId:chat.id,kind:'experiment',toolCallId:'interrupted-after-cleanup',input:terminalPlan});
  const digest=planDigest(terminalPlan),admin=join(root,'data','admin','experiments');
  jobStore.updateJob(terminal.id,{experiment:{state:'consumed',digest,expiresAt:Date.now()+30000}});
  writeFileSync(join(admin,'launches',terminal.id+'.json'),'{}',{mode:0o600});
  writeFileSync(join(admin,'receipts',terminal.id+'.json'),JSON.stringify({jobId:terminal.id,plan:terminalPlan,planDigest:digest,phase:'terminal',outcome:'done',exitCode:0,stdout:'completed before restart',cleanup:{empty:true},artifacts:[]}),{mode:0o600});
  await recoverExperiment(jobStore.getJob(terminal.id)!);
  assert.equal(jobStore.getJob(terminal.id)?.status,'done');
  assert.equal((readReceipt(terminal.id) as {stdout:string}).stdout,'completed before restart');
  while(jobStore.getJob(terminal.id)?.delivery?.status!=='delivered'){assert(Date.now()<recoveryDeadline,'terminal recovery delivery timeout');await new Promise(r=>setTimeout(r,50));}
  researchModelOverride.current=undefined;
 }finally{rmSync(root,{recursive:true,force:true});}
});
