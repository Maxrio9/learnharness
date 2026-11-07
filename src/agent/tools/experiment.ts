import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { serverExecute } from '../tool-execute.ts';
import type { JobToolContext } from './jobs.ts';
import { parsePlan, planDigest } from '../../server/experiments/plan.ts';
import { inspectExperiments } from '../../server/experiments/service.ts';
import { expandEnvironmentLocks, loadExperimentRecipe } from '../../server/experiments/environment-locks.ts';
import { discoverModels } from '../../server/experiments/model-catalog.ts';
const text=Type.String({minLength:1,maxLength:8192});
const bounded=(minimum:number,maximum:number)=>Type.Integer({minimum,maximum});
const modelSelection=Type.Object({repo:Type.String({maxLength:160,pattern:'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'}),revision:Type.String({pattern:'^[a-f0-9]{40,64}$'}),files:Type.Array(Type.Object({name:Type.String({maxLength:160,pattern:'^[-A-Za-z0-9_.]+$'}),sha256:Type.String({pattern:'^[a-f0-9]{64}$'}),bytes:bounded(0,128*2**30)},{additionalProperties:false}),{minItems:1,maxItems:128})},{additionalProperties:false});
const versionSchema=(version:1|2|3)=>{const v2=version>=2,v3=version===3;return Type.Object({
 version:Type.Literal(version),title:Type.String({minLength:1,maxLength:160}),purpose:Type.String({minLength:1,maxLength:2000}),
 commands:Type.Array(Type.Array(text,{minItems:1,maxItems:64}),{minItems:1,maxItems:16}),
 downloads:Type.Array(Type.Object({name:Type.String({pattern:'^[a-zA-Z0-9][a-zA-Z0-9_.-]*$',maxLength:v3?160:80}),url:Type.String({maxLength:2048}),sha256:Type.String({pattern:'^[a-f0-9]{64}$'}),maxBytes:bounded(1,(v2?49152:4096)*1048576),...(v3?{omitBuildBackendSha256:Type.Optional(Type.String({pattern:'^[a-f0-9]{64}$',description:'Curated wheel compatibility only: omit the exact top-level build_backend.py member after verifying its digest.'}))}:{})},{additionalProperties:false}),{maxItems:v3?384:16}),
 inputs:Type.Array(Type.String({pattern:'^[a-zA-Z0-9][a-zA-Z0-9_.-]*@[a-f0-9]{64}$',maxLength:80}),{maxItems:16}),
 limits:Type.Object({wallSeconds:bounded(1,v2?3600:900),memoryMiB:bounded(64,v2?24576:8192),tasks:bounded(4,v2?256:64),diskMiB:bounded(1,v2?16384:4096),outputBytes:bounded(128,65536),...(v2?{stagedCacheMiB:bounded(0,49152),artifactBytes:bounded(0,536870912)}:{})},{additionalProperties:false}),
 network:Type.Union([Type.Literal('off'),Type.Literal('internal-loopback')]),gpu:Type.Boolean(),
 ...(v2?{exports:Type.Array(Type.Object({path:Type.String({minLength:1,maxLength:160}),maxBytes:bounded(1,536870912)},{additionalProperties:false}),{maxItems:16})}:{}),
 ...(v3?{environments:Type.Array(Type.Object({name:Type.String({pattern:'^[a-z][a-z0-9-]{0,31}$'}),wheels:Type.Array(Type.String({minLength:1,maxLength:160}),{minItems:1,maxItems:256}),maxInstalledMiB:bounded(1,32768)},{additionalProperties:false}),{maxItems:4}),model:Type.Optional(modelSelection)}:{})
},{additionalProperties:false});};
const planSchema=Type.Union([versionSchema(1),versionSchema(2),versionSchema(3)]);
const lockedPlan=Type.Omit(versionSchema(3),['downloads','environments']);
const schema=Type.Union([Type.Object({action:Type.Literal('propose_recipe'),recipeId:Type.String({pattern:'^[a-f0-9]{64}$'})},{additionalProperties:false}),Type.Object({action:Type.Literal('propose_locked'),plan:lockedPlan,locks:Type.Array(Type.Object({name:Type.String({pattern:'^[a-z][a-z0-9-]{0,31}$'}),lockId:Type.String({pattern:'^[a-f0-9]{64}$'})},{additionalProperties:false}),{minItems:1,maxItems:4})},{additionalProperties:false}),Type.Object({action:Type.Literal('inspect')},{additionalProperties:false}),Type.Object({action:Type.Literal('discover_models')},{additionalProperties:false}),Type.Object({action:Type.Literal('propose'),plan:planSchema},{additionalProperties:false})]);
/** Local models mangle nested tool arguments in two ways, and both are rejected by pi's schema validation before
 *  the tool runs (the model then repeats the same payload and gives up with a bogus "transport blocker"):
 *   1. a structured argument sent as ONE JSON-encoded string ("plan: must be object", "locks: must be array");
 *   2. GLM's tool-call format spilling the plan's own fields (version, title, limits, model, ...) out as top-level
 *      arguments next to `plan`, with the `plan` string itself cut off before its closing brace.
 *  Both are mechanically recoverable without changing any value: strings are JSON-decoded, scalars get their natural
 *  type, and the spilled fields go back into `plan`. The result is still validated strictly by the schema and
 *  parsePlan, the digest covers the reassembled plan and the learner reviews exactly that plan. Anything that is not
 *  cleanly recoverable passes through and is rejected as before. */
