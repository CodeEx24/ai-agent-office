const IP_PATTERN = /^[0-9a-f:.]{2,45}$/i;

/**
 * Best-effort client address for rate limiting. Uses the first `x-forwarded-for` hop, then
 * `x-real-ip`; anything that is not an IP literal is ignored.
 *
 * TRUST: these headers are only reliable behind a reverse proxy that overwrites them (Vercel
 * does). Without one a caller can pick any value and dodge the per-IP bucket, which is why
 * credential endpoints also carry per-identity (email / user) limits. With no usable header all
 * callers share the "unknown" bucket, which fails closed rather than open.
 */
export function getClientIp(headers: Pick<Headers, "get">): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded && IP_PATTERN.test(forwarded)) return forwarded.toLowerCase();
  const real = headers.get("x-real-ip")?.trim();
  if (real && IP_PATTERN.test(real)) return real.toLowerCase();
  return "unknown";
}
