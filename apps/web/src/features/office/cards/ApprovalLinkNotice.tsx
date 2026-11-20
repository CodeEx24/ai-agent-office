/**
 * Shown on the approvals page when a card opened it for a request that is not in the pending list: it was decided
 * already, it expired, or the person cannot see it. A cue, not an error: the inbox below still works, and nothing
 * here can decide anything.
 */
export function ApprovalLinkNotice() {
  return (
    <p
      role="status"
      data-testid="approval-link-not-pending"
      className="rounded-md border bg-muted px-4 py-3 text-sm"
    >
      That request is no longer pending. It was decided already, it expired, or you cannot see it.
    </p>
  );
}
