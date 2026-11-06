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
 * Signs `user` in to the app by writing the session cookie directly, the same shape @supabase/ssr
 * stores (`sb-<project ref>-auth-token`, base64url JSON). It skips the magic-link round trip, which
 * is rate limited per IP at `/auth/callback`: a spec that needs several signed-in roles should use
 * this instead of signing in through the UI. The tokens come from a real sign-up on the local stack,
 * so the server still verifies them with the Auth server on every request.
 */
export async function signInWithSessionCookie(
  context: BrowserContext,
  baseURL: string,
  user: { id: string; email: string; accessToken: string; refreshToken: string },
  supabaseUrl: string = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:44321",
): Promise<void> {
  const projectRef = new URL(supabaseUrl).hostname.split(".")[0] ?? "";
  const expiresIn = 3600;
  const session = {
    access_token: user.accessToken,
    refresh_token: user.refreshToken,
    token_type: "bearer",
    expires_in: expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    user: { id: user.id, email: user.email },
  };
  await context.addCookies([
    {
      name: `sb-${projectRef}-auth-token`,
      value: BASE64_PREFIX + Buffer.from(JSON.stringify(session), "utf8").toString("base64url"),
      url: baseURL,
    },
  ]);
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
