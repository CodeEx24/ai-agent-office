"use client";

import { Button } from "@ago/ui";

// Error boundary for /app (AGO-201). `getActiveWorkspace` throws when the workspace lookup fails,
// so an outage shows this instead of the first-run onboarding form. The message is fixed text:
// nothing from the error (which Sentry captures) is rendered.
export default function WorkspaceError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto grid max-w-2xl gap-4 p-8">
      <h1 className="text-2xl font-bold tracking-tight">Your workspace</h1>
      <p role="alert" className="text-muted-foreground">
        We could not load your workspace. Please try again.
      </p>
      <div>
        <Button type="button" onClick={reset}>
          Try again
        </Button>
      </div>
    </main>
  );
}
