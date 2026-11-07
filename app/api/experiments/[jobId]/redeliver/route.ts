import { redeliverReceipt } from '@/src/server/experiments/service';
import { approvalBrowserSource } from '@/src/server/experiments/plan';
import { desktopAPIAuthorized, curriculumWebAuthorized, curriculumTailnetAuthorized } from '@/src/server/desktop-access';
export const runtime='nodejs';
export const dynamic='force-dynamic';
/** Re-post a finished experiment's receipt, with run facts and the measurement digest, into its lesson. */
export async function POST(req:Request,{params}:{params:Promise<{jobId:string}>}) {
 if(!desktopAPIAuthorized(req.headers)||!curriculumWebAuthorized(req.headers)||!curriculumTailnetAuthorized(req.headers)||!approvalBrowserSource(req))return Response.json({error:'Same-origin learner browser required'},{status:403});
 try {
  const body=(await req.text()).trim();
  if(body!=='{}')throw Error('Empty object required');
  const {steerId}=await redeliverReceipt((await params).jobId);
  return Response.json({steerId},{headers:{'Cache-Control':'no-store'}});
 } catch(error) {return Response.json({error:error instanceof Error&&/already delivered/.test(error.message)?'Corrected receipt already delivered.':'Unable to redeliver this receipt.'},{status:409});}
}
