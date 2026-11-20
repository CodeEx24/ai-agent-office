import { z } from "zod";

/**
 * Prerequisites for risky capabilities (AGO-85). A risky capability stays off until every prerequisite it needs
 * passes. The rules are fail closed: only an explicit `pass` counts. A check that fails, throws, times out or
 * never ran is a failure, and so is a prerequisite nobody reported (timeout means deny).
 */

export const PREREQUISITE_NAMES = [
  "sandbox_hardened",
  "egress_default_deny",
  "credential_broker",
  "approval_payload_hash",
] as const;
export const prerequisiteNameSchema = z.enum(PREREQUISITE_NAMES);
export type PrerequisiteName = z.infer<typeof prerequisiteNameSchema>;

/** Plain words for the owner. Fixed text: nothing from a probe's error ever reaches a screen or a model. */
export const PREREQUISITE_LABELS: Readonly<Record<PrerequisiteName, string>> = {
  sandbox_hardened: "Sandbox present and hardened",
  egress_default_deny: "Egress proxy wired with default deny",
  credential_broker: "Credential broker in place",
  approval_payload_hash: "Approvals bound to the payload hash",
};

export const PREREQUISITE_STATUSES = ["pass", "fail", "error", "timeout", "not_run"] as const;
export const prerequisiteStatusSchema = z.enum(PREREQUISITE_STATUSES);
export type PrerequisiteStatus = z.infer<typeof prerequisiteStatusSchema>;

/** One check's outcome. `reason` is a short fixed code (for example `network_not_none`), never raw error text. */
export const prerequisiteResultSchema = z.strictObject({
  name: prerequisiteNameSchema,
  status: prerequisiteStatusSchema,
  reason: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .optional(),
});
export type PrerequisiteResult = z.infer<typeof prerequisiteResultSchema>;

/**
 * Which prerequisites each gated capability needs. Every gated capability needs approvals bound to the payload
 * hash (tier 3 and 4 never run without a human decision) and the broker (they act with credentials). Code and
 * browsing need the sandbox; browsing and outbound messages need the egress proxy.
 */
export const GATED_CAPABILITY_PREREQUISITES: Readonly<Record<string, readonly PrerequisiteName[]>> =
  {
    "code.run": ["sandbox_hardened", "credential_broker", "approval_payload_hash"],
    "web.browse": [
      "sandbox_hardened",
      "egress_default_deny",
      "credential_broker",
      "approval_payload_hash",
    ],
    "message.send_outbound": ["egress_default_deny", "credential_broker", "approval_payload_hash"],
  };

/** True for a capability that must pass prerequisites before it can be on. */
export function isGatedCapability(capabilityKey: string): boolean {
  return Object.hasOwn(GATED_CAPABILITY_PREREQUISITES, capabilityKey);
}

/** The prerequisites a capability needs. Empty for a capability that is not gated. */
export function prerequisitesFor(capabilityKey: string): readonly PrerequisiteName[] {
  return isGatedCapability(capabilityKey)
    ? (GATED_CAPABILITY_PREREQUISITES[capabilityKey] ?? [])
    : [];
}

export interface PrerequisiteFailure {
  readonly name: PrerequisiteName;
  readonly label: string;
  readonly status: Exclude<PrerequisiteStatus, "pass">;
  readonly reason?: string;
}

export type PrerequisiteVerdict =
  | { readonly isSatisfied: true; readonly failures: readonly [] }
  | { readonly isSatisfied: false; readonly failures: readonly PrerequisiteFailure[] };

/**
 * Pure fail-closed evaluation. Results that do not parse, a missing name or a duplicate name that disagrees
 * all count as failures. Only an explicit `pass` satisfies a prerequisite.
 */
export function evaluatePrerequisites(
  capabilityKey: string,
  results: readonly unknown[],
): PrerequisiteVerdict {
  const needed = prerequisitesFor(capabilityKey);
  const byName = new Map<PrerequisiteName, PrerequisiteResult[]>();
  for (const raw of results) {
    const parsed = prerequisiteResultSchema.safeParse(raw);
    if (!parsed.success) continue;
    byName.set(parsed.data.name, [...(byName.get(parsed.data.name) ?? []), parsed.data]);
  }
  const failures: PrerequisiteFailure[] = [];
  for (const name of needed) {
    const reported = byName.get(name) ?? [];
    const firstBad = reported.find((r) => r.status !== "pass");
    const isPassing = reported.length > 0 && firstBad === undefined;
    if (isPassing) continue;
    const status = firstBad?.status ?? "not_run";
    failures.push({
      name,
      label: PREREQUISITE_LABELS[name],
      status: status === "pass" ? "not_run" : status,
      ...(firstBad?.reason === undefined ? {} : { reason: firstBad.reason }),
    });
  }
  return failures.length === 0
    ? { isSatisfied: true, failures: [] }
    : { isSatisfied: false, failures };
}

/** Fixed, owner-readable sentence naming each failing check. Never includes probe error text. */
export function describePrerequisiteFailures(failures: readonly PrerequisiteFailure[]): string {
  if (failures.length === 0) return "All prerequisites pass.";
  return `Blocked until these checks pass: ${failures.map((f) => f.label).join("; ")}.`;
}
