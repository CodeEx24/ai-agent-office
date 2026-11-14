import type { AgentChangeKind, AgentVersion, AgentVersionChangedField } from "@ago/shared";

const KIND_LABELS: Record<AgentChangeKind, string> = {
  create: "Created",
  edit: "Edited",
  archive: "Archived",
  unarchive: "Unarchived",
};

const FIELD_LABELS: Record<AgentVersionChangedField, string> = {
  name: "name",
  role: "role",
  model: "model",
  thinking_effort: "thinking effort",
  prompt: "prompt",
  daily_budget_cents: "daily budget",
  archived_at: "archive state",
};

/** A fixed UTC format, so the server and the browser render the same text. */
export function formatVersionTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown time";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The "Changed …" sentence of a row. Archive and unarchive rows already say what happened in their heading,
 * so they get no list; the database lists `archived_at` there, which has no plain name. Unknown fields are
 * dropped rather than printed as blanks.
 */
export function changeSentence(version: AgentVersion): string {
  if (version.changeKind === "archive" || version.changeKind === "unarchive") return "";
  const labels = version.changedFields
    .map((field) => FIELD_LABELS[field])
    .filter((label): label is string => Boolean(label));
  return labels.length > 0 ? `Changed ${labels.join(", ")}. ` : "";
}

/**
 * The history of one agent, newest first (AGO-89). Each row is an immutable version that also serves as the
 * audit log: what kind of change, which settings changed, who made it and when. The prompt is shown as plain
 * text only when the owner opens it; it is untrusted text and is never interpreted.
 */
export function AgentVersionList({ versions }: { versions: readonly AgentVersion[] }) {
  if (versions.length === 0) {
    return <p className="text-sm text-muted-foreground">No history yet.</p>;
  }
  return (
    <ol className="grid gap-2" aria-label="Version history" data-testid="agent-versions">
      {versions.map((version) => (
        <li key={version.version} className="min-w-0 rounded-md border px-3 py-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium">
              Version {String(version.version)} · {KIND_LABELS[version.changeKind]}
            </span>
            <time dateTime={version.createdAt} className="text-xs text-muted-foreground">
              {formatVersionTime(version.createdAt)}
            </time>
          </div>
          <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
            {changeSentence(version)}
            By {version.changedByName ?? "an unknown member"}.
          </p>
          <details className="mt-1">
            <summary className="cursor-pointer text-sm text-primary underline underline-offset-4">
              Settings at this version
            </summary>
            <dl className="mt-1 grid gap-1 text-sm [overflow-wrap:anywhere]">
              <div>
                <dt className="inline font-medium">Name: </dt>
                <dd className="inline">{version.name}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Role: </dt>
                <dd className="inline">{version.role}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Model: </dt>
                <dd className="inline">{version.model}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Thinking effort: </dt>
                <dd className="inline">{version.thinkingEffort}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Daily budget: </dt>
                <dd className="inline">
                  {version.dailyBudgetCents === null
                    ? "not set"
                    : `$${(version.dailyBudgetCents / 100).toFixed(2)}`}
                </dd>
              </div>
              <div>
                <dt className="font-medium">Prompt</dt>
                <dd>
                  <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 whitespace-pre-wrap">
                    {version.prompt}
                  </pre>
                </dd>
              </div>
            </dl>
          </details>
        </li>
      ))}
    </ol>
  );
}
