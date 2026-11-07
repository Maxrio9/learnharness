import { Type } from 'typebox';
import { serverExecute } from '../tool-execute.ts';
import type { JobToolContext } from './jobs.ts';

const schema=Type.Object({question:Type.String({minLength:1,maxLength:4000,description:'The experimental question; the specialist does not see the lesson.'}),context:Type.Optional(Type.String({maxLength:4000,description:'Relevant lesson context and constraints.'}))},{additionalProperties:false});
/** The tutor supplies a question, never an executable plan. */
export function experimentDispatchTool(ctx:JobToolContext) {
 return {name:'experiment',label:'experiment',parameters:schema,description:'Dispatch an independent background experiment specialist to inspect capabilities and prepare a bounded experiment for learner approval. Provide the question and relevant context, then continue teaching. The specialist will report its proposal or limitation; execution requires approval.',execute:serverExecute('experiment',schema,(input,{toolCallId})=>{
  const old=ctx.jobStore.findJobByToolCallId(ctx.chatId,toolCallId);
  if(old)return `Experiment specialist already dispatched (job ${old.id}).`;
  const task={...input,experimentPlanning:true};
  const job=ctx.jobStore.createJob({kind:'research',chatId:ctx.chatId,toolCallId,input:task,activity:'planning experiment'});
  ctx.spawn(job,task);
  return `Experiment specialist dispatched (job ${job.id}). Continue teaching; a proposal requires learner approval.`;
 })};
}
