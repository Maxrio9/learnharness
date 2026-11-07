import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'lh-review-again-'));process.env.LH_DATA_DIR=join(root,'data');process.env.LH_AUTH_FILE=join(root,'auth.json');
const {jobStore}=await import('../src/store/jobs.ts');
const {experimentTool}=await import('../src/agent/tools/experiment.ts');
const {revokeExperiment,approveExperiment,readReceipt}=await import('../src/server/experiments/service.ts');
const {POST}=await import('../app/api/experiments/[jobId]/review-again/route.ts');
const plan={version:1,title:'Retry test',purpose:'Synthetic CPU test',commands:[['/usr/bin/python3','-c','print(123)']],downloads:[],inputs:[],limits:{wallSeconds:10,memoryMiB:128,tasks:16,diskMiB:8,outputBytes:4096},network:'off',gpu:false};
const ctx={chatId:'chat_test',jobStore,spawn:()=>{throw Error('No spawn');}};
const request=(good=true)=>new Request('http://localhost:3934/api/experiments/x/review-again',{method:'POST',headers:{'content-type':'application/json',origin:good?'http://localhost:3934':'http://evil.invalid','sec-fetch-site':'same-origin','sec-fetch-mode':'cors'},body:'{}'});
async function proposal(id:string){await experimentTool(ctx).execute(id,{action:'propose',plan});return jobStore.findJobByToolCallId(ctx.chatId,id)!;}
async function review(id:string,good=true){return POST(request(good),{params:Promise.resolve({jobId:id})});}
test('rejected plan gets a fresh unapproved proposal, then executes only after new approval',async()=>{
 const old=await proposal('first');revokeExperiment(old);jobStore.updateJob(old.id,{status:'error',error:'Aborted by learner'});
 assert.equal((await review(old.id,false)).status,403);
 const r=await review(old.id);assert.equal(r.status,200);const {id}=await r.json();const fresh=jobStore.getJob(id)!;
 assert.notEqual(id,old.id);assert.equal(fresh.experiment?.state,'awaiting_approval');assert.equal(fresh.experiment?.digest,old.experiment?.digest);assert.deepEqual(fresh.input,old.input);
 assert(!existsSync(join(process.env.LH_DATA_DIR!,'admin/experiments/grants',id+'.json')));
 assert.equal((await (await review(old.id)).json()).id,id,'duplicate retry is idempotent');
 approveExperiment(id,fresh.experiment!.digest,'learner-browser:local');
 const deadline=Date.now()+20000;while(jobStore.getJob(id)!.status==='running'){assert(Date.now()<deadline);await new Promise(r=>setTimeout(r,25));}
 const receipt=readReceipt(id) as {outcome:string;stdout:string;cleanup:{empty:boolean};error?:string};assert.equal(receipt.outcome,'done',receipt.error);assert.match(receipt.stdout,/123/);assert(receipt.cleanup.empty);
 assert.equal((await review(id)).status,409,'consumed approval is never reissued');
});
test('expired proposal is retired and safely reissued; unexpired proposal is refused',async()=>{
 const old=await proposal('expired');assert.equal((await review(old.id)).status,409);
 jobStore.updateJob(old.id,{experiment:{...old.experiment!,expiresAt:Date.now()-1000}});
 const r=await review(old.id);assert.equal(r.status,200);assert.equal(jobStore.getJob(old.id)?.experiment?.state,'revoked');
 const fresh=jobStore.getJob((await r.json()).id)!;assert.equal(fresh.experiment?.state,'awaiting_approval');
 assert.throws(()=>approveExperiment(old.id,old.experiment!.digest,'learner-browser:local'));
});
process.on('exit',()=>rmSync(root,{recursive:true,force:true}));
