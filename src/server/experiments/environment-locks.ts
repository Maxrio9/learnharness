import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PATHS } from '../../../config.ts';
import { parseModelSelection, parsePlan, type ExperimentPlan } from './plan.ts';

const admin=join(PATHS.data,'admin','experiments');
const root=join(admin,'environment-locks');
const modelRoot=join(admin,'model-locks');
const recipeRoot=join(admin,'recipes');
const idPattern=/^[a-f0-9]{64}$/;
const maxBytes=163840;
type Download=ExperimentPlan['downloads'][number];
type Lock={label:string;maxInstalledMiB:number;wheels:Download[]};
export type LockedEnvironmentRef={name:string;lockId:string};

function readPinnedLock(root:string,id:string):unknown {
 if(!idPattern.test(id))throw Error('Invalid environment lock identity');
 // Private local curation only: neither model nor browser may write locks.
 for(let p=root;;p=dirname(p)){
  const st=lstatSync(p);
  if(!st.isDirectory()||st.isSymbolicLink())throw Error('Unsafe environment lock directory');
  if(p===root&&(st.uid!==process.getuid?.()||(st.mode&0o077)!==0))throw Error('Environment lock directory must be private');
  if(p===dirname(p))break;
 }
 const fd=openSync(join(root,id+'.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try {
  const st=fstatSync(fd);
  if(!st.isFile()||st.nlink!==1||st.uid!==process.getuid?.()||(st.mode&0o077)!==0||st.size>maxBytes)throw Error('Unsafe environment lock file');
  const buffer=Buffer.allocUnsafe(st.size+1);
  let count=0;
  while(count<buffer.length){const n=readSync(fd,buffer,count,buffer.length-count,null);if(n===0)break;count+=n;}
  const bytes=buffer.subarray(0,count);
  if(count!==st.size||createHash('sha256').update(bytes).digest('hex')!==id)throw Error('Environment lock content mismatch');
  return JSON.parse(bytes.toString('utf8'));
 }finally{closeSync(fd);}
}

/** Recipes are exact, private admin-curated plans. A recipe has no grant of its own. */
export function loadExperimentRecipe(id:string):ExperimentPlan {
 const plan=parsePlan(readPinnedLock(recipeRoot,id));
 if(plan.version!==3)throw Error('Recipe must use plan version 3');
 return plan;
}

export function listExperimentRecipes():{id:string;title:string;purpose:string;gpu:boolean;environments:string[]}[] {
 try {
  return readdirSync(recipeRoot).filter(n=>n.endsWith('.json')&&idPattern.test(n.slice(0,-5))).sort().slice(0,8).flatMap(n=>{
   try{const id=n.slice(0,-5),plan=loadExperimentRecipe(id);return [{id,title:plan.title,purpose:plan.purpose,gpu:plan.gpu,environments:plan.environments!.map(e=>e.name)}];}catch{return [];}
  });
 }catch{return [];}
}
function loadLock(id:string):Lock {
  const d=readPinnedLock(root,id) as {label:string;maxInstalledMiB:number;wheels:Download[]};
  if(!d||Object.keys(d).sort().join(',')!=='label,maxInstalledMiB,wheels'||!Array.isArray(d.wheels))throw Error('Invalid environment lock');
  const parsed=parsePlan({version:3,title:d.label,purpose:'Validate curated environment lock',commands:[['/usr/bin/true']],downloads:d.wheels,inputs:[],limits:{wallSeconds:1,memoryMiB:64,tasks:4,diskMiB:1,outputBytes:128,stagedCacheMiB:49152,artifactBytes:0},network:'off',gpu:false,exports:[],environments:[{name:'locked',wheels:d.wheels.map((w:Download)=>w.name),maxInstalledMiB:d.maxInstalledMiB}]});
  return {label:parsed.title,maxInstalledMiB:parsed.environments![0]!.maxInstalledMiB,wheels:parsed.downloads};
}

export function listEnvironmentLocks():{id:string;label:string;wheels:number;downloadBytes:number;maxInstalledMiB:number}[] {
 try {
  const names=readdirSync(root).filter(n=>n.endsWith('.json')&&idPattern.test(n.slice(0,-5))).sort().slice(0,16);
  return names.flatMap(n=>{try{const id=n.slice(0,-5),lock=loadLock(id);return [{id,label:lock.label,wheels:lock.wheels.length,downloadBytes:lock.wheels.reduce((n,w)=>n+w.maxBytes,0),maxInstalledMiB:lock.maxInstalledMiB}];}catch{return [];}});
 }catch{return [];}
}

export function listModelLocks():NonNullable<ExperimentPlan['model']>[] {
 try {
  let bytes=0;
  return readdirSync(modelRoot).filter(n=>n.endsWith('.json')&&idPattern.test(n.slice(0,-5))).sort().slice(0,8).flatMap(n=>{
   try{const model=parseModelSelection(readPinnedLock(modelRoot,n.slice(0,-5)));const size=Buffer.byteLength(JSON.stringify(model));if(bytes+size>32768)return [];bytes+=size;return [model];}catch{return [];}
  });
 }catch{return [];}
}

export function expandEnvironmentLocks(draft:unknown,refs:LockedEnvironmentRef[]):ExperimentPlan {
 if(!draft||typeof draft!=='object'||Array.isArray(draft)||!['commands,exports,gpu,inputs,limits,network,purpose,title,version','commands,exports,gpu,inputs,limits,model,network,purpose,title,version'].includes(Object.keys(draft).sort().join(','))||(draft as {version?:unknown}).version!==3)throw Error('Exact v3 locked plan required');
 if(!Array.isArray(refs)||refs.length<1||refs.length>4)throw Error('Select one to four environment locks');
 const wheels=new Map<string,Download>();
 const environments=refs.map(ref=>{
  if(!ref||Object.keys(ref).sort().join(',')!=='lockId,name'||typeof ref.lockId!=='string')throw Error('Exact environment lock reference required');
  const lock=loadLock(ref.lockId);
  for(const wheel of lock.wheels){
   const prior=wheels.get(wheel.name);
   if(prior&&JSON.stringify(prior)!==JSON.stringify(wheel))throw Error('Conflicting filename in environment locks');
   wheels.set(wheel.name,wheel);
  }
  return {name:ref.name,wheels:lock.wheels.map(w=>w.name),maxInstalledMiB:lock.maxInstalledMiB};
 });
 return parsePlan({...draft,downloads:[...wheels.values()],environments});
}
