import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFauxCore,fauxAssistantMessage,fauxText,fauxToolCall} from '@earendil-works/pi-ai';
const root=mkdtempSync(join(tmpdir(),'lh-agent-e2e-'));
process.env.LH_DATA_DIR=join(root,'data');process.env.LH_AUTH_FILE=join(root,'auth.json');
const {jobStore}=await import('../src/store/jobs.ts');
const {chatStore}=await import('../src/store/chats.ts');
const {createJobRunner,researchModelOverride}=await import('../src/agent/subagents/runner.ts');
const {experimentDispatchTool}=await import('../src/agent/tools/experiment-dispatch.ts');
const {decodeStructuredFields,experimentTool,prepareExperimentArguments}=await import('../src/agent/tools/experiment.ts');
const {Value}=await import('typebox/value');
const {approveExperiment,readReceipt,redeliverReceipt}=await import('../src/server/experiments/service.ts');
const {POST:approveRoute}=await import('../app/api/experiments/[jobId]/approve/route.ts');
const {setTurnRunner,noteSteersDurable}=await import('../src/server/jobs.ts');
const plan={version:2,title:'Synthetic CPU check',purpose:'Test the experiment agent handoff',commands:[['/usr/bin/python3','-c','print(2+2)']],downloads:[],inputs:[],limits:{wallSeconds:10,memoryMiB:128,tasks:16,diskMiB:8,outputBytes:4096,stagedCacheMiB:0,artifactBytes:0},network:'off',gpu:false,exports:[]};
test('specialist dispatch creates an inert proposal; approval runs sandbox and produces receipt',async()=>{
 const chat=chatStore.createChat('isolated experiment agent test');
 setTurnRunner(async(id,input)=>{if(input.type!=='steers')return 500; chatStore.saveMessages(id,[...chatStore.getChat(id)!.messages,...input.steers]); noteSteersDurable(id,input.steers); return 200;});
 const faux=createFauxCore({tokenSize:{min:64,max:64}});
 faux.setResponses([fauxAssistantMessage([fauxToolCall('experiment',{action:'inspect'},{id:'inspect'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxToolCall('experiment',{action:'propose',plan},{id:'propose'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('The proposal is ready for review.')])]);
 researchModelOverride.current={model:faux.getModel(),streamFn:faux.streamSimple};
 const delivered:unknown[]=[];
 const runner=createJobRunner({chatStore,jobStore,deliver:async s=>{delivered.push(s);}});
 let run:Promise<void>|undefined;
 const tool=experimentDispatchTool({chatId:chat.id,jobStore,spawn:(job,input)=>{run=runner.runJob(job.id,input);}});
 await tool.execute('call_dispatch',{question:'Measure a simple calculation'});
 await run;
 const parent=jobStore.findJobByToolCallId(chat.id,'call_dispatch')!;
 assert.equal(parent.status,'done');assert.equal(delivered.length,1);
 const proposal=jobStore.findJobByToolCallId(chat.id,`experiment-proposal-${parent.id}`)!;
 assert.equal(proposal.experiment?.state,'awaiting_approval');assert.equal(proposal.status,'running');
 const request=new Request(`http://localhost:3934/api/experiments/${proposal.id}/approve`,{method:'POST',headers:{origin:'http://localhost:3934','sec-fetch-site':'same-origin','sec-fetch-mode':'cors','content-type':'application/json'},body:JSON.stringify({digest:proposal.experiment!.digest})});
 assert.equal((await approveRoute(request,{params:Promise.resolve({jobId:proposal.id})})).status,200);
 const deadline=Date.now()+20000;
 while(jobStore.getJob(proposal.id)!.status==='running'){assert(Date.now()<deadline,'operator timeout');await new Promise(r=>setTimeout(r,30));}
 const receipt=readReceipt(proposal.id) as {outcome:string;stdout:string;cleanup:{empty:boolean};error?:string};
 assert.equal(receipt.outcome,'done',receipt.error);assert.match(receipt.stdout,/4/);assert.equal(receipt.cleanup.empty,true);
 while(jobStore.getJob(proposal.id)!.delivery?.status!=='delivered'){assert(Date.now()<deadline,'delivery timeout');await new Promise(r=>setTimeout(r,30));}
 assert.throws(()=>approveExperiment(proposal.id,proposal.experiment!.digest,'admin-pilot:t_52985150'));
 const corrected=await redeliverReceipt(proposal.id);
 assert.equal(corrected.steerId,`steer_${proposal.id}_evidence`);
 const waitDeadline=Date.now()+5000;
 while(!chatStore.getChat(chat.id)!.messages.some(m=>(m as {id?:string}).id===corrected.steerId)){assert(Date.now()<waitDeadline,'corrected receipt not delivered');await new Promise(r=>setTimeout(r,30));}
 const steer=JSON.stringify(chatStore.getChat(chat.id)!.messages.find(m=>(m as {id?:string}).id===corrected.steerId));
 assert.match(steer,/CORRECTED RECEIPT/);assert.match(steer,/Execution facts from the native receipt/);assert.match(steer,/supersedes any earlier/);
 await assert.rejects(()=>redeliverReceipt(proposal.id),/already delivered/);
 researchModelOverride.current=undefined;
});
process.on('exit',()=>rmSync(root,{recursive:true,force:true}));
test('unavailable local planner falls back without losing the proposal',async()=>{
 const chat=chatStore.createChat('isolated fallback test');
 const primary=createFauxCore({tokenSize:{min:64,max:64}});primary.setResponses([()=>{throw new Error('423 background deferred');}]);
 const fallback=createFauxCore({tokenSize:{min:64,max:64}});fallback.setResponses([fauxAssistantMessage([fauxToolCall('experiment',{action:'propose',plan},{id:'p'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Ready for approval.')])]);
 researchModelOverride.current={model:fallback.getModel(),streamFn:fallback.streamSimple};
 const local={model:primary.getModel(),streamFn:primary.streamSimple};
 const runner=createJobRunner({chatStore,jobStore,deliver:async()=>{},experimentEngine:()=>local});
 let run:Promise<void>|undefined;
 await experimentDispatchTool({chatId:chat.id,jobStore,spawn:(job,input)=>{run=runner.runJob(job.id,input);}}).execute('fallback-dispatch',{question:'Synthetic diagnostic'});
 await run;
 const job=jobStore.findJobByToolCallId(chat.id,'fallback-dispatch')!;
 assert.equal(job.status,'done',job.error);
 assert.equal(jobStore.findJobByToolCallId(chat.id,`experiment-proposal-${job.id}`)?.experiment?.state,'awaiting_approval');
 researchModelOverride.current=undefined;
});
test('empty local report (reasoning-only output) falls back instead of failing the job',async()=>{
 const chat=chatStore.createChat('isolated empty-report fallback test');
 const primary=createFauxCore({tokenSize:{min:64,max:64}});primary.setResponses([fauxAssistantMessage([fauxText('')])]);
 const fallback=createFauxCore({tokenSize:{min:64,max:64}});
 fallback.setResponses([fauxAssistantMessage([fauxToolCall('experiment',{action:'propose',plan},{id:'p'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Ready for approval.')])]);
 researchModelOverride.current={model:fallback.getModel(),streamFn:fallback.streamSimple};
 const local={model:primary.getModel(),streamFn:primary.streamSimple};
 const runner=createJobRunner({chatStore,jobStore,deliver:async()=>{},experimentEngine:()=>local});
 let run:Promise<void>|undefined;
 await experimentDispatchTool({chatId:chat.id,jobStore,spawn:(job,input)=>{run=runner.runJob(job.id,input);}}).execute('empty-dispatch',{question:'Synthetic diagnostic'});
 await run;
 const job=jobStore.findJobByToolCallId(chat.id,'empty-dispatch')!;
 assert.equal(job.status,'done',job.error);
 assert.equal(jobStore.findJobByToolCallId(chat.id,`experiment-proposal-${job.id}`)?.experiment?.state,'awaiting_approval');
 researchModelOverride.current=undefined;
});

test('turn cap without a proposal gets one wrap-up call and then succeeds',async()=>{
 const chat=chatStore.createChat('turn cap wrap-up test');
 const faux=createFauxCore({tokenSize:{min:64,max:64}});
 const inspect=()=>fauxAssistantMessage([fauxToolCall('experiment',{action:'inspect'},{id:'i'+Math.random()})],{stopReason:'toolUse'});
 faux.setResponses([...Array.from({length:40},inspect),fauxAssistantMessage([fauxToolCall('experiment',{action:'propose',plan},{id:'p'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Ready for approval.')])]);
 researchModelOverride.current={model:faux.getModel(),streamFn:faux.streamSimple};
 const runner=createJobRunner({chatStore,jobStore,deliver:async()=>{}});
 let run:Promise<void>|undefined;
 await experimentDispatchTool({chatId:chat.id,jobStore,spawn:(job,input)=>{run=runner.runJob(job.id,input);}}).execute('cap-dispatch',{question:'Needs many steps'});
 await run;
 const job=jobStore.findJobByToolCallId(chat.id,'cap-dispatch')!;
 assert.equal(job.status,'done',job.error);
 assert.equal(jobStore.findJobByToolCallId(chat.id,`experiment-proposal-${job.id}`)?.experiment?.state,'awaiting_approval');
 researchModelOverride.current=undefined;
});
test('turn cap and a failed wrap-up fail the job instead of reporting a finished report',async()=>{
 const chat=chatStore.createChat('turn cap failure test');
 const faux=createFauxCore({tokenSize:{min:64,max:64}});
 const inspect=()=>fauxAssistantMessage([fauxToolCall('experiment',{action:'inspect'},{id:'j'+Math.random()})],{stopReason:'toolUse'});
 faux.setResponses(Array.from({length:60},inspect));
 researchModelOverride.current={model:faux.getModel(),streamFn:faux.streamSimple};
 const runner=createJobRunner({chatStore,jobStore,deliver:async()=>{}});
 let run:Promise<void>|undefined;
 await experimentDispatchTool({chatId:chat.id,jobStore,spawn:(job,input)=>{run=runner.runJob(job.id,input);}}).execute('cap-fail-dispatch',{question:'Never converges'});
 await run;
 const job=jobStore.findJobByToolCallId(chat.id,'cap-fail-dispatch')!;
 assert.equal(job.status,'error');
 assert.match(String(job.error),/ran out of turns before submitting a proposal/);
 assert.match(String(job.error),/experiment/);
 researchModelOverride.current=undefined;
});
test('a local run that exhausts its turns falls back to the configured researcher',async()=>{
 const chat=chatStore.createChat('exhausted local fallback test');
 const primary=createFauxCore({tokenSize:{min:64,max:64}});
 primary.setResponses(Array.from({length:60},()=>fauxAssistantMessage([fauxToolCall('experiment',{action:'inspect'},{id:'k'+Math.random()})],{stopReason:'toolUse'})));
 const fallback=createFauxCore({tokenSize:{min:64,max:64}});
 fallback.setResponses([fauxAssistantMessage([fauxToolCall('experiment',{action:'propose',plan},{id:'p'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Ready for approval.')])]);
 researchModelOverride.current={model:fallback.getModel(),streamFn:fallback.streamSimple};
 const local={model:primary.getModel(),streamFn:primary.streamSimple};
 const runner=createJobRunner({chatStore,jobStore,deliver:async()=>{},experimentEngine:()=>local});
 let run:Promise<void>|undefined;
 await experimentDispatchTool({chatId:chat.id,jobStore,spawn:(job,input)=>{run=runner.runJob(job.id,input);}}).execute('exhaust-dispatch',{question:'Local never converges'});
 await run;
 const job=jobStore.findJobByToolCallId(chat.id,'exhaust-dispatch')!;
 assert.equal(job.status,'done',job.error);
 assert.equal(jobStore.findJobByToolCallId(chat.id,`experiment-proposal-${job.id}`)?.experiment?.state,'awaiting_approval');
 researchModelOverride.current=undefined;
});

test('a plan sent as a JSON-encoded string is decoded unchanged; other malformed values still fail',async()=>{
 const same=decodeStructuredFields({action:'inspect'});assert.deepEqual(same,{action:'inspect'});
 const encoded={action:'propose',plan:JSON.stringify(plan)};
 assert.deepEqual((decodeStructuredFields(encoded) as {plan:unknown}).plan,plan);
 assert.deepEqual((decodeStructuredFields({action:'propose_locked',plan:JSON.stringify(plan),locks:'[{"a":1}]'}) as {locks:unknown}).locks,[{a:1}]);
 const broken={action:'propose',plan:'{"title":'};assert.equal(decodeStructuredFields(broken),broken);
 const wrongShape={action:'propose_locked',plan:'[1]',locks:'{"a":1}'};assert.deepEqual(decodeStructuredFields(wrongShape),wrongShape);
 const chat=chatStore.createChat('encoded plan test');
 const faux=createFauxCore({tokenSize:{min:64,max:64}});
 faux.setResponses([fauxAssistantMessage([fauxToolCall('experiment',{action:'propose',plan:JSON.stringify(plan)} as never,{id:'enc'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Ready for approval.')])]);
 researchModelOverride.current={model:faux.getModel(),streamFn:faux.streamSimple};
 const runner=createJobRunner({chatStore,jobStore,deliver:async()=>{}});
 let run:Promise<void>|undefined;
 await experimentDispatchTool({chatId:chat.id,jobStore,spawn:(job,input)=>{run=runner.runJob(job.id,input);}}).execute('encoded-dispatch',{question:'Encoded plan'});
 await run;
 const job=jobStore.findJobByToolCallId(chat.id,'encoded-dispatch')!;
 assert.equal(job.status,'done',job.error);
 assert.equal(jobStore.findJobByToolCallId(chat.id,`experiment-proposal-${job.id}`)?.experiment?.state,'awaiting_approval');
 researchModelOverride.current=undefined;
});

test('GLM\'s real flattened propose_locked payload is reassembled into one valid plan',()=>{
 const raw=JSON.parse(readFileSync(new URL('./fixtures/experiment-flattened-propose.json',import.meta.url),'utf8')) as Record<string,string>;
 // The captured shape: plan fields spilled to the top level, `plan` itself an unterminated JSON string.
 assert.throws(()=>JSON.parse(raw.plan!));assert.equal(typeof raw.limits,'string');assert.equal(raw.version,'3');
 const tool=experimentTool({chatId:'c',jobStore,spawn:()=>{throw new Error('unused');}} as never);
 assert.equal(Value.Check(tool.parameters as never,raw),false); // what pi rejected live
 const fixed=decodeStructuredFields(raw) as {action:string;locks:unknown[];plan:Record<string,unknown>};
 assert.deepEqual(Object.keys(fixed).sort(),['action','locks','plan']);
 assert.equal(fixed.plan.version,3);assert.equal(fixed.plan.gpu,true);assert.equal(fixed.plan.network,'internal-loopback');
 assert.ok(Array.isArray(fixed.plan.commands)&&fixed.plan.commands.length>=1);
 assert.deepEqual(fixed.plan.inputs,[]);assert.equal(typeof fixed.plan.limits,'object');assert.ok(Array.isArray(fixed.plan.exports));assert.equal(typeof fixed.plan.model,'object');
 assert.equal(fixed.plan.title,raw.title);assert.equal(fixed.plan.purpose,raw.purpose);
 assert.equal(Value.Check(tool.parameters as never,fixed),true);
 assert.deepEqual(decodeStructuredFields(fixed),fixed); // idempotent
});
test('already well-formed and unrecoverable arguments are left alone',()=>{
 const good={action:'propose',plan:{...plan}};assert.equal(decodeStructuredFields(good),good);
 const cutOff={action:'propose',plan:'{"commands": [[\"x\"'};assert.equal(decodeStructuredFields(cutOff),cutOff);
 const recipe={action:'propose_recipe',recipeId:'a'.repeat(64),title:'x'};assert.equal(decodeStructuredFields(recipe),recipe);
});

function toolText(result:unknown):string {return ((result as {content?:{text?:string}[]}).content??[]).map(c=>c.text??'').join('');}
test('get_plan, propose_variant and inspect let the specialist revise a proposal with small edits',async()=>{
 const chat=chatStore.createChat('variant test');
 const base=jobStore.createJob({kind:'experiment',chatId:chat.id,toolCallId:'base-proposal',input:plan,activity:'awaiting approval'});
 const tool=experimentTool({chatId:chat.id,jobStore,spawn:()=>{throw new Error('unused');}} as never);
 const run=(id:string,args:unknown)=>tool.execute(id,prepareExperimentArguments(args) as never,undefined as never,undefined as never);
 assert.match(toolText(await run('i1',{action:'inspect'})),new RegExp(`"jobId":"${base.id}".*"revision":"To revise`));
 const compact=JSON.parse(toolText(await run('g1',{action:'get_plan',jobId:base.id})));
 assert.equal(compact.title,plan.title);assert.deepEqual(compact.commands,plan.commands);assert.equal(typeof compact.downloads,'number');
 // edits: unknown text, then a valid one; the new proposal keeps everything else
 await assert.rejects(()=>run('v0',{action:'propose_variant',baseJobId:base.id,replace:[{command:0,find:'no-such-text',replace:'x'}]}),/does not occur/);
 await assert.rejects(()=>run('v0b',{action:'propose_variant',baseJobId:'job_does_not_exist'}),/Unknown proposal/);
 const out=toolText(await run('experiment-proposal-variant',{action:'propose_variant',baseJobId:base.id,title:'Revised check',limits:{wallSeconds:5},replace:[{command:0,find:'print(2+2)',replace:'print(3+3)'}]}));
 assert.match(out,/awaits explicit learner approval/);
 const made=jobStore.findJobByToolCallId(chat.id,'experiment-proposal-variant')!;
 const revised=made.input as typeof plan;
 assert.equal(revised.title,'Revised check');assert.equal(revised.limits.wallSeconds,5);
 assert.equal(revised.commands[0]!.at(-1),'print(3+3)');assert.equal(revised.commands[0]![0],plan.commands[0]![0]);
 assert.deepEqual(revised.downloads,plan.downloads);assert.equal(made.experiment?.state,'awaiting_approval');
 assert.notEqual(made.experiment?.digest,base.experiment?.digest);
});
test('schema errors name the requested action only, with short field messages',()=>{
 try{prepareExperimentArguments({action:'propose_locked',plan:{},locks:[]});assert.fail('expected a throw');}
 catch(error){const message=String((error as Error).message);assert.match(message,/^Invalid propose_locked arguments\. Fix these and resubmit: /);assert.doesNotMatch(message,/recipeId/);assert.ok(message.length<900,message.length.toString());}
 const fine={action:'inspect'};assert.equal(prepareExperimentArguments(fine),fine);
});
