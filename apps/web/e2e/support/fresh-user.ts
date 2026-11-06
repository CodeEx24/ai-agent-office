import { randomUUID } from "node:crypto";

import type { Browser, BrowserContext } from "@playwright/test";

import { membershipsOf } from "./stack-api";

// A dedicated, freshly signed-up user per test, signed in by writing the Supabase session cookie
// directly (no email, no shared storage state). Rate-limit specs need this: they exhaust a
// per-user bucket, which would 429 every other signed-in spec if they used the shared user.
// Local stack only. URL and anon key come from the same env vars the app uses.

const API_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:44321";

interface SignUpResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  token_type: string;
  user: { id: string; email: string };
}

export interface FreshUser {
  id: string;
  email: string;
  context: BrowserContext;
  /** Workspace memberships recorded for this user (ground truth, read with service_role). */
  memberships: () => Promise<number>;
}

export async function signedInFreshUser(
  browser: Browser,
  baseURL: string,
  label: string,
): Promise<FreshUser> {
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonKey) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is required for live specs");

  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const response = await fetch(`${API_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anonKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password: `Pw-${randomUUID()}` }),
  });
  if (!response.ok) throw new Error(`sign-up failed: ${String(response.status)}`);
  const session = (await response.json()) as SignUpResponse;

  // @supabase/ssr stores the session as `sb-<first host label>-auth-token` = "base64-" + base64url(JSON).
  const cookieName = `sb-${new URL(API_URL).hostname.split(".")[0] ?? ""}-auth-token`;
  const context = await browser.newContext({ baseURL });
  await context.addCookies([
    {
      name: cookieName,
      value: `base64-${Buffer.from(JSON.stringify(session), "utf8").toString("base64url")}`,
      url: baseURL,
      httpOnly: false,
      sameSite: "Lax",
    },
  ]);

  return {
    id: session.user.id,
    email,
    context,
    memberships: async () => (await membershipsOf(session.user.id)).length,
  };
}
