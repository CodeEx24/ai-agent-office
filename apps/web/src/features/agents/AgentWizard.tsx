"use client";

import { useActionState, useEffect, useRef, useState, type SubmitEvent } from "react";
import {
  AGENT_DAILY_BUDGET_DEFAULT_CENTS,
  AGENT_DAILY_BUDGET_MAX_CENTS,
  AGENT_FIELD_LABELS,
  AGENT_MODELS,
  AGENT_NAME_MAX_LENGTH,
  AGENT_PROMPT_MAX_LENGTH,
  AGENT_ROLE_MAX_LENGTH,
  AGENT_WIZARD_STEPS,
  checkAgentDraft,
  parseDailyBudget,
  type AgentField,
  type AgentFieldErrors,
} from "@ago/shared/agent-limits";
import { Button, Input, Label } from "@ago/ui";

import { createAgentAction } from "./actions";
import type { AgentWizardState } from "./create-agent";

const INITIAL_STATE: AgentWizardState = {};
/** Tier 3 and 4 can never run on their own (mirrors MIN_NEVER_AUTOMATIC_TIER in @ago/shared). */
const MIN_APPROVAL_ONLY_TIER = 3;

export interface WizardSkill {
  id: string;
  name: string;
  description: string;
}

export interface WizardCapability {
  key: string;
  name: string;
  description: string;
  tier: number;
  defaultMode: "automatic" | "approval";
}

type CapabilityMode = "automatic" | "approval";

interface Draft {
  name: string;
  role: string;
  model: string;
  prompt: string;
  dailyBudget: string;
  skillIds: string[];
  capabilities: Record<string, CapabilityMode>;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  role: "",
  model: "",
  prompt: "",
  dailyBudget: (AGENT_DAILY_BUDGET_DEFAULT_CENTS / 100).toFixed(2),
  skillIds: [],
  capabilities: {},
};

const FIELD_CLASS =
  "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive";

const fieldId = (field: AgentField) => `agent-${field}`;

