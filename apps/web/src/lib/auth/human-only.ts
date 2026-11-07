import { hasAgentCredential } from "@ago/shared";
import { headers } from "next/headers";

/**
 * Human-only guard (AGO-148, CLAUDE.md invariant "agent tokens rejected on human-only routes").
 *
 * An agent credential (`Authorization: Bearer ago_agt_...`) proves an agent holds a capability inside a run; it
 * is never a human session. Every route and server action in the web app acts for a signed-in person (approvals,
 * policies, capabilities, budgets, identities, agent creation), so a request that carries an agent credential is
 * refused before anything else runs, even if it also carries a valid session cookie: an agent must not be able to
 * borrow a human's session by attaching its own token to a forwarded request.
 *
 * Defense in depth, three layers: the proxy rejects it for every route (the allow-list below is empty today),
 * route handlers call `rejectAgentCredential`, and server actions call `requireHumanRequest`.
 */

const REJECTION_BODY = { error: "agent_credential_not_allowed" } as const;

/** Paths an agent credential may call. Empty on purpose: add a path here only with a ticket that says why. */
export const AGENT_ALLOWED_PATH_PREFIXES: readonly string[] = [];

export class AgentCredentialRejectedError extends Error {
  readonly code = "agent_credential_not_allowed";
  constructor() {
    super("this action is for people only: an agent credential cannot call it");
    this.name = "AgentCredentialRejectedError";
  }
}

/** Throws when the request carries an agent credential. */
export function assertHumanRequest(requestHeaders: { get(name: string): string | null }): void {
  if (hasAgentCredential(requestHeaders)) throw new AgentCredentialRejectedError();
}

/** For server actions: reads the current request's headers. Throws `AgentCredentialRejectedError`. */
export async function requireHumanRequest(): Promise<void> {
  assertHumanRequest(await headers());
}

/**
 * For route handlers and the proxy: a 403 response when the request carries an agent credential on a path that
 * is not on the agent allow-list; undefined when the request may proceed. Never echoes the credential.
 */
export function rejectAgentCredential(request: {
  headers: { get(name: string): string | null };
  nextUrl?: { pathname: string };
}): Response | undefined {
  if (!hasAgentCredential(request.headers)) return undefined;
  const path = request.nextUrl?.pathname;
  if (path !== undefined && AGENT_ALLOWED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return undefined;
  }
  return Response.json(REJECTION_BODY, {
    status: 403,
    headers: { "Cache-Control": "private, no-store" },
  });
}
