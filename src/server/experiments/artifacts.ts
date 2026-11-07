import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { PATHS } from '../../../config.ts';
import { jobStore } from '../../store/jobs.ts';
import { parsePlan,planDigest } from './plan.ts';
import { readReceipt } from './service.ts';
/** Hash-addressed, receipt-bound download only. Artifact content is untrusted,
 * never rendered inline or interpreted as instructions. The only model-context path is digest.ts: a bounded,
 * free-text-free structural digest of JSON artifacts, labelled UNTRUSTED data.
 * Trust boundary excludes a hostile same-UID administrator. */
export async function artifactResponse(id:string,sha256:string):Promise<Response> {
 if(!/^job_[A-Za-z0-9_-]{1,100}$/.test(id)||!/^[a-f0-9]{64}$/.test(sha256))throw Error('Invalid artifact identity');
 const job=jobStore.getJob(id);if(!job||job.kind!=='experiment'||job.status==='running')throw Error('Terminal experiment required');
 const plan=parsePlan(job.input);if(plan.version===1||planDigest(plan)!==job.experiment?.digest)throw Error('Approved export plan required');
 const receipt=readReceipt(id) as {jobId?:unknown;planDigest?:unknown;authorization?:{source?:unknown};artifacts?:unknown};
 if(receipt.jobId!==id||receipt.planDigest!==job.experiment.digest||!['learner-browser:local','learner-browser:tailnet','admin-pilot:t_52985150'].includes(String(receipt.authorization?.source))||!Array.isArray(receipt.artifacts)||receipt.artifacts.length>16)throw Error('Approved receipt required');
 let selected:{name:string;bytes:number}|undefined;let total=0;const names=new Set<string>();
 for(const entry of receipt.artifacts){
  const a=entry as {name?:unknown;bytes?:unknown;sha256?:unknown};const approved=plan.exports?.find(e=>e.path===a.name);
  if(!approved||names.has(approved.path)||!Number.isSafeInteger(a.bytes)||Number(a.bytes)<0||Number(a.bytes)>approved.maxBytes||typeof a.sha256!=='string'||!/^[a-f0-9]{64}$/.test(a.sha256))throw Error('Invalid receipt artifact');
  names.add(approved.path);total+=Number(a.bytes);if(a.sha256===sha256)selected={name:approved.path,bytes:Number(a.bytes)};
 }
 if(!selected||total>plan.limits.artifactBytes!)throw Error('Artifact not approved');
 const dir=path.join(PATHS.data,'admin','experiments','artifacts',id);
 for(let q=dir;;q=path.dirname(q)){
  const s=fs.lstatSync(q);if(s.isSymbolicLink()||!s.isDirectory())throw Error('Unsafe artifact directory');
  if(q===path.join(PATHS.data,'admin','experiments'))break;
  if(s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw Error('Private owned artifact directory required');
 }
 const fd=fs.openSync(path.join(dir,sha256),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);let transferred=false;
 try {
  const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size!==selected.bytes)throw Error('Invalid artifact file');
  const hash=createHash('sha256');if(s.size>0)for await(const chunk of fs.createReadStream('',{fd,autoClose:false,start:0,end:s.size-1}))hash.update(chunk);
  const after=fs.fstatSync(fd);if(hash.digest('hex')!==sha256||after.size!==s.size||after.mtimeMs!==s.mtimeMs||after.nlink!==1)throw Error('Artifact content mismatch');
  const headers={'Content-Type':'application/octet-stream','Content-Length':String(s.size),'Content-Disposition':`attachment; filename="${path.posix.basename(selected.name)}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"};
  if(s.size===0)return new Response(null,{headers});
  const stream=fs.createReadStream('',{fd,autoClose:true,start:0,end:s.size-1});transferred=true;
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>,{headers});
 }finally{if(!transferred)fs.closeSync(fd);}
}
