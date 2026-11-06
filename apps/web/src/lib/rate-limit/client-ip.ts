const IP_PATTERN = /^[0-9a-f:.]{2,45}$/i;

export interface ClientIpOptions {
  /**
   * True only behind a reverse proxy that overwrites the forwarding headers
   * (`TRUST_PROXY_HEADERS=true`). Default false: the headers are ignored.
   */
  trustProxy?: boolean;
}

/**
 * Best-effort client address for rate limiting. Behind a configured trusted proxy it uses the
 * first `x-forwarded-for` hop, then `x-real-ip`; anything that is not an IP literal is ignored.
 *
 * TRUST (AGO-201): by default these headers are NOT trusted. Without a proxy that overwrites them
 * a caller can pick any value and dodge the per-IP bucket, so every caller then shares the
 * "unknown" bucket, which fails closed rather than open. Per-identity (email / user) limits never
 * read these headers and are unaffected. Set `TRUST_PROXY_HEADERS=true` (docs/environments.md)
 * when deployed behind a proxy such as Vercel.
 */
export function getClientIp(
  headers: Pick<Headers, "get">,
  { trustProxy = false }: ClientIpOptions = {},
): string {
  if (!trustProxy) return "unknown";
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded && IP_PATTERN.test(forwarded)) return forwarded.toLowerCase();
  const real = headers.get("x-real-ip")?.trim();
  if (real && IP_PATTERN.test(real)) return real.toLowerCase();
  return "unknown";
}
