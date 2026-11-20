import { cn } from "@ago/ui";
import type { AgentOfficeStateName } from "@ago/shared";

import { getAgentStateView, type AgentStateShape, type AgentStateTone } from "./agent-state-view";

const TONE_CLASS: Record<AgentStateTone, string> = {
  neutral: "border-border bg-muted text-muted-foreground",
  active: "border-primary bg-primary text-primary-foreground",
  info: "border-primary bg-card text-foreground",
  // The red badge: waiting on you (AGO-150).
  alert: "border-destructive bg-destructive text-destructive-foreground",
  caution: "border-warning bg-card text-foreground",
};

/** Decorative shapes (the label carries the meaning). Each state draws a different one. */
function StateShape({ shape }: { shape: AgentStateShape }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false,
  };
  switch (shape) {
    case "circle-dash":
      return (
        <svg {...common} data-shape={shape}>
          <circle cx="8" cy="8" r="5.5" strokeDasharray="2.5 2.5" />
        </svg>
      );
    case "gear":
      return (
        <svg {...common} data-shape={shape}>
          <circle cx="8" cy="8" r="2.25" />
          <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
        </svg>
      );
    case "bubble":
      return (
        <svg {...common} data-shape={shape}>
          <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
        </svg>
      );
    case "link":
      return (
        <svg {...common} data-shape={shape}>
          <circle cx="4.5" cy="8" r="2.5" />
          <circle cx="11.5" cy="8" r="2.5" />
          <path d="M7 8h2" />
        </svg>
      );
    case "bell":
      return (
        <svg {...common} data-shape={shape}>
          <path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3zM6.5 14.5h3" />
        </svg>
      );
    case "triangle":
      return (
        <svg {...common} data-shape={shape}>
          <path d="M8 2l6.5 11.5h-13zM8 6.5v3M8 11.6v.01" />
        </svg>
      );
  }
}

/**
 * The badge for one of the six states (AGO-150): a shape, a text label and a color. Never color alone
 * (WCAG 1.4.1). The visible text is the accessible name, so a screen reader hears the same label.
 */
export function AgentStateBadge({
  state,
  className,
}: {
  state: AgentOfficeStateName;
  className?: string;
}) {
  const view = getAgentStateView(state);
  return (
    <span
      data-testid="agent-state-badge"
      data-state={state}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm font-medium",
        TONE_CLASS[view.tone],
        className,
      )}
    >
      <StateShape shape={view.shape} />
      <span>{view.label}</span>
    </span>
  );
}
