import { getAppUrl } from "./env";

// hostname[:port] only: letters, digits, dots, hyphens, optional port. No paths, userinfo or spaces.
const HOST_PATTERN = /^[a-z0-9.-]+(?::\d{1,5})?$/i;
const LOOPBACK_PATTERN = /^(localhost|127\.0\.0\.1)(:\d+)?$/i;

/**
 * The origin the browser actually used for this request, e.g. http://127.0.0.1:3100.
 *
 * Auth cookies are host-scoped, so redirects must go back to the same host the user is on. Next's
 * `request.nextUrl.origin` rewrites 127.0.0.1 to localhost, which would drop the session cookie.
 * Only for redirects back to the requester themselves (proxy, callback). Never use it for a URL
 * sent to Supabase or emailed to someone: those use getAppUrl(), because a caller controls the
 * Host header. It is checked against a strict pattern; anything odd falls back to
 * NEXT_PUBLIC_APP_URL. `x-forwarded-host` is deliberately ignored (spoofable without a trusted
 * proxy), and the `next` path is validated separately.
 */
export function resolveOrigin(headers: Pick<Headers, "get">): string {
  const host = headers.get("host")?.trim();
  if (!host || !HOST_PATTERN.test(host)) return getAppUrl();

  const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto ?? (LOOPBACK_PATTERN.test(host) ? "http" : "https");
  if (protocol !== "http" && protocol !== "https") return getAppUrl();

  return `${protocol}://${host}`;
}
