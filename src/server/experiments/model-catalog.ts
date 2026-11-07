import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {homedir,hostname} from 'node:os';
import {ROOT} from '../../../config.ts';

const PIN='9b8f51335c9b5ab42836d809d729d7bbb3da0bb1f1a602f1b1d12a52778b46f8';
/** Hosts to inventory. Default: this machine. Add more with LH_EXP_MODEL_TARGETS, a JSON array of
 *  {"target":"<ssh alias, or 'desktop' for this machine>","hostname":"<expected hostname>","roots":["/abs/hf/cache"]}. */
type Target={target:string;hostname:string;roots?:string[]};
function targets():Target[] {
 const raw=process.env.LH_EXP_MODEL_TARGETS;
 if(!raw)return [{target:'desktop',hostname:hostname()}];
 try{
  const value=JSON.parse(raw);
  if(Array.isArray(value)&&value.length<=8&&value.every(v=>v&&typeof v.target==='string'&&/^[A-Za-z0-9_.-]{1,64}$/.test(v.target)&&typeof v.hostname==='string'&&(v.roots===undefined||(Array.isArray(v.roots)&&v.roots.every((r:unknown)=>typeof r==='string'&&r.startsWith('/')))))) return value;
 }catch{/* fall through to the safe default */}
 return [{target:'desktop',hostname:hostname()}];
}
const cleanEnv=()=>({PATH:'/usr/bin',HOME:homedir(),LANG:'C.UTF-8'} as unknown as NodeJS.ProcessEnv);

export function parseModelCatalog(text:string,expectedHost:string):unknown {
 const raw=JSON.parse(text);if(!raw||typeof raw!=='object'||!Array.isArray(raw.models)||raw.models.length>500||!Array.isArray(raw.engines)||raw.engines.length>32||!Array.isArray(raw.errors)||typeof raw.truncated!=='boolean')throw Error('Invalid catalog');
 const models=raw.models.slice(0,64).map((m:Record<string,unknown>)=>{
  if(!m||typeof m!=='object'||m.host!==expectedHost||typeof m.model!=='string'||!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(m.model)||typeof m.revision!=='string'||!/^[0-9a-f]{40,64}$/.test(m.revision)||!(m.model_type===null||(typeof m.model_type==='string'&&/^[A-Za-z0-9_.-]{1,100}$/.test(m.model_type)))||!Number.isSafeInteger(m.weight_files)||Number(m.weight_files)<0||!Number.isSafeInteger(m.weight_bytes)||Number(m.weight_bytes)<0||!['metadata_only_unverified','no_weights_visible'].includes(String(m.status)))throw Error('Invalid catalog item');
  return {model:m.model,revision:m.revision,modelType:m.model_type,weightFiles:m.weight_files,weightBytes:m.weight_bytes,status:m.status};
 });
 const engines=raw.engines.map((e:Record<string,unknown>)=>{
  if(!e||typeof e!=='object'||e.host!==expectedHost||!['vllm','sglang'].includes(String(e.engine))||typeof e.image!=='string'||!/^[-A-Za-z0-9_./]+:[-A-Za-z0-9_.]+$/.test(e.image)||typeof e.image_id!=='string'||!/^sha256:[a-f0-9]{64}$/.test(e.image_id)||!['amd64','arm64'].includes(String(e.architecture))||!Number.isSafeInteger(e.size_bytes)||Number(e.size_bytes)<0||e.status!=='metadata_only_unverified')throw Error('Invalid engine image');
  return {engine:e.engine,image:e.image,imageId:e.image_id,architecture:e.architecture,sizeBytes:e.size_bytes,status:e.status};
 });
 return {state:raw.errors.length?'partial':'ok',models,engines,truncated:raw.truncated||raw.models.length>64,notice:'Metadata only; no model integrity, completeness, engine compatibility, image trust or execution permission has been established.'};
}

function readHost(target:string,script:Buffer,roots:string[]|undefined,signal?:AbortSignal):Promise<string> {
 return new Promise((resolve,reject)=>{
  const extra=roots?.length?[JSON.stringify(roots)]:[];
  const args=target==='desktop'?['-I','-',...extra]:['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=3',target,'/usr/bin/python3','-I','-',...extra];
  const proc=spawn(target==='desktop'?'/usr/bin/python3':'/usr/bin/ssh',args,{env:cleanEnv(),stdio:['pipe','pipe','ignore'],signal});
  let out=Buffer.alloc(0);let oversized=false;
  const timer=setTimeout(()=>proc.kill('SIGKILL'),5000);
  proc.stdout.on('data',(chunk:Buffer)=>{if(out.length+chunk.length>131072){oversized=true;proc.kill('SIGKILL');}else out=Buffer.concat([out,chunk]);});
  proc.stdin.on('error',()=>undefined);proc.on('error',err=>reject(err));
  proc.on('close',code=>{clearTimeout(timer);if(code!==0||oversized)reject(Error('Catalog unavailable'));else resolve(out.toString('utf8'));});
  proc.stdin.end(script);
 });
}

/** Fixed hosts/roots and pinned metadata-only code; never takes a model-supplied path or command. */
export async function discoverModels(signal?:AbortSignal):Promise<unknown> {
 let script:Buffer;
 try {script=readFileSync(join(ROOT,'scripts/experiments/model_catalog.py'));if(script.length>65536||createHash('sha256').update(script).digest('hex')!==PIN)throw Error('Catalog pin mismatch');}
 catch{return {state:'unavailable',reason:'Trusted catalog unavailable or mismatched'};}
 const entries=await Promise.all(targets().map(async ({target,hostname,roots})=>{
  try{return [target,parseModelCatalog(await readHost(target,script,roots,signal),hostname)] as const;}
  catch{return [target,{state:'unavailable'}] as const;}
 }));
 return {state:'metadata_only',hosts:Object.fromEntries(entries)};
}
