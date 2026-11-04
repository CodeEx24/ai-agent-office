import type { BrowserContext, Cookie } from "@playwright/test";

/** The Supabase session cookie: `sb-<ref>-auth-token` (not the `-code-verifier` helpers). */
const SESSION_COOKIE = /^sb-[^.]+-auth-token$/;
const BASE64_PREFIX = "base64-";

interface StoredSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  [key: string]: unknown;
}

export async function readSessionCookie(
  context: BrowserContext,
): Promise<{ cookie: Cookie; session: StoredSession }> {
  const cookie = (await context.cookies()).find((c) => SESSION_COOKIE.test(c.name));
  if (!cookie) throw new Error("No Supabase session cookie in this browser context");
  if (!cookie.value.startsWith(BASE64_PREFIX)) throw new Error("Unexpected session cookie format");
  const json = Buffer.from(cookie.value.slice(BASE64_PREFIX.length), "base64url").toString("utf8");
  return { cookie, session: JSON.parse(json) as StoredSession };
}

/** Replaces the session cookie with `session` (re-encoded the way @supabase/ssr stores it). */
export async function writeSessionCookie(
  context: BrowserContext,
  cookie: Cookie,
  session: StoredSession,
): Promise<void> {
  const value = BASE64_PREFIX + Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  await context.addCookies([{ ...cookie, value }]);
}

/**
 * Changes a character in the middle of the token's last segment (the signature of a JWT, or the
 * whole of an opaque refresh token). Never the final character: it can hold base64 padding bits
 * that decoders ignore, which would leave the token valid.
 */
export function tamper(token: string): string {
  const start = token.lastIndexOf(".") + 1;
  const index = start + Math.floor((token.length - start) / 2);
  return token.slice(0, index) + (token[index] === "A" ? "B" : "A") + token.slice(index + 1);
}
