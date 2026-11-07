import { readReceipt } from '@/src/server/experiments/service';
import { desktopAPIAuthorized, curriculumWebAuthorized, curriculumTailnetAuthorized } from '@/src/server/desktop-access';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(req:Request,{params}:{params:Promise<{jobId:string}>}) {
 if(!desktopAPIAuthorized(req.headers)||!curriculumWebAuthorized(req.headers)||!curriculumTailnetAuthorized(req.headers))return Response.json({error:'Private application access required'},{status:403});
 try{return Response.json(readReceipt((await params).jobId),{headers:{'Cache-Control':'no-store','Content-Disposition':'attachment; filename="experiment-receipt.json"','X-Content-Type-Options':'nosniff'}});}catch{return Response.json({error:'Receipt unavailable'},{status:404});}
}
