import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getSupabasePublicEnv } from "../env";

export interface SessionResult {
  /** True only when the session cookie holds a verified, unexpired token. */
  isSignedIn: boolean;
  /** The response that carries any refreshed session cookies. Return it (or copy its cookies). */
  response: NextResponse;
}

const CACHE_HEADERS = ["cache-control", "expires", "pragma"] as const;

/**
 * Refreshes the Supabase session for a request (called from proxy.ts) and reports whether the
 * visitor is signed in. Any failure, including an unreachable Supabase or missing env, counts as
 * signed out so protected routes redirect instead of returning a 500.
 */
export async function updateSession(request: NextRequest): Promise<SessionResult> {
  let response = NextResponse.next({ request });

  try {
    const { url, anonKey } = getSupabasePublicEnv();
    const supabase = createServerClient(url, anonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
          // Stop a CDN from caching a response that carries a session.
          for (const header of CACHE_HEADERS) {
            const value = headers[header];
            if (value) response.headers.set(header, value);
          }
        },
      },
    });

    // Nothing may run between createServerClient and getClaims: it is what refreshes the token.
    const { data, error } = await supabase.auth.getClaims();
    return { isSignedIn: !error && Boolean(data?.claims.sub), response };
  } catch {
    return { isSignedIn: false, response };
  }
}
