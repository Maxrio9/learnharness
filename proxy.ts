import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized, curriculumWebAuthorized, curriculumTailnetAuthorized } from "./src/server/desktop-access.ts";

/** Applies to every API method, including SSE and spending/settings routes.
 * No public callback or worker bypass: internal jobs call server functions,
 * and any legitimate self-HTTP request must carry the private capability. */
export function proxy(request: NextRequest) {
	if (!curriculumTailnetAuthorized(request.headers) || (request.nextUrl.pathname.startsWith("/api/") && (!desktopAPIAuthorized(request.headers) || !curriculumWebAuthorized(request.headers)))) {
		return NextResponse.json(
			{ error: "LearnHarness access requires an approved local or private Tailscale request." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.next();
}

export const config = { matcher: "/:path*" };
