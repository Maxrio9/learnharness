import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
const mod=await import('../src/agent/tools/public-research-fetch.ts').catch(()=>null);
test('bounded source fetch revalidates redirects before contacting a private target',async()=>{
 assert.equal(typeof mod?.publicResearchFetch,'function','bounded public fetch is missing');
 let privateHits=0;
 const server=http.createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{Location:'http://127.0.0.1/secret'});res.end();}else if(req.url==='/big'){res.end('x'.repeat(200));}else if(req.url==='/secret'){privateHits++;res.end('private');}else{res.end('Public primary source');}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
 const options={resolver:async()=>[{address:'93.184.216.34',family:4}],transport:(url:any,opts:any,cb:any)=>{
  let pinned:any;opts.lookup(url.hostname,{},(_e:any,address:any)=>pinned=address);assert.equal(pinned,'93.184.216.34');
  return http.request({hostname:'127.0.0.1',port,path:url.pathname,method:'GET',signal:opts.signal},cb);
 }};
 try{
  const good=await mod!.publicResearchFetch('https://example.com/',{},options);assert.equal(await good.text(),'Public primary source');
  await assert.rejects(()=>mod!.publicResearchFetch('https://example.com/redirect',{},options),/public/i);
  await assert.rejects(()=>mod!.publicResearchFetch('https://example.com/big',{}, {...options,maxBytes:32}),/limit|large/i);
  assert.equal(privateHits,0);
 }finally{await new Promise<void>((r,e)=>server.close(err=>err?e(err):r()));}
});
test('autonomous public research refuses private, credentialed and non-web destinations',async()=>{
 assert.ok(mod,'public-source research boundary is missing');
 for(const url of ['http://127.0.0.1/','http://100.64.0.1/','http://169.254.169.254/','https://[::1]/','http://192.168.1.1/','https://user:password@example.com/','file:///etc/passwd','https://example.com:3933/']) {
  await assert.rejects(()=>mod!.resolvePublicResearchTarget(url),/public|credential|protocol|port/i);
 }
});
