import type { Goal } from "@ago/shared";

/**
 * Recent goals, newest first (AGO-113). The text is untrusted data from a person: it is rendered as plain text
 * (React escapes it) with its line breaks kept, never as markup or a link.
 */
export function GoalList({ goals }: { goals: Goal[] }) {
  if (goals.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="goal-list-empty">
        No goals yet. Submit the first one above.
      </p>
    );
  }
  return (
    <ul className="grid gap-3" aria-label="Submitted goals">
      {goals.map((goal) => (
        <li key={goal.id} className="grid gap-1 rounded-md border p-3">
          <p className="text-sm break-words whitespace-pre-wrap">{goal.text}</p>
          <time className="text-xs text-muted-foreground" dateTime={goal.createdAt}>
            {new Date(goal.createdAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC
          </time>
        </li>
      ))}
    </ul>
  );
}
