import { NextResponse, type NextRequest } from "next/server";

import { isProtectedPath, signInPathFor } from "./features/auth/routes";
import { resolveOrigin } from "./lib/request-origin";
import { updateSession } from "./lib/supabase/session";

// Next.js 16 renamed middleware.ts to proxy.ts. It refreshes the Supabase session cookie on every
// matched request and redirects signed-out visitors away from protected routes. It is a first
// gate only: the /app layout re-checks the user on the server.
export async function proxy(request: NextRequest) {
  const { isSignedIn, response } = await updateSession(request);
  const { pathname, search } = request.nextUrl;

  if (isSignedIn || !isProtectedPath(pathname)) return response;

  const redirect = NextResponse.redirect(
    new URL(signInPathFor(`${pathname}${search}`), resolveOrigin(request.headers)),
  );
  // Carry over refreshed or cleared auth cookies and the no-cache headers.
  for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
  for (const header of ["cache-control", "expires", "pragma"]) {
    const value = response.headers.get(header);
    if (value) redirect.headers.set(header, value);
  }
  return redirect;
}

export const config = {
  // Skip static assets and image optimisation; everything else gets a session refresh.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