function FieldError({ field, message }: { field: AgentField; message?: string }) {
  if (!message) return null;
  return (
    <p id={`${fieldId(field)}-error`} role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

function stepIndexOf(field: AgentField): number {
  const index = AGENT_WIZARD_STEPS.findIndex((step) =>
    (step.fields as readonly AgentField[]).includes(field),
  );
  return Math.max(index, 0);
}

/**
 * The agent creation wizard (AGO-141): basics, skills, capabilities, budget, then a review step before the
 * agent is created. The draft lives in this component, so it survives Back and Next. Owners only: the page
 * does not render it for anyone else, and the server action checks the role again.
 *
 * Client checks use the zod-free helpers from `@ago/shared/agent-limits`; the server validates again with the
 * zod schema, and a Tier 3 or 4 capability is always "needs approval" (the choice is not offered).
 */
export function AgentWizard({
  workspaceId,
  skills,
  capabilities,
}: {
  workspaceId: string;
  skills: WizardSkill[];
  capabilities: WizardCapability[];
}) {
  const [state, action, isPending] = useActionState(createAgentAction, INITIAL_STATE);
  const [stepIndex, setStepIndex] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<AgentFieldErrors>({});
  // A request to move focus: to a field, or (field null) to the step heading. n makes each request new.
  const [focusRequest, setFocusRequest] = useState<{ field: AgentField | null; n: number }>({
    field: null,
    n: 0,
  });
  const [seenServerState, setSeenServerState] = useState(state);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const step = AGENT_WIZARD_STEPS[stepIndex] ?? AGENT_WIZARD_STEPS[0];
  const isReview = step.id === "review";

  function requestFocus(field: AgentField | null) {
    setFocusRequest((current) => ({ field, n: current.n + 1 }));
  }

  // A server-side refusal is shown next to its field: go to that step and focus the field. This adjusts
  // state while rendering (React's pattern for reacting to a changed value) instead of in an effect.
  if (state !== seenServerState) {
    setSeenServerState(state);
    const first = state.fieldErrors
      ? (Object.keys(state.fieldErrors) as AgentField[])[0]
      : undefined;
    if (state.fieldErrors && first) {
      setErrors(state.fieldErrors);
      setStepIndex(stepIndexOf(first));
      requestFocus(first);
    }
  }

  // Focus follows a step change or the first invalid field, after the new step has rendered.
  useEffect(() => {
    if (focusRequest.n === 0) return;
    const target = focusRequest.field ? document.getElementById(fieldId(focusRequest.field)) : null;
    (target ?? headingRef.current)?.focus();
  }, [focusRequest]);

  const update = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  function validate(fields: readonly AgentField[]): boolean {
    const all = checkAgentDraft(draft);
    const relevant: AgentFieldErrors = {};
    for (const field of fields) {
      const message = all[field];
      if (message) relevant[field] = message;
    }
    setErrors(relevant);
    const first = fields.find((field) => relevant[field]);
    if (first) requestFocus(first);
    return !first;
  }

  function goNext() {
    if (!validate(step.fields)) return;
    setStepIndex((index) => Math.min(index + 1, AGENT_WIZARD_STEPS.length - 1));
    requestFocus(null);
  }

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    if (!isReview) {
      event.preventDefault(); // Enter in a field moves on; only the review step creates the agent
      goNext();
      return;
    }
    const all = checkAgentDraft(draft);
    const first = (Object.keys(all) as AgentField[])[0];
    if (first) {
      event.preventDefault();
      setErrors(all);
      setStepIndex(stepIndexOf(first));
      requestFocus(first);
    }
  }

  const describedBy = (field: AgentField) =>
    errors[field] ? `${fieldId(field)}-error` : undefined;
  const budget = parseDailyBudget(draft.dailyBudget);
  const grants = Object.entries(draft.capabilities);

  return (
    <form
      action={action}
      onSubmit={onSubmit}
      className="grid gap-5"
      aria-label="New agent"
      noValidate
    >
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="name" value={draft.name} />
      <input type="hidden" name="role" value={draft.role} />
      <input type="hidden" name="model" value={draft.model} />
      <input type="hidden" name="prompt" value={draft.prompt} />
      <input type="hidden" name="dailyBudget" value={draft.dailyBudget} />
      <input type="hidden" name="skillIds" value={JSON.stringify(draft.skillIds)} />
      <input
        type="hidden"
        name="capabilities"
        value={JSON.stringify(grants.map(([key, mode]) => ({ key, mode })))}
      />

      <ol className="flex flex-wrap gap-2 text-sm" aria-label="Steps">
        {AGENT_WIZARD_STEPS.map((item, index) => (
          <li
            key={item.id}
            aria-current={index === stepIndex ? "step" : undefined}
            className={
              index === stepIndex
                ? "rounded-full bg-primary px-3 py-1 text-primary-foreground"
                : "rounded-full border px-3 py-1 text-muted-foreground"
            }
          >
            {index + 1}. {item.title}
          </li>
        ))}
      </ol>

      <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
        {step.title}
      </h2>

      {step.id === "basics" ? (
        <div className="grid gap-3">
          <Label htmlFor={fieldId("name")}>{AGENT_FIELD_LABELS.name}</Label>
          <Input
            id={fieldId("name")}
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
            value={draft.role}
            maxLength={AGENT_ROLE_MAX_LENGTH}
            placeholder="For example Researcher"
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
            id={fieldId("model")}
            value={draft.model}
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

          <Label htmlFor={fieldId("prompt")}>{AGENT_FIELD_LABELS.prompt}</Label>
          <textarea
            id={fieldId("prompt")}
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
        </div>
      ) : null}

      {step.id === "skills" ? (
        <fieldset className="grid gap-2" aria-describedby={describedBy("skillIds")}>
          <legend className="text-sm text-muted-foreground">
            Skills are know-how, not permission. Pick any that should come with this agent.
          </legend>
          {skills.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No skills yet. You can add some later from the Skills page.
            </p>
          ) : (
            skills.map((skill) => (
              <label key={skill.id} className="flex items-start gap-2 rounded-md border p-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={draft.skillIds.includes(skill.id)}
                  onChange={(event) => {
                    update({
                      skillIds: event.target.checked
                        ? [...draft.skillIds, skill.id]
                        : draft.skillIds.filter((id) => id !== skill.id),
                    });
                  }}
                />
                <span>
                  <span className="font-medium">{skill.name}</span>
                  {skill.description ? (
                    <span className="block text-sm text-muted-foreground">{skill.description}</span>
                  ) : null}
                </span>
              </label>
            ))
          )}
          <FieldError field="skillIds" message={errors.skillIds} />
        </fieldset>
      ) : null}

      {step.id === "capabilities" ? (
        <fieldset
          id={fieldId("capabilities")}
          tabIndex={-1}
          className="grid gap-2"
          aria-describedby={describedBy("capabilities")}
        >
          <legend className="text-sm text-muted-foreground">
            What the agent may do. Tier 3 and 4 capabilities always need a person&apos;s approval.
          </legend>
          {capabilities.map((capability) => {
            const mode = draft.capabilities[capability.key];
            const isChecked = mode !== undefined;
            const isApprovalOnly = capability.tier >= MIN_APPROVAL_ONLY_TIER;
            const controlId = `capability-${capability.key}`;
            return (
              <div key={capability.key} className="grid gap-1 rounded-md border p-2">
                <label className="flex items-start gap-2" htmlFor={controlId}>
                  <input
                    id={controlId}
                    type="checkbox"
                    className="mt-1"
                    checked={isChecked}
                    onChange={(event) => {
                      const others = Object.fromEntries(
                        Object.entries(draft.capabilities).filter(
                          ([key]) => key !== capability.key,
                        ),
                      );
                      update({
                        capabilities: event.target.checked
                          ? {
                              ...others,
                              [capability.key]: isApprovalOnly
                                ? "approval"
                                : capability.defaultMode,
                            }
                          : others,
                      });
                    }}
                  />
                  <span>
                    <span className="font-medium">{capability.name}</span>{" "}
                    <span className="text-xs text-muted-foreground">Tier {capability.tier}</span>
                    {capability.description ? (
                      <span className="block text-sm text-muted-foreground">
                        {capability.description}
                      </span>
                    ) : null}
                  </span>
                </label>
                {isChecked ? (
                  isApprovalOnly ? (
                    <p className="pl-6 text-sm">Needs approval every time</p>
                  ) : (
                    <div className="flex items-center gap-2 pl-6 text-sm">
                      <Label htmlFor={`${controlId}-mode`}>
                        <span className="sr-only">{capability.name}: </span>Runs
                      </Label>
                      <select
                        id={`${controlId}-mode`}
                        value={mode}
                        onChange={(event) => {
                          update({
                            capabilities: {
                              ...draft.capabilities,
                              [capability.key]:
                                event.target.value === "automatic" ? "automatic" : "approval",
                            },
                          });
                        }}
                        className={`${FIELD_CLASS} w-auto py-1`}
                      >
                        <option value="approval">After my approval</option>
                        <option value="automatic">Automatically</option>
                      </select>
                    </div>
                  )
                ) : null}
              </div>
            );
          })}
          <FieldError field="capabilities" message={errors.capabilities} />
        </fieldset>
      ) : null}

      {step.id === "budget" ? (
        <div className="grid gap-2">
          <Label htmlFor={fieldId("dailyBudget")}>
            {AGENT_FIELD_LABELS.dailyBudget} (US dollars)
          </Label>
          <Input
            id={fieldId("dailyBudget")}
            value={draft.dailyBudget}
            inputMode="decimal"
            onChange={(event) => {
              update({ dailyBudget: event.target.value });
            }}
            aria-invalid={Boolean(errors.dailyBudget)}
            aria-describedby={[`${fieldId("dailyBudget")}-hint`, describedBy("dailyBudget")]
              .filter(Boolean)
              .join(" ")}
            autoComplete="off"
          />
          <p id={`${fieldId("dailyBudget")}-hint`} className="text-sm text-muted-foreground">
            The most this agent may spend in a day. Between $0.01 and $
            {(AGENT_DAILY_BUDGET_MAX_CENTS / 100).toFixed(2)}.
          </p>
          <FieldError field="dailyBudget" message={errors.dailyBudget} />
        </div>
      ) : null}

      {isReview ? (
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            Check the details. The agent starts in <strong>Strict</strong> mode, the most careful
            setting.
          </p>
          <dl className="grid gap-1 text-sm" data-testid="review">
            <ReviewRow label="Name" value={draft.name.trim()} />
            <ReviewRow label="Role" value={draft.role.trim()} />
            <ReviewRow
              label="Model"
              value={AGENT_MODELS.find((model) => model.id === draft.model)?.label ?? ""}
            />
            <ReviewRow label="Prompt" value={draft.prompt.trim()} />
            <ReviewRow
              label="Skills"
              value={
                skills
                  .filter((skill) => draft.skillIds.includes(skill.id))
                  .map((skill) => skill.name)
                  .join(", ") || "None"
              }
            />
            <ReviewRow
              label="Capabilities"
              value={
                capabilities
                  .filter((capability) => capability.key in draft.capabilities)
                  .map(
                    (capability) =>
                      `${capability.name} (${
                        draft.capabilities[capability.key] === "automatic"
                          ? "automatic"
                          : "needs approval"
                      })`,
                  )
                  .join(", ") || "None"
              }
            />
            <ReviewRow
              label="Daily budget"
              value={budget.ok ? `$${(budget.cents / 100).toFixed(2)}` : draft.dailyBudget}
            />
            <ReviewRow label="Mode" value="Strict" />
          </dl>
        </div>
      ) : null}

      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      <div className="flex gap-2">
        {stepIndex > 0 ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setErrors({});
              setStepIndex((index) => Math.max(index - 1, 0));
              requestFocus(null);
            }}
          >
            Back
          </Button>
        ) : null}
        {isReview ? (
          <Button key="create" type="submit" disabled={isPending}>
            {isPending ? "Creating…" : "Create agent"}
          </Button>
        ) : (
          // A submit button, so Enter in a field moves on too; onSubmit turns it into "next".
          <Button key="next" type="submit">
            Next
          </Button>
        )}
      </div>
    </form>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="[overflow-wrap:anywhere] whitespace-pre-wrap">{value}</dd>
    </div>
  );
}
