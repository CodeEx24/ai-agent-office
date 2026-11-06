import { NextResponse, type NextRequest } from "next/server";

import { safeNextPath } from "../../../features/auth/safe-next-path";
import { authCallbackQuerySchema } from "../../../features/auth/schemas";
import { parseInput, searchParamsToRecord } from "../../../lib/validation/parse-input";
import { resolveOrigin } from "../../../lib/request-origin";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

// OAuth and magic-link return point: exchanges the one-time `code` for a session cookie, then
// sends the user to `next`. `next` is validated as a same-origin path, so this can never be used
// as an open redirect; the redirect base is the host the user is on (cookies are host-scoped).
export async function GET(request: NextRequest) {
  const origin = resolveOrigin(request.headers);
  const query = parseInput(
    authCallbackQuerySchema,
    searchParamsToRecord(request.nextUrl.searchParams),
  );
  // Invalid input (oversized or malformed values) is treated like a missing code.
  const code = query.success ? query.data.code : undefined;
  const next = safeNextPath(query.success ? query.data.next : undefined);

  if (code) {
    try {
      const supabase = await createSupabaseServerClient();
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) {
        const response = NextResponse.redirect(new URL(next, origin));
        // This response sets session cookies: keep CDNs and browsers from caching it.
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    } catch {
      // Fall through to the error redirect.
    }
  }

  return NextResponse.redirect(new URL("/sign-in?error=callback", origin));
}
