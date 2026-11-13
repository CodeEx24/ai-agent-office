"use client";

import { useActionState, useState, type SubmitEvent } from "react";
import {
  AGENT_FIELD_LABELS,
  AGENT_MODELS,
  AGENT_NAME_MAX_LENGTH,
  AGENT_PROMPT_MAX_LENGTH,
  AGENT_ROLE_MAX_LENGTH,
  AGENT_THINKING_EFFORTS,
  checkAgentEditDraft,
  type AgentField,
  type AgentFieldErrors,
} from "@ago/shared/agent-limits";
import { Button, Input, Label } from "@ago/ui";

import { unarchiveAgentAction, updateAgentAction } from "./actions";
import type { AgentEditState } from "./edit-agent";

const INITIAL_STATE: AgentEditState = {};

/** What the form needs to show an agent. Settings only: no mode, no status, no skills or capabilities. */
export interface EditableAgent {
  id: string;
  name: string;
  role: string;
  model: string;
  thinkingEffort: string;
  prompt: string;
  dailyBudgetCents: number | null;
  version: number;
  isArchived: boolean;
}

const FIELD_CLASS =
  "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive";

const fieldId = (field: AgentField) => `edit-agent-${field}`;

function FieldError({ field, message }: { field: AgentField; message?: string }) {
  if (!message) return null;
  return (
    <p id={`${fieldId(field)}-error`} role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

/**
 * Edit form for one agent (AGO-89): name, role, model, thinking effort, prompt and daily budget. Owners only:
 * the page does not render it for anyone else and the server action checks the role again. The version the
 * form was loaded with is sent back, so an edit made on an older version is refused. Skills and capabilities
 * are not editable here. An archived agent shows its settings read-only.
 */
export function AgentEditForm({
  workspaceId,
  agent,
}: {
  workspaceId: string;
  agent: EditableAgent;
}) {
  const [state, action, isPending] = useActionState(updateAgentAction, INITIAL_STATE);
  const [unarchiveState, unarchive, isUnarchiving] = useActionState(
    unarchiveAgentAction,
    INITIAL_STATE,
  );
  const [draft, setDraft] = useState({
    name: agent.name,
    role: agent.role,
    model: agent.model,
    thinkingEffort: agent.thinkingEffort,
    prompt: agent.prompt,
    dailyBudget: agent.dailyBudgetCents === null ? "" : (agent.dailyBudgetCents / 100).toFixed(2),
  });
  const [errors, setErrors] = useState<AgentFieldErrors>({});
  const [seenServerState, setSeenServerState] = useState(state);
  // Bumped after every action result. React resets the form's controls after an action, which puts a
  // select back to its mount-time option; remounting the two selects with the current draft undoes that.
  const [formEpoch, setFormEpoch] = useState(0);

  // A server-side refusal is shown next to its field (React's pattern for reacting to a changed value).
  if (state !== seenServerState) {
    setSeenServerState(state);
    setFormEpoch((epoch) => epoch + 1);
    setErrors(state.fieldErrors ?? {});
    const first = state.fieldErrors
      ? (Object.keys(state.fieldErrors) as AgentField[])[0]
      : undefined;
    if (first) queueMicrotask(() => document.getElementById(fieldId(first))?.focus());
  }

  const update = (patch: Partial<typeof draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    const found = checkAgentEditDraft(draft);
    const first = (Object.keys(found) as AgentField[])[0];
    if (first) {
      event.preventDefault();
      setErrors(found);
      document.getElementById(fieldId(first))?.focus();
    }
  }

  const describedBy = (field: AgentField) =>
    errors[field] ? `${fieldId(field)}-error` : undefined;
  const isLocked = agent.isArchived;
  const currentVersion = state.version ?? agent.version;

  return (
    <form
      action={action}
      onSubmit={onSubmit}
      className="grid gap-3"
      aria-label={`Edit ${agent.name}`}
      noValidate
    >
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="agentId" value={agent.id} />
      <input type="hidden" name="expectedVersion" value={String(currentVersion)} />
      {/* Model and thinking effort are sent from state, not read from the selects (see formEpoch). */}
      <input type="hidden" name="model" value={draft.model} />
      <input type="hidden" name="thinkingEffort" value={draft.thinkingEffort} />

      {isLocked ? (
        <div
          role="status"
          className="grid gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground"
        >
          <p>This agent is archived. Unarchive it to change its settings.</p>
          {unarchiveState.error ? (
            <p role="alert" className="text-destructive">
              {unarchiveState.error}
            </p>
          ) : null}
          <form action={unarchive} aria-label={`Unarchive ${agent.name}`}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="agentId" value={agent.id} />
            <Button type="submit" variant="outline" size="sm" disabled={isUnarchiving}>
              {isUnarchiving ? "Unarchiving…" : "Unarchive"}
            </Button>
          </form>
        </div>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.done ? (
        <p role="status" className="text-sm text-muted-foreground">
          Saved. This agent is now at version {String(currentVersion)}.
        </p>
      ) : null}

      <fieldset disabled={isLocked || isPending} className="grid gap-3">
        <Label htmlFor={fieldId("name")}>{AGENT_FIELD_LABELS.name}</Label>
        <Input
          id={fieldId("name")}
          name="name"
          value={draft.name}
          maxLength={AGENT_NAME_MAX_LENGTH}
          onChange={(event) => {
            update({ name: event.target.value });
          }}
          aria-invalid={Boolean(errors.name)}
          aria-describedby={describedBy("name")}
          autoComplete="off"
        />
        <FieldError field="name" message={errors.name} />

        <Label htmlFor={fieldId("role")}>{AGENT_FIELD_LABELS.role}</Label>
        <Input
          id={fieldId("role")}
          name="role"
          value={draft.role}
          maxLength={AGENT_ROLE_MAX_LENGTH}
          onChange={(event) => {
            update({ role: event.target.value });
          }}
          aria-invalid={Boolean(errors.role)}
          aria-describedby={describedBy("role")}
          autoComplete="off"
        />
        <FieldError field="role" message={errors.role} />

        <Label htmlFor={fieldId("model")}>{AGENT_FIELD_LABELS.model}</Label>
        <select
          key={`${fieldId("model")}-${String(formEpoch)}`}
          id={fieldId("model")}
          defaultValue={draft.model}
          onChange={(event) => {
            update({ model: event.target.value });
          }}
          aria-invalid={Boolean(errors.model)}
          aria-describedby={describedBy("model")}
          className={FIELD_CLASS}
        >
          <option value="">Choose a model</option>
          {AGENT_MODELS.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
        <FieldError field="model" message={errors.model} />

        <Label htmlFor={fieldId("thinkingEffort")}>{AGENT_FIELD_LABELS.thinkingEffort}</Label>
        <select
          key={`${fieldId("thinkingEffort")}-${String(formEpoch)}`}
          id={fieldId("thinkingEffort")}
          defaultValue={draft.thinkingEffort}
          onChange={(event) => {
            update({ thinkingEffort: event.target.value });
          }}
          aria-invalid={Boolean(errors.thinkingEffort)}
          aria-describedby={describedBy("thinkingEffort")}
          className={FIELD_CLASS}
        >
          <option value="">Choose a level</option>
          {AGENT_THINKING_EFFORTS.map((effort) => (
            <option key={effort.id} value={effort.id}>
              {effort.label}
            </option>
          ))}
        </select>
        <FieldError field="thinkingEffort" message={errors.thinkingEffort} />

        <Label htmlFor={fieldId("prompt")}>{AGENT_FIELD_LABELS.prompt}</Label>
        <textarea
          id={fieldId("prompt")}
          name="prompt"
          value={draft.prompt}
          maxLength={AGENT_PROMPT_MAX_LENGTH}
          onChange={(event) => {
            update({ prompt: event.target.value });
          }}
          aria-invalid={Boolean(errors.prompt)}
          aria-describedby={describedBy("prompt")}
          className={`${FIELD_CLASS} min-h-32`}
        />
        <FieldError field="prompt" message={errors.prompt} />

        <Label htmlFor={fieldId("dailyBudget")}>
          {AGENT_FIELD_LABELS.dailyBudget} (US dollars)
        </Label>
        <Input
          id={fieldId("dailyBudget")}
          name="dailyBudget"
          value={draft.dailyBudget}
          inputMode="decimal"
          onChange={(event) => {
            update({ dailyBudget: event.target.value });
          }}
          aria-invalid={Boolean(errors.dailyBudget)}
          aria-describedby={describedBy("dailyBudget")}
          autoComplete="off"
        />
        <FieldError field="dailyBudget" message={errors.dailyBudget} />
      </fieldset>

      {isLocked ? null : (
        <div>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      )}
    </form>
  );
}
