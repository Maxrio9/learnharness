import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { serverExecute } from '../tool-execute.ts';
import { startAttempt, proposeMore } from '../../server/experiments/service.ts';

const text=Type.String({minLength:1,maxLength:8192});
const retry=Type.Object({
 action:Type.Literal('retry'),
 commands:Type.Array(Type.Array(text,{minItems:1,maxItems:64}),{minItems:1,maxItems:16}),
 title:Type.Optional(Type.String({minLength:1,maxLength:160})),
 limits:Type.Optional(Type.Record(Type.String({pattern:'^[A-Za-z]{1,32}$'}),Type.Integer({minimum:1,maximum:536870912}))),
 exports:Type.Optional(Type.Array(Type.Object({path:Type.String({minLength:1,maxLength:160}),maxBytes:Type.Integer({minimum:1,maximum:536870912})},{additionalProperties:false}),{maxItems:16})),
},{additionalProperties:false});
const giveUp=Type.Object({action:Type.Literal('give_up'),reason:Type.String({minLength:1,maxLength:600})},{additionalProperties:false});
const more=Type.Object({
 action:Type.Literal('propose_more'),
 reason:Type.String({minLength:1,maxLength:600}),
 downloads:Type.Array(Type.Object({name:Type.String({pattern:'^[a-zA-Z0-9][a-zA-Z0-9_.-]*$',maxLength:160}),url:Type.String({maxLength:2048}),sha256:Type.String({pattern:'^[a-f0-9]{64}$'}),maxBytes:Type.Integer({minimum:1,maximum:51539607552})},{additionalProperties:false}),{minItems:1,maxItems:64}),
 environments:Type.Optional(Type.Array(Type.Object({name:Type.String({pattern:'^[a-z][a-z0-9-]{0,31}$'}),addWheels:Type.Array(Type.String({minLength:1,maxLength:160}),{minItems:1,maxItems:64}),maxInstalledMiB:Type.Optional(Type.Integer({minimum:1,maximum:32768}))},{additionalProperties:false}),{maxItems:4})),
 commands:Type.Array(Type.Array(text,{minItems:1,maxItems:64}),{minItems:1,maxItems:16}),
 title:Type.Optional(Type.String({minLength:1,maxLength:160})),
 limits:Type.Optional(Type.Record(Type.String({pattern:'^[A-Za-z]{1,32}$'}),Type.Integer({minimum:1,maximum:536870912}))),
 exports:Type.Optional(Type.Array(Type.Object({path:Type.String({minLength:1,maxLength:160}),maxBytes:Type.Integer({minimum:1,maximum:536870912})},{additionalProperties:false}),{maxItems:16})),
},{additionalProperties:false});
const schema=Type.Union([retry,giveUp,more]);

/** Local models send nested arguments as JSON strings; decode them without changing any value. */
export function prepareAttemptArguments(args:unknown):unknown {
 if(!args||typeof args!=='object'||Array.isArray(args))return args;
 const input=args as Record<string,unknown>;let out:Record<string,unknown>|undefined;
 for(const [key,kind] of Object.entries({commands:'array',exports:'array',limits:'object',downloads:'array',environments:'array'}) as [string,'array'|'object'][]){
  const value=input[key];if(typeof value!=='string')continue;
  try{const parsed=JSON.parse(value);if(kind==='array'?Array.isArray(parsed):parsed!==null&&typeof parsed==='object'&&!Array.isArray(parsed))(out??={...input})[key]=parsed;}catch{/* rejected by validation */}
 }
 return out??args;
}

/** The only tool of the agent that adjusts a failed attempt. It cannot widen the approval: the service re-validates every
 *  attempt against the approved plan (same downloads, environments, model, GPU, network; limits only down; attempts and
 *  total time within the approved budget). */
export function attemptTool(parentId:string,onGiveUp:(reason:string)=>void,onProposed:(jobId:string,reason:string)=>void=()=>undefined,onRetried:()=>void=()=>undefined):AgentTool<any> {
 return {name:'experiment_attempt',label:'experiment attempt',parameters:schema,executionMode:'sequential',prepareArguments:prepareAttemptArguments as never,
  description:'Correct a failed experiment attempt inside the learner\'s existing approval. retry: pass the COMPLETE corrected command list (not a diff), optionally a title, lower limits and different exports; the sandbox, downloads, environments, model, GPU and network stay exactly as approved and limits can only go down. The attempt starts immediately and its receipt is handled for you. give_up: stop and state exactly why the goal cannot be met inside the approval. propose_more: when the goal needs something the approval does not cover (a tool such as the CUDA compiler, a library, a file), ask the learner for it: pass the extra downloads as hash-pinned wheel or file entries (name, https url, sha256, maxBytes), optionally an environment to add or extend (addWheels), and the COMPLETE command list to run once approved. Request everything you can foresee in ONE call; a single package on its own is fine. The current session ends and the learner approves the new proposal. Call exactly one of them.',
  execute:serverExecute('experiment_attempt',schema,async (input:any)=>{
   if(input.action==='propose_more'){
    const proposed=proposeMore(parentId,{reason:input.reason,downloads:input.downloads,environments:input.environments,commands:input.commands,title:input.title,limits:input.limits,exports:input.exports});
    onProposed(proposed.jobId,String(input.reason));
    return `A new proposal (${proposed.jobId}) with the extra downloads now awaits the learner's approval, and this session ends. Reply with one short sentence.`;
   }
   if(input.action==='give_up'){onGiveUp(String(input.reason));return 'Recorded. Reply with one short sentence.';}
   const started=startAttempt(parentId,{commands:input.commands,title:input.title,limits:input.limits,exports:input.exports});
   onRetried();
   return `Attempt ${started.n} started now inside the approval. You will not see its result; reply with one short sentence describing what you changed.`;
  })};
}
