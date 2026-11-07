import { approveExperiment } from '@/src/server/experiments/service';
import { approvalBrowserSource } from '@/src/server/experiments/plan';
import { desktopAPIAuthorized, curriculumWebAuthorized, curriculumTailnetAuthorized } from '@/src/server/desktop-access';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(req:Request,{params}:{params:Promise<{jobId:string}>}) {
 const source=approvalBrowserSource(req);
 if(!desktopAPIAuthorized(req.headers)||!curriculumWebAuthorized(req.headers)||!curriculumTailnetAuthorized(req.headers)||!source)return Response.json({error:'Same-origin learner browser approval required'},{status:403});
 try {
  // Bound streamed bodies too; Content-Length alone is not a bound.
  const reader=req.body?.getReader();if(!reader)throw new Error('Missing body');let text='';let bytes=0;const decoder=new TextDecoder();
  while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>256){await reader.cancel();throw new Error('Body too large');}text+=decoder.decode(value,{stream:true});}
  const body=JSON.parse(text);if(!body||Array.isArray(body)||Object.keys(body).join()!=='digest'||typeof body.digest!=='string'||!/^[a-f0-9]{64}$/.test(body.digest))throw new Error('Digest only payload required');
  approveExperiment((await params).jobId,body.digest,source);
  return Response.json({approved:true},{headers:{'Cache-Control':'no-store'}});
 }catch{return Response.json({error:'Invalid, expired, mismatched or already consumed approval. Propose again if needed.'},{status:409});}
}
