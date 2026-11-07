import { reviewExperimentAgain } from '@/src/server/experiments/service';
import { approvalBrowserSource } from '@/src/server/experiments/plan';
import { desktopAPIAuthorized, curriculumWebAuthorized, curriculumTailnetAuthorized } from '@/src/server/desktop-access';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(req:Request,{params}:{params:Promise<{jobId:string}>}) {
 if(!desktopAPIAuthorized(req.headers)||!curriculumWebAuthorized(req.headers)||!curriculumTailnetAuthorized(req.headers)||!approvalBrowserSource(req))return Response.json({error:'Same-origin learner browser required'},{status:403});
 try {
  const reader=req.body?.getReader();if(!reader)throw Error('Missing body');let size=0,body='';const decoder=new TextDecoder();
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>256){await reader.cancel();throw Error('Body too large');}body+=decoder.decode(value,{stream:true});}
  const input=JSON.parse(body);if(!input||Array.isArray(input)||Object.keys(input).length)throw Error('Empty object required');
  const job=reviewExperimentAgain((await params).jobId);
  return Response.json({id:job.id,state:job.experiment?.state},{headers:{'Cache-Control':'no-store'}});
 } catch {return Response.json({error:'Unable to reissue this proposal.'},{status:409});}
}
