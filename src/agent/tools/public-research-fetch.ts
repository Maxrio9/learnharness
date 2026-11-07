import http from 'node:http';
import https from 'node:https';
import {createUnzip,createBrotliDecompress} from 'node:zlib';
import {lookup} from 'node:dns/promises';
import {BlockList,isIP} from 'node:net';
const private4=new BlockList();
for(const [ip,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]] as const)private4.addSubnet(ip,prefix,'ipv4');
const global6=new BlockList();global6.addSubnet('2000::',3,'ipv6');
const private6=new BlockList();
for(const [ip,prefix] of [['2001::',32],['2001:2::',48],['2001:db8::',32]] as const)private6.addSubnet(ip,prefix,'ipv6');
function publicAddress(address:string){const family=isIP(address);return family===4?!private4.check(address,'ipv4'):family===6&&global6.check(address,'ipv6')&&!private6.check(address,'ipv6');}
type Resolver=(hostname:string)=>Promise<Array<{address:string;family:number}>>;
export async function resolvePublicResearchTarget(input:string,resolver:Resolver=(host)=>lookup(host,{all:true})){
 const url=new URL(input);
 if(!['http:','https:'].includes(url.protocol))throw Error('Only public web protocols are allowed');
 if(url.username||url.password)throw Error('Credentialed source URLs are forbidden');
 if(url.port&&url.port!=='80'&&url.port!=='443')throw Error('Only standard public web ports are allowed');
 const host=url.hostname.replace(/^\[|\]$/g,'');
 const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await resolver(host);
 if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw Error('Research sources must resolve exclusively to public addresses');
 return {url,address:addresses[0]!.address,family:addresses[0]!.family};
}

type Transport=(url:URL,opts:http.RequestOptions,callback:(response:http.IncomingMessage)=>void)=>http.ClientRequest;
/** Only for public source downloads, never model/API requests. DNS is checked
 * and pinned at each redirect; no cookies, authentication or private access.
 * The explicit transport/resolver seams support isolated local-server tests.
 */
export async function publicResearchFetch(input:string,init:RequestInit={},options:{resolver?:Resolver;transport?:Transport;maxBytes?:number}={}):Promise<Response>{
 const signal=init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(60_000)]):AbortSignal.timeout(30_000);
 const max=options.maxBytes??5*1024*1024;
 let next=input;
 for(let redirects=0;redirects<=5;redirects++){
  signal.throwIfAborted();
  const target=await resolvePublicResearchTarget(next,options.resolver);signal.throwIfAborted();
  const headers=Object.fromEntries(new Headers(init.headers).entries());
  for(const key of Object.keys(headers))if(['cookie','authorization','proxy-authorization','host'].includes(key.toLowerCase()))delete headers[key];
  headers['accept-encoding']='identity';
  const transport=options.transport??((url,opts,cb)=>(url.protocol==='https:'?https:http).request(url,opts,cb));
  const response=await new Promise<Response>((resolve,reject)=>{
   const req=transport(target.url,{method:'GET',headers,signal,lookup:(_hostname,opts,cb)=>{
    // Node's family autoselection sometimes requests the all-address form.
    if(typeof opts==='object'&&opts.all)cb(null,[{address:target.address,family:target.family}]);else cb(null,target.address,target.family);
   }},incoming=>{
    const status=incoming.statusCode??502;
    const outHeaders=new Headers();
    for(const [key,value] of Object.entries(incoming.headers))if(value!==undefined&&!['set-cookie','content-encoding','content-length','transfer-encoding','connection'].includes(key))outHeaders.set(key,Array.isArray(value)?value.join(', '):value);
    if(status>=300&&status<400){incoming.resume();resolve(new Response(null,{status,headers:outHeaders}));return;}
    if(Number(incoming.headers['content-length']??0)>max){req.destroy();incoming.destroy();reject(Error('Public source exceeds byte limit'));return;}
    const encoding=incoming.headers['content-encoding'];
    const stream=encoding==='br'?incoming.pipe(createBrotliDecompress()):encoding==='gzip'||encoding==='deflate'?incoming.pipe(createUnzip()):incoming;
    let size=0;const chunks:Buffer[]=[];
    incoming.on('error',reject);stream.on('error',reject);
    stream.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>max){stream.destroy();req.destroy();reject(Error('Public source exceeds byte limit'));}else chunks.push(Buffer.from(chunk));});
    stream.on('end',()=>{
     try{const response=new Response([204,205,304].includes(status)?null:new Uint8Array(Buffer.concat(chunks)),{status,headers:outHeaders});Object.defineProperty(response,'url',{value:target.url.href});resolve(response);}catch(e){reject(e);}
    });
   });
   req.on('error',reject);req.end();
  });
  if(response.status>=300&&response.status<400){const location=response.headers.get('location');if(!location)return response;next=new URL(location,target.url).href;continue;}
  return response;
 }
 throw Error('Public source redirect limit exceeded');
}

/** Opt-in installation boundary: upstream tests retain their injected fetch. */
export function researchSourceFetch(input:string,init:RequestInit={},maxBytes?:number):Promise<Response>{
 return process.env.LH_PUBLIC_RESEARCH_ONLY==='1'?publicResearchFetch(input,init,{maxBytes}):fetch(input,init);
}
