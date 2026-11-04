import { getAppUrl } from "./env";

// hostname[:port] only: letters, digits, dots, hyphens, optional port. No paths, userinfo or spaces.
const HOST_PATTERN = /^[a-z0-9.-]+(?::\d{1,5})?$/i;
const LOOPBACK_PATTERN = /^(localhost|127\.0\.0\.1)(:\d+)?$/i;

/**
 * The origin the browser actually used for this request, e.g. http://127.0.0.1:3100.
 *
 * Auth cookies are host-scoped, so redirects must go back to the same host the user is on. Next's
 * `request.nextUrl.origin` rewrites 127.0.0.1 to localhost, which would drop the session cookie.
 * The Host header is checked against a strict pattern; anything odd falls back to the configured
 * app URL (NEXT_PUBLIC_APP_URL). It only ever builds a redirect back to the requester's own host,
 * and the `next` path is validated separately.
 */
export function resolveOrigin(headers: Pick<Headers, "get">): string {
  const host = (headers.get("x-forwarded-host") ?? headers.get("host"))?.split(",")[0]?.trim();
  if (!host || !HOST_PATTERN.test(host)) return getAppUrl();

  const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto ?? (LOOPBACK_PATTERN.test(host) ? "http" : "https");
  if (protocol !== "http" && protocol !== "https") return getAppUrl();

  return `${protocol}://${host}`;
}
