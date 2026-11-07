import { timingSafeEqual } from "node:crypto";

/** Per-launch desktop HTTP capability. This is not an OS-user malware
 * boundary and is not an OAuth credential. Browser-only mode is unchanged. */
export function desktopAPIAuthorized(
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const expected = env.LH_DESKTOP_API_SECRET;
	if (env.LH_DESKTOP_SERVER !== "1" && !expected) return true;
	if (!expected || expected.length < 64) return false;
	const supplied = headers.get("x-learnharness-desktop");
	if (!supplied) return false;
	const actual = Buffer.from(supplied);
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}


/** Explicit local/private origins; forwarded headers never select a trusted origin. */
function curriculumOrigins(): URL[] {
 const local=process.env.LH_CURRICULUM_WEB_ORIGIN;
 if (!local) return [];
 try {
  const result=[new URL(local)];
  const remote=process.env.LH_CURRICULUM_TAILNET_ORIGIN;
  if(remote) {
   const u=new URL(remote);
   if(u.protocol!=="https:" || u.username || u.password || u.pathname!=="/" || u.search || u.hash) return [];
   result.push(u);
  }
  return result;
 } catch { return []; }
}

/** Only Serve's authenticated user may use the remote host. Server stays on loopback.
 * Serve removes client-supplied identity headers. Local processes are not isolated. */
export function curriculumTailnetAuthorized(headers: Headers): boolean {
 if(!process.env.LH_CURRICULUM_WEB_ORIGIN) return true;
 const targets=curriculumOrigins();
 const host=headers.get("host");
 if(targets[0]?.host===host) return true;
 const login=process.env.LH_CURRICULUM_TAILNET_LOGIN;
 return targets.length===2 && targets[1]!.host===host && !!login && headers.get("tailscale-user-login")===login;
}

/** Same-origin controls for either explicitly configured host, never mixed origins. */
export function curriculumWebAuthorized(headers: Headers): boolean {
 if(!process.env.LH_CURRICULUM_WEB_ORIGIN) return true;
 const target=curriculumOrigins().find(u=>u.host===headers.get("host"));
 if(!target) return false;
 const origin=headers.get("origin");
 return (origin===null || origin===target.origin) && headers.get("sec-fetch-site")!=="cross-site";
}
