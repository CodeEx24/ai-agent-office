import { z } from "zod";

import { capabilityKeySchema } from "../capabilities/capability-schemas.js";

/**
 * Per-agent credentials (AGO-148). Pure helpers and schemas only: no `node:crypto`, so this module is safe to
 * import from the web app too. Signing, hashing and storage live in `apps/worker/src/identity`.
 *
 * Rules (CLAUDE.md invariants):
 * - a credential lives until the task ends or 15 minutes pass, whichever is sooner (`computeCredentialExpiry`);
 * - it carries only capabilities the agent was granted AND the caller asked for (`intersectCapabilities`);
 * - it never raises a capability's tier: tier 3+ still needs a human approval and every tool call still passes
 *   the policy engine;
 * - an agent credential is rejected on human-only routes (`hasAgentCredential`).
 */

/** Hard ceiling for a credential's lifetime. Mirrored by the `agent_credentials_max_ttl_check` constraint. */
export const CREDENTIAL_MAX_TTL_SECONDS = 15 * 60;

/** Every agent credential starts with this prefix, so a guard can recognise one without any crypto. */
export const AGENT_CREDENTIAL_PREFIX = "ago_agt_";

const BEARER = /^\s*Bearer\s+(\S+)/i;

/** The signed claims of an agent credential. `.strict()`: an unknown claim is rejected, not ignored. */
export const agentCredentialClaimsSchema = z
  .object({
    /** Credential id: the primary key of the issuance row. */
    jti: z.uuid(),
    agent_id: z.uuid(),
    workspace_id: z.uuid(),
    run_id: z.uuid(),
    /** Capability keys this credential may be used for (granted ∩ requested). */
    caps: z.array(capabilityKeySchema).max(64),
    /** Issued-at and expiry, in whole seconds since the epoch. */
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
  })
  .strict()
  .refine((claims) => claims.exp > claims.iat, { message: "exp must be after iat" })
  .refine((claims) => claims.exp - claims.iat <= CREDENTIAL_MAX_TTL_SECONDS, {
    message: "lifetime exceeds the 15 minute ceiling",
  });
export type AgentCredentialClaims = z.infer<typeof agentCredentialClaimsSchema>;

/** Why a credential was refused. Stable codes: they go into logs and tests, never the token itself. */
export const CREDENTIAL_REJECTION_REASONS = [
  "malformed",
  "bad_signature",
  "expired",
  "revoked",
  "unknown_credential",
  "wrong_workspace",
  "wrong_agent",
  "wrong_run",
  "missing_capability",
] as const;
export type CredentialRejectionReason = (typeof CREDENTIAL_REJECTION_REASONS)[number];

export class TaskAlreadyEndedError extends Error {
  constructor() {
    super("the task has already ended: no credential is issued");
    this.name = "TaskAlreadyEndedError";
  }
}

/**
 * AC1: expiry is the sooner of the task's end and `now + 15 minutes`. A task end that is not in the future
 * means there is nothing to issue for, so it throws instead of returning an already-expired credential.
 * Whole seconds, rounded down: a credential never lives longer than asked.
 */
export function computeCredentialExpiry(input: {
  readonly now: Date;
  readonly taskEndsAt?: Date | null;
}): Date {
  const nowMs = input.now.getTime();
  const ceilingMs = nowMs + CREDENTIAL_MAX_TTL_SECONDS * 1000;
  const endMs = input.taskEndsAt?.getTime();
  const expiryMs = endMs === undefined ? ceilingMs : Math.min(endMs, ceilingMs);
  const expirySeconds = Math.floor(expiryMs / 1000);
  if (expirySeconds <= Math.floor(nowMs / 1000)) throw new TaskAlreadyEndedError();
  return new Date(expirySeconds * 1000);
}

/**
 * AC2: the capabilities a credential may carry. With no request, every granted capability; with one, only the
 * granted ones in it. A requested capability the agent lacks is dropped (and reported by the caller), never added.
 * Sorted and de-duplicated so the same inputs always give the same set.
 */
export function intersectCapabilities(
  granted: readonly string[],
  requested?: readonly string[] | null,
): string[] {
  const grantedSet = new Set(granted);
  const wanted = requested === undefined || requested === null ? grantedSet : new Set(requested);
  return [...wanted].filter((key) => grantedSet.has(key)).sort();
}

/** True when the value is shaped like an agent credential (prefix only: no verification). */
export function isAgentCredentialToken(value: string): boolean {
  return value.startsWith(AGENT_CREDENTIAL_PREFIX);
}

/** The bearer token of an `Authorization` header value, or undefined. */
export function bearerTokenOf(authorization: string | null | undefined): string | undefined {
  return authorization === null || authorization === undefined
    ? undefined
    : BEARER.exec(authorization)?.[1];
}

/**
 * True when a request carries an agent credential in its `Authorization: Bearer` header. Human-only routes
 * reject such a request before doing anything else, whatever else it carries (a session cookie included).
 */
export function hasAgentCredential(headers: { get(name: string): string | null }): boolean {
  const token = bearerTokenOf(headers.get("authorization"));
  return token !== undefined && isAgentCredentialToken(token);
}
