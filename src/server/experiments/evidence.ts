import { stripVTControlCharacters } from 'node:util';
/** Defense in depth at persistence and export, not permission to send secrets to a worker. */
export function redactText(value:string):string {
 let text=stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'');
 // Never include parent authentication values in logs, even on trusted-supervisor errors.
 for(const [key,secret] of Object.entries(process.env))if(/secret|token|password|api.?key|authorization/i.test(key)&&secret&&secret.length>=8)text=text.split(secret).join('[REDACTED]');
 return text.replace(/(?:\/home\/|\/Users\/)[^\s"'<>]+/g,'[HOST_PATH]')
 .replace(/\/run\/user\/\d+[^\s"'<>]*/g,'[HOST_RUNTIME]')
 .replace(/(\b(?:authorization|proxy-authorization)\s*[:=]\s*)(?:Bearer\s+|Basic\s+)?[^\s"',;]+/gi,'$1[REDACTED]')
 .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s"',;]+/gi,'$1[REDACTED]')
 .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g,'[REDACTED]');
}
export function boundedText(value:unknown,maxBytes:number):string {
 const text=redactText(String(value??''));
 if(Buffer.byteLength(text)<=maxBytes)return text;
 const marker='\n[TRUNCATED]';let out=Buffer.from(text).subarray(0,maxBytes-Buffer.byteLength(marker)).toString('utf8');
 while(Buffer.byteLength(out+marker)>maxBytes)out=out.slice(0,-1);
 return out+marker;
}
export function redactEvidence(value:unknown,maxBytes=262144):Record<string,unknown> {
 let count=0;
 const visit=(v:unknown,depth:number):unknown=>{
  if(++count>10000||depth>20)throw new Error('Evidence structure exceeds bound');
  if(typeof v==='string')return boundedText(v,65536);
  if(Array.isArray(v))return v.map(x=>visit(x,depth+1));
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[redactText(k),visit(x,depth+1)]));
  return v;
 };
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Evidence envelope required');
 const clean=visit(value,0) as Record<string,unknown>;
 if(Buffer.byteLength(JSON.stringify(clean))>maxBytes)throw new Error('Evidence exceeds envelope bound');
 return clean;
}
