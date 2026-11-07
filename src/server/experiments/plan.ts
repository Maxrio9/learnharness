import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
export interface ExperimentPlan {
 version:1|2|3; title:string; purpose:string; commands:string[][];
 downloads:{name:string;url:string;sha256:string;maxBytes:number;omitBuildBackendSha256?:string}[];
 inputs:string[];
 limits:{wallSeconds:number;memoryMiB:number;tasks:number;diskMiB:number;outputBytes:number;stagedCacheMiB?:number;artifactBytes?:number};
 exports?:{path:string;maxBytes:number}[];
 environments?:{name:string;wheels:string[];maxInstalledMiB:number}[];
 model?:{repo:string;revision:string;files:{name:string;sha256:string;bytes:number}[]};
 network:'off'|'internal-loopback';gpu:boolean;
}
export type { ExperimentResult } from "../../core/contracts/experiment.ts";
export const GPU_GAP = 'GPU unsupported: reviewed experiment_guard.py owns a native child session/process group; systemd-run starts a service outside that process tree/session. Cgroup PID registration, lease preemption and cleanup of the owned service are not qualified. No devices exposed; a reviewed guard-to-owned-systemd-cgroup adapter is required.';
function object(v:unknown,keys:string[]):Record<string,unknown> {
 if(!v || typeof v!=='object' || Array.isArray(v) || Object.keys(v).sort().join('|')!==keys.sort().join('|')) throw new Error('Exact keys required');
 return v as Record<string,unknown>;
}
function str(v:unknown,max:number):string { if(typeof v!=='string'||!v.length||v.length>max||v.includes('\0')||/[\uD800-\uDFFF]/u.test(v)) throw new Error('Invalid bounded string'); if(/(bearer\s+|(?:api[_-]?key|token|password|secret)\s*[=:])/i.test(v))throw new Error('Secret-bearing plan denied'); return v; }
function int(v:unknown,min:number,max:number):number { if(!Number.isSafeInteger(v)||Number(v)<min||Number(v)>max) throw new Error('Invalid resource bound'); return Number(v); }
function array(v:unknown,max:number):unknown[] {if(!Array.isArray(v)||v.length>max) throw new Error('Invalid bounded array');return v;}
export function parseModelSelection(value:unknown):NonNullable<ExperimentPlan['model']> {
  const m=object(value,['repo','revision','files']);
  const repo=str(m.repo,160), revision=str(m.revision,64);
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)||repo.split('/').some(s=>s==='.'||s==='..')||!/^[a-f0-9]{40,64}$/.test(revision))throw new Error('Invalid model snapshot identity');
  const files=array(m.files,128).map(f=>{const x=object(f,['name','sha256','bytes']);const name=str(x.name,160),sha256=str(x.sha256,64);if(!/^[-A-Za-z0-9_.]+$/.test(name)||name==='.'||name==='..'||!/^[a-f0-9]{64}$/.test(sha256))throw new Error('Invalid model file');return {name,sha256,bytes:int(x.bytes,0,128*2**30)};});
  if(!files.length||new Set(files.map(f=>f.name)).size!==files.length||files.reduce((sum,f)=>sum+f.bytes,0)>128*2**30)throw new Error('Invalid model file bounds');
 return {repo,revision,files};
}
export function parsePlan(value:unknown):ExperimentPlan {
 const version=(value as {version?:unknown}|null)?.version;
 const v3=version===3, v2=version===2||v3;
 const model=v3&&value!==null&&typeof value==='object'&&Object.hasOwn(value,'model');
 const p=object(value,['version','title','purpose','commands','downloads','inputs','limits','network','gpu',...(v2?['exports']:[]),...(v3?['environments']:[]),...(model?['model']:[])]);
 if((version!==1&&version!==2&&version!==3) || typeof p.network!=='string' || !['off','internal-loopback'].includes(p.network)||typeof p.gpu!=='boolean') throw new Error('Unsupported plan');
 const commands=array(p.commands,16).map(c=>{const a=array(c,64).map(s=>str(s,8192));if(!a.length)throw new Error('Empty argv');return a;});
 if(!commands.length)throw new Error('Commands required');
 if(v3&&Buffer.byteLength(JSON.stringify(commands))>65536)throw new Error('Command arguments exceed the execution bound');
 const downloads=array(p.downloads,v3?384:16).map(d=>{const omit=v3&&d!==null&&typeof d==='object'&&Object.hasOwn(d,'omitBuildBackendSha256');const x=object(d,['name','url','sha256','maxBytes',...(omit?['omitBuildBackendSha256']:[])]);const name=str(x.name,v3?160:80);if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name))throw new Error('Invalid artifact name');const sha256=str(x.sha256,64);if(!/^[a-f0-9]{64}$/.test(sha256))throw new Error('SHA256 required');const url=str(x.url,2048);const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.hash||(u.port&&u.port!=='443')||!u.hostname||isIP(u.hostname.replace(/^\[|\]$/g,''))||/[\x00-\x20]/.test(url))throw new Error('HTTPS hostname port 443 required');const omitDigest=omit?str(x.omitBuildBackendSha256,64):undefined;if(omitDigest&&(!name.endsWith('.whl')||!/^[a-f0-9]{64}$/.test(omitDigest)))throw new Error('Invalid pinned build-backend omission');return {name,url,sha256,maxBytes:int(x.maxBytes,1,(v2?49152:4096)*1048576),...(omitDigest?{omitBuildBackendSha256:omitDigest}:{})};});
 if(new Set(downloads.map(d=>d.name)).size!==downloads.length)throw new Error('Duplicate artifact name');
 const inputs=array(p.inputs,16).map(i=>{const s=str(i,80);if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*@[a-f0-9]{64}$/.test(s))throw new Error('Immutable registry ID required');return s;});
 if(new Set(inputs).size!==inputs.length)throw new Error('Duplicate immutable input');
 const l=object(p.limits,['wallSeconds','memoryMiB','tasks','diskMiB','outputBytes',...(v2?['stagedCacheMiB','artifactBytes']:[])]);
 const limits:ExperimentPlan['limits']={wallSeconds:int(l.wallSeconds,1,v2?3600:900),memoryMiB:int(l.memoryMiB,64,v2?24576:8192),tasks:int(l.tasks,4,v2?256:64),diskMiB:int(l.diskMiB,1,v2?16384:4096),outputBytes:int(l.outputBytes,128,65536)};
 if(v2){limits.stagedCacheMiB=int(l.stagedCacheMiB,0,49152);limits.artifactBytes=int(l.artifactBytes,0,536870912);}
 if(downloads.reduce((n,d)=>n+d.maxBytes,0)>(v2?limits.stagedCacheMiB!:limits.diskMiB)*1048576)throw new Error('Staged artifacts exceed disk bound');
 const out:ExperimentPlan={version,title:str(p.title,160),purpose:str(p.purpose,2000),commands,downloads,inputs,limits,network:p.network as ExperimentPlan['network'],gpu:p.gpu};
 if(v2){
  out.exports=array(p.exports,16).map(e=>{const x=object(e,['path','maxBytes']);const path=str(x.path,160);if(path.split('/').some(s=>!s||s==='.'||s==='..'||!/^[A-Za-z0-9_.-]+$/.test(s)))throw new Error('Workspace-relative export required');return {path,maxBytes:int(x.maxBytes,1,limits.artifactBytes!)};});
  if(new Set(out.exports.map(e=>e.path)).size!==out.exports.length||out.exports.reduce((n,e)=>n+e.maxBytes,0)>limits.artifactBytes!)throw new Error('Duplicate or excessive exports');
 }
 if(v3){
  const wheelNames=new Set(downloads.filter(d=>d.name.endsWith('.whl')).map(d=>d.name));
  out.environments=array(p.environments,4).map(e=>{
   const x=object(e,['name','wheels','maxInstalledMiB']);const name=str(x.name,32);
   if(!/^[a-z][a-z0-9-]{0,31}$/.test(name))throw new Error('Invalid environment name');
   const wheels=array(x.wheels,256).map(w=>str(w,160));
   if(!wheels.length||new Set(wheels).size!==wheels.length||wheels.some(w=>!wheelNames.has(w)))throw new Error('Environment must reference unique, declared wheel downloads');
   return {name,wheels,maxInstalledMiB:int(x.maxInstalledMiB,1,32768)};
  });
  if(downloads.some(d=>d.omitBuildBackendSha256&&!out.environments!.some(e=>e.wheels.includes(d.name))))throw new Error('Build-backend omission requires a selected wheel environment');
  if(new Set(out.environments.map(e=>e.name)).size!==out.environments.length||out.environments.reduce((n,e)=>n+e.maxInstalledMiB,0)>65536)throw new Error('Duplicate environments or excessive installation bound');
 }
 if(model)out.model=parseModelSelection(p.model);
 if(Buffer.byteLength(JSON.stringify(out))>(v3?163840:65536))throw new Error('Plan too large');
 return out;
}
export function receiptArtifacts(plan:ExperimentPlan,value:unknown):{name:string;sha256:string;bytes:number}[] {
 if(value===undefined||plan.version===1)return [];
 const artifacts=array(value,16).map(entry=>{
  if(!entry||typeof entry!=='object')throw Error('Invalid receipt artifact');
  const a=entry as Record<string,unknown>;const approved=plan.exports?.find(e=>e.path===a.name);
  if(!approved||typeof a.sha256!=='string'||!/^[a-f0-9]{64}$/.test(a.sha256))throw Error('Unapproved receipt artifact');
  return {name:approved.path,sha256:a.sha256,bytes:int(a.bytes,0,approved.maxBytes)};
 });
 if(new Set(artifacts.map(a=>a.name)).size!==artifacts.length||artifacts.reduce((n,a)=>n+a.bytes,0)>(plan.limits.artifactBytes??0))throw Error('Excessive receipt artifacts');
 return artifacts;
}
export function canonicalPlan(p:unknown):string { return JSON.stringify(parsePlan(p)); }
export function planDigest(p:unknown):string {return createHash('sha256').update(canonicalPlan(p)).digest('hex');}
/** Positive browser evidence, in addition to app capability and private learner identity.
 * Reverse proxies may change req.url; only explicitly configured origins are trusted,
 * never X-Forwarded-Host. This is NOT a hostile same-UID client boundary. */
export function approvalBrowserSource(req:Request):'learner-browser:local'|'learner-browser:tailnet'|undefined {
 if(req.headers.get('sec-fetch-site')!=='same-origin'||!['cors','same-origin'].includes(req.headers.get('sec-fetch-mode')??'')||req.headers.get('content-type')?.split(';')[0]!=='application/json')return;
 try {
  const local=process.env.LH_CURRICULUM_WEB_ORIGIN;
  const url=new URL(req.url);
  const origins=local?[local,process.env.LH_CURRICULUM_TAILNET_ORIGIN]:['localhost','127.0.0.1','[::1]'].includes(url.hostname)?[url.origin]:[];
  for(const [i,value] of origins.entries()) {
   if(!value)continue;const target=new URL(value);
   if(target.username||target.password||target.pathname!=='/'||target.search||target.hash||!['http:','https:'].includes(target.protocol)||(i===1&&target.protocol!=='https:'))return;
   if(req.headers.get('origin')===target.origin&&(req.headers.get('host')??url.host)===target.host)return i===0?'learner-browser:local':'learner-browser:tailnet';
  }
 }catch{/* fail closed */}
}
export function approvalBrowserRequest(req:Request):boolean {return approvalBrowserSource(req)!==undefined;}
