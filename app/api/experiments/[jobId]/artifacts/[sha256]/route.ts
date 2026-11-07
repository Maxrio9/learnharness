import { artifactResponse } from '@/src/server/experiments/artifacts';
import { desktopAPIAuthorized,curriculumWebAuthorized,curriculumTailnetAuthorized } from '@/src/server/desktop-access';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(req:Request,{params}:{params:Promise<{jobId:string;sha256:string}>}) {
 if(!desktopAPIAuthorized(req.headers)||!curriculumWebAuthorized(req.headers)||!curriculumTailnetAuthorized(req.headers))return Response.json({error:'Private application access required'},{status:403});
 try{const p=await params;return await artifactResponse(p.jobId,p.sha256);}catch{return Response.json({error:'Artifact unavailable'},{status:404,headers:{'Cache-Control':'no-store'}});}
}
