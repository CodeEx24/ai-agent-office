import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getCurrentUser } from "../../features/auth/current-user";
import { getEnabledOAuthProviders } from "../../features/auth/enabled-providers";
import { safeNextPath } from "../../features/auth/safe-next-path";
import { signInQuerySchema } from "../../features/auth/schemas";
import { SignInForm } from "../../features/auth/SignInForm";
import { parseInput } from "../../lib/validation/parse-input";

export const metadata: Metadata = { title: "Sign in · Agent Office" };

const NOTICES: Record<string, string> = {
  callback: "Sign-in could not be completed. The link may have expired. Please try again.",
  provider: "That sign-in provider is not available right now.",
};

interface SignInPageProps {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>;
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const query = parseInput(signInQuerySchema, await searchParams);
  const params = query.success ? query.data : {};
  const next = safeNextPath(params.next);

  if (await getCurrentUser()) redirect(next);

  const errorKey = params.error;
  // hasOwn: `?error=__proto__` must not resolve to an Object.prototype member.
  const notice = errorKey && Object.hasOwn(NOTICES, errorKey) ? NOTICES[errorKey] : undefined;

  const providers = await getEnabledOAuthProviders();

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <SignInForm next={next} notice={notice} providers={providers} />
    </main>
  );
}
