import Link from "next/link";

// Shown inside the signed-in app shell (header and sign-out stay) when a page calls notFound(), for example the run
// view (AGO-153) for a missing run, a run of another workspace or a malformed id. The three cases look the same on
// purpose: the page never says whether a run exists elsewhere.
export default function AppNotFound() {
  return (
    <main className="mx-auto grid max-w-2xl gap-4 p-8">
      <h1 className="text-2xl font-bold tracking-tight">We couldn&apos;t find that page</h1>
      <p className="text-sm text-muted-foreground">
        It may have been removed, or it may belong to another workspace. Check the link, or go back
        to a place you know.
      </p>
      <nav aria-label="Where to go next" className="flex flex-wrap gap-4 text-sm">
        <Link href="/app/office" className="text-primary underline-offset-2 hover:underline">
          Back to the office
        </Link>
        <Link href="/app/agents" className="text-primary underline-offset-2 hover:underline">
          See your agents
        </Link>
      </nav>
    </main>
  );
}
