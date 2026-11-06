"use client";

import { startTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@ago/ui";

// Error boundary for /app (AGO-201). `getActiveWorkspace` throws when the workspace lookup fails,
// so an outage shows this instead of the first-run onboarding form. The message is fixed text:
// nothing from the error (which Sentry captures) is rendered.
// `reset()` alone only re-renders the client boundary; the server component must be re-fetched
// with `router.refresh()` (Next 16 recommended pattern) or the user stays stuck until a reload.
export default function WorkspaceError({ reset }: { error: Error; reset: () => void }) {
  const router = useRouter();

  function retry() {
    startTransition(() => {
      router.refresh();
      reset();
    });
  }

  return (
    <main className="mx-auto grid max-w-2xl gap-4 p-8">
      <h1 className="text-2xl font-bold tracking-tight">Your workspace</h1>
      <p role="alert" className="text-muted-foreground">
        We could not load your workspace. Please try again.
      </p>
      <div>
        <Button type="button" onClick={retry}>
          Try again
        </Button>
      </div>
    </main>
  );
}
