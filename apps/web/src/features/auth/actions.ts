"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { resolveOrigin } from "../../lib/request-origin";
import { createSupabaseServerClient } from "../../lib/supabase/server";
import { oauthProviderSchema, sendCodeSchema, verifyCodeSchema } from "./schemas";
import { safeNextPath } from "./safe-next-path";
import { SIGN_IN_PATH } from "./routes";

export type SignInState =
  { step: "email"; error?: string } | { step: "code"; email: string; error?: string };

const GENERIC_ERROR = "Something went wrong. Please try again.";

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/** Step 1: email the user a one-time code (and a magic link). Creates the account on first use. */
export async function sendCodeAction(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const parsed = sendCodeSchema.safeParse({ email: formString(formData, "email") });
  if (!parsed.success) {
    return { step: "email", error: parsed.error.issues[0]?.message ?? GENERIC_ERROR };
  }

  const next = safeNextPath(formString(formData, "next"));
  const redirectTo = `${resolveOrigin(await headers())}/auth/callback?next=${encodeURIComponent(next)}`;

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: parsed.data.email,
      options: { emailRedirectTo: redirectTo },
    });
    if (error) return { step: "email", error: "We could not send the email. Please try again." };
  } catch {
    return { step: "email", error: GENERIC_ERROR };
  }
  return { step: "code", email: parsed.data.email };
}

/** Step 2: exchange the emailed code for a session, then land on the (validated) next path. */
export async function verifyCodeAction(
  _prev: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const parsed = verifyCodeSchema.safeParse({
    email: formString(formData, "email"),
    token: formString(formData, "token"),
  });
  if (!parsed.success) {
    const email = formString(formData, "email");
    return { step: "code", email, error: parsed.error.issues[0]?.message ?? GENERIC_ERROR };
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.verifyOtp({
      email: parsed.data.email,
      token: parsed.data.token,
      type: "email",
    });
    if (error) {
      return { step: "code", email: parsed.data.email, error: "That code is invalid or expired." };
    }
  } catch {
    return { step: "code", email: parsed.data.email, error: GENERIC_ERROR };
  }

  redirect(safeNextPath(formString(formData, "next")));
}

/** Starts Google/GitHub sign-in: builds the provider URL on the server and redirects to it. */
export async function signInWithOAuthAction(formData: FormData): Promise<void> {
  const provider = oauthProviderSchema.safeParse(formString(formData, "provider"));
  if (!provider.success) redirect(`${SIGN_IN_PATH}?error=provider`);

  const next = safeNextPath(formString(formData, "next"));
  let url: string | null = null;
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: provider.data,
      options: {
        redirectTo: `${resolveOrigin(await headers())}/auth/callback?next=${encodeURIComponent(next)}`,
        skipBrowserRedirect: true,
      },
    });
    url = error ? null : data.url;
  } catch {
    url = null;
  }
  // redirect() throws, so it must stay outside the try/catch above.
  redirect(url ?? `${SIGN_IN_PATH}?error=provider`);
}

/** Ends the session (clears the Supabase cookies). Called by a POST form, never a link. */
export async function signOutAction(): Promise<void> {
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  } catch {
    // Even if Supabase is unreachable the local cookies are cleared by the client on signOut.
  }
  redirect(SIGN_IN_PATH);
}
