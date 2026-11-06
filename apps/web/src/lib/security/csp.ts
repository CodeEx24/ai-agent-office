export interface CspOptions {
  /** Per-request nonce. Scripts without it (and not loaded by a nonced script) are blocked. */
  nonce: string;
  /** `next dev` only: React Refresh and source maps need `unsafe-eval`. Never true in production. */
  isDevelopment: boolean;
  /** Validated NEXT_PUBLIC_SUPABASE_URL; allowed for fetch/websocket (auth, realtime). */
  supabaseUrl?: string;
  /**
   * Validated NEXT_PUBLIC_SENTRY_DSN (AGO-104). Its ingest origin is allowed in `connect-src` only
   * when a DSN is configured; the DSN's public key is never copied into the policy.
   */
  sentryDsn?: string;
}

/** A fresh, unguessable nonce per request (base64 of a random UUID, as in the Next.js docs). */
export function generateNonce(): string {
  return btoa(crypto.randomUUID());
}

function supabaseSources(supabaseUrl: string | undefined): string[] {
  if (!supabaseUrl) return [];
  try {
    const url = new URL(supabaseUrl);
    const socketProtocol = url.protocol === "https:" ? "wss:" : "ws:";
    return [url.origin, `${socketProtocol}//${url.host}`];
  } catch {
    // Not a URL: allow nothing extra rather than a malformed source.
    return [];
  }
}

/** The ingest origin of a Sentry DSN (scheme + host, no key, no project path); nothing if invalid. */
function sentrySources(sentryDsn: string | undefined): string[] {
  if (!sentryDsn) return [];
  try {
    const url = new URL(sentryDsn);
    return url.protocol === "https:" || url.protocol === "http:" ? [url.origin] : [];
  } catch {
    return [];
  }
}

/**
 * The page Content-Security-Policy, built per request.
 *
 * - `script-src` is nonce-based with `strict-dynamic`: inline scripts (injected markup, `javascript:`
 *   handlers) are blocked in production; only Next's own scripts, which carry the nonce, run.
 *   `unsafe-inline` is never present for scripts.
 * - `style-src` keeps `unsafe-inline`: React renders `style=""` attributes and sonner injects a
 *   `<style>` at runtime, and neither can carry a nonce. Style injection is far lower risk than
 *   script injection and AGO-66 scopes the "blocks inline scripts" criterion to scripts.
 * - `img-src` / `connect-src` allow `blob:` and `data:` because three.js GLTFLoader turns embedded
 *   textures and buffers into blob and data URLs. `worker-src blob:` covers three.js / drei workers.
 * - No `form-action`: the OAuth start redirects a no-JS form POST through Supabase to Google or
 *   GitHub, and Chrome applies `form-action` to every hop of that redirect chain.
 */
export function buildContentSecurityPolicy({
  nonce,
  isDevelopment,
  supabaseUrl,
  sentryDsn,
}: CspOptions): string {
  // 'wasm-unsafe-eval' lets WebAssembly compile (the Pixel/Mannequin GLBs are meshopt-compressed,
  // and three.js decodes them in wasm). It does not allow eval() or new Function().
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", "'wasm-unsafe-eval'"];
  if (isDevelopment) scriptSrc.push("'unsafe-eval'");

  const connectSrc = [
    "'self'",
    "blob:",
    "data:",
    ...supabaseSources(supabaseUrl),
    ...sentrySources(sentryDsn),
  ];

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": scriptSrc,
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "blob:", "data:"],
    "font-src": ["'self'"],
    "connect-src": connectSrc,
    "worker-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "frame-ancestors": ["'none'"],
  };

  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}
