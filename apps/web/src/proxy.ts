import { NextResponse, type NextRequest } from "next/server";

import { isProtectedPath, signInPathFor } from "./features/auth/routes";
import { getSentryDsn, getSupabaseUrl } from "./lib/env";
import {
  getClientIp,
  getRateLimiter,
  matchRouteRateLimit,
  tooManyRequestsResponse,
} from "./lib/rate-limit";
import { resolveOrigin } from "./lib/request-origin";
import { buildContentSecurityPolicy, generateNonce } from "./lib/security/csp";
import { updateSession } from "./lib/supabase/session";

const CSP_HEADER = "Content-Security-Policy";
const NONCE_HEADER = "x-nonce";

function safeSupabaseUrl(): string | undefined {
  try {
    return getSupabaseUrl();
  } catch {
    // Invalid env: the CSP simply omits the Supabase origin; the session code reports the fault.
    return undefined;
  }
}

// Next.js 16 renamed middleware.ts to proxy.ts. In order, it:
//  1. builds the per-request nonce CSP and forwards it (plus `x-nonce`) on the request headers, so
//     Next puts the nonce on its own scripts and the root layout can hand it to next-themes;
//  2. refreshes the Supabase session cookie and redirects signed-out visitors from protected routes;
//  3. rate limits sensitive requests, answering 429 with Retry-After before they reach an action.
// It is a first gate only: the /app layout re-checks the user on the server.
export async function proxy(request: NextRequest) {
  const nonce = generateNonce();
  const csp = buildContentSecurityPolicy({
    nonce,
    isDevelopment: process.env.NODE_ENV === "development",
    supabaseUrl: safeSupabaseUrl(),
    // Never throws: an invalid DSN is logged once and leaves the Sentry origin out of the CSP.
    sentryDsn: getSentryDsn(),
  });
  // Mutating the request headers is what `NextResponse.next({ request })` forwards to the page.
  request.headers.set(NONCE_HEADER, nonce);
  request.headers.set(CSP_HEADER, csp);

  const { isSignedIn, userId, response } = await updateSession(request);
  const { pathname, search } = request.nextUrl;

  const limited = await applyRateLimit(request, userId);
  if (limited) {
    limited.headers.set(CSP_HEADER, csp);
    return limited;
  }

  if (isSignedIn || !isProtectedPath(pathname)) {
    response.headers.set(CSP_HEADER, csp);
    return response;
  }

  const redirect = NextResponse.redirect(
    new URL(signInPathFor(`${pathname}${search}`), resolveOrigin(request.headers)),
  );
  // Carry over refreshed or cleared auth cookies and the no-cache headers.
  for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
  for (const header of ["cache-control", "expires", "pragma"]) {
    const value = response.headers.get(header);
    if (value) redirect.headers.set(header, value);
  }
  redirect.headers.set(CSP_HEADER, csp);
  return redirect;
}

/** A 429 response when the request is over its budget; undefined when it may proceed. */
async function applyRateLimit(
  request: NextRequest,
  userId: string | undefined,
): Promise<NextResponse | undefined> {
  const match = matchRouteRateLimit(request.method, request.nextUrl.pathname);
  if (!match) return undefined;

  const ip = getClientIp(request.headers);
  const key = match.scope === "user" && userId ? `user:${userId}` : `ip:${ip}`;

  try {
    const result = await getRateLimiter().consume(key, match.rule);
    if (!result.allowed) {
      const blocked = tooManyRequestsResponse(match.rule, result);
      return new NextResponse(blocked.body, { status: 429, headers: blocked.headers });
    }
  } catch {
    // A limiter fault must not take the site down; Supabase's own limits still apply.
  }
  return undefined;
}

export const config = {
  // Skip static assets and image optimisation; everything else gets a session refresh.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
