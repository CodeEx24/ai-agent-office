import { z } from "zod";

import { CREDENTIAL_REJECTION_REASONS } from "../identity/credential-schemas.js";

/**
 * Credential broker shapes (AGO-157). Pure and client-safe: no `node:crypto`, no values. A tool never holds
 * a secret; it holds a reference like `secret:crm_api_key` and asks the worker-side broker to use it.
 */

export const SECRET_REF_PREFIX = "secret:";

/** `secret:` then a lowercase name. A raw key (`sk-...`, a JWT, ...) can never match, so it fails validation. */
export const SECRET_REF_PATTERN = /^secret:[a-z][a-z0-9_.-]{0,63}$/;

export const secretRefSchema = z.string().regex(SECRET_REF_PATTERN, {
  message: "must be a secret reference such as secret:crm_api_key, never a key value",
});
export type SecretRef = z.infer<typeof secretRefSchema>;

/** The name part of a valid reference, or null when the text is not a reference. */
export function secretNameOf(ref: string): string | null {
  return SECRET_REF_PATTERN.test(ref) ? ref.slice(SECRET_REF_PREFIX.length) : null;
}

/** `allowed`: the value was released to the tool's function. `denied`: it was not. `error`: the function failed. */
export const BROKER_OUTCOMES = ["allowed", "denied", "error"] as const;
export type BrokerOutcome = (typeof BROKER_OUTCOMES)[number];

/** Stable codes for a refused call: the credential reasons (AGO-148) plus the broker's own. */
export const BROKER_DENIAL_REASONS = [
  ...CREDENTIAL_REJECTION_REASONS,
  "invalid_reference",
  "no_credential",
  "secret_unavailable",
  "audit_unavailable",
] as const;
export type BrokerDenialReason = (typeof BROKER_DENIAL_REASONS)[number];

/** One broker call as it is audited. Names and ids only: never a value, a token or the tool's input. */
export interface BrokerAuditEntry {
  readonly at: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly toolName: string;
  readonly capability: string;
  /** The reference the tool used (a name), or null when the input was not a valid reference. */
  readonly secretRef: string | null;
  readonly outcome: BrokerOutcome;
  readonly reason: BrokerDenialReason | "tool_error" | null;
}
