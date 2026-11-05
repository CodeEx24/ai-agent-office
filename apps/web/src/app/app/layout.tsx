import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { getCurrentUser } from "../../features/auth/current-user";
import { signInPathFor } from "../../features/auth/routes";
import { SignOutButton } from "../../features/auth/SignOutButton";

// Second gate behind proxy.ts: never rely on the proxy alone. getUser() asks the Auth server, so a
// revoked or expired session is rejected here even if the cookie still looks valid.
export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect(signInPathFor("/app"));

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <span className="font-semibold">Agent Office</span>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground" data-testid="signed-in-email">
            {user.email}
          </span>
          <SignOutButton />
        </div>
      </header>
      {children}
    </div>
  );
}