const PLAN_FIELDS=['version','title','purpose','commands','downloads','inputs','limits','network','gpu','exports','environments','model'];
const STRUCTURED_FIELDS=new Set(['commands','downloads','inputs','limits','exports','environments','model']);
function coercePlanField(key:string,value:unknown):unknown {
 if(typeof value!=='string')return value;
 if(key==='version')return /^\d+$/.test(value)?Number(value):value;
 if(key==='gpu')return value==='true'?true:value==='false'?false:value;
 if(!STRUCTURED_FIELDS.has(key))return value;
 try{return JSON.parse(value);}catch{return value;}
}
const plainObject=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function decodePlanString(value:string):Record<string,unknown>|undefined {
 for(const candidate of [value,value+'}']){
  try{const parsed=JSON.parse(candidate);if(plainObject(parsed))return parsed;}catch{/* try the next candidate */}
 }
 return undefined;
}
export function decodeStructuredFields(args:unknown):unknown {
 if(!plainObject(args))return args;
 const input=args;let out:Record<string,unknown>|undefined;
 const set=(key:string,value:unknown)=>{(out??={...input})[key]=value;};
 if(typeof input.locks==='string'){
  try{const parsed=JSON.parse(input.locks);if(Array.isArray(parsed))set('locks',parsed);}catch{/* rejected by validation */}
 }
 if(String(input.action).startsWith('propose')&&input.action!=='propose_recipe'){
  const spilled=PLAN_FIELDS.filter(key=>key in input);
  const plan=typeof input.plan==='string'?decodePlanString(input.plan):plainObject(input.plan)?input.plan:undefined;
  if(plan&&!spilled.length){if(plan!==input.plan)set('plan',plan);}
  else if(spilled.length&&(plan||input.plan===undefined)){
   const fields=Object.fromEntries(spilled.map(key=>[key,coercePlanField(key,input[key])]));
   set('plan',{...fields,...(plan??{})});
   for(const key of spilled)delete (out as Record<string,unknown>)[key];
  }
 }
 return out??args;
}

/** Private to the experiment specialist. No approval or execution capability. */
export function experimentTool(ctx:JobToolContext):AgentTool<any> {
 return {name:'experiment',label:'experiment',parameters:schema,executionMode:'sequential',prepareArguments:decodeStructuredFields as never,description:'Inspect runtime and model metadata or submit one exact plan for approval. Version 3 may prepare or reuse up to four independent Python 3.12 wheel environments and run the complete comparison in one approval. Each environment lists wheel filenames from the plan’s direct HTTPS downloads, with verified SHA-256 and byte bounds. Use /environments/<name>/python; the environment is read-only during execution. Use identical pinned wheels to reuse it. When inspect lists a recipe matching the request, propose_recipe submits that exact plan by recipeId for a new approval. When inspect lists curated environment locks, use propose_locked with the lock IDs and mount names; LearnHarness expands every wheel into the exact approval plan. The sandbox permits only off or private loopback networking. Version 3 mounts only the model files pinned by the optional model field at /model. Use a model manifest from inspect when available. GPU plans can use /usr/bin/nsys. Legacy version 2 uses /model-cache. Discovery is metadata only. Never invent a dependency lock, hash, or observed result.',execute:serverExecute('experiment',schema,async (input,{toolCallId,signal})=>{
  if(!input||Object.keys(input).sort().join(',')!==(input.action==='propose_locked'?'action,locks,plan':input.action==='propose_recipe'?'action,recipeId':input.action==='propose'?'action,plan':'action'))throw new Error('Exact discriminated action required');
  if(input.action==='inspect')return JSON.stringify(inspectExperiments());
  if(input.action==='discover_models')return JSON.stringify(await discoverModels(signal));
  if(input.action!=='propose'&&input.action!=='propose_locked'&&input.action!=='propose_recipe')throw new Error('Unknown experiment action');
  const plan=input.action==='propose_recipe'?loadExperimentRecipe(input.recipeId):input.action==='propose_locked'?expandEnvironmentLocks(input.plan,input.locks):parsePlan(input.plan);
  const old=ctx.jobStore.findJobByToolCallId(ctx.chatId,toolCallId);
  if(old)return `Proposal ${old.id} already exists. Waiting approval is not active computation.`;
  const job=ctx.jobStore.createJob({kind:'experiment',chatId:ctx.chatId,toolCallId,input:plan,activity:'awaiting approval — no active computation'});
  ctx.jobStore.updateJob(job.id,{experiment:{state:'awaiting_approval',digest:planDigest(plan),expiresAt:Date.now()+30*60*1000}});
  return `Experiment proposal ${job.id} awaits explicit learner approval in its native card. Waiting approval is not active computation. Continue teaching. This tool cannot approve or run the plan.`;
 })};
}
