import { randomUUID } from "node:crypto";

import {
  computeCredentialExpiry,
  intersectCapabilities,
  type CredentialRejectionReason,
} from "@ago/shared";

import {
  hashCredentialToken,
  signCredentialToken,
  verifyCredentialToken,
} from "./credential-token.js";

import type { CredentialStore } from "./credential-store.js";

/** Issuance refused: the agent is archived, or is not in the run's workspace. Carries no ids. */
export class AgentNotActiveError extends Error {
  constructor() {
    super("the agent is not active in this workspace: no credential is issued");
    this.name = "AgentNotActiveError";
  }
}

/** The slice of the logger the issuer needs. Never given a token. */
interface IssuanceLogger {
  info(fields: Record<string, unknown>, message: string): void;
}

export interface IssueCredentialRequest {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly runId: string;
  /** When the task ends. The credential never outlives it, nor 15 minutes. */
  readonly taskEndsAt?: Date | null;
  /** Capabilities the caller wants on the credential. Anything the agent lacks is dropped. */
  readonly requestedCapabilities?: readonly string[] | null;
}

export interface IssuedCredential {
  /** Handed to the tool loop once and never stored or logged. */
  readonly token: string;
  readonly credentialId: string;
  readonly capabilities: readonly string[];
  /** Requested capabilities the agent lacks (not on the credential). */
  readonly droppedCapabilities: readonly string[];
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

/** The seam AGO-167's tool loop uses to get a credential for a run. */
export interface CredentialIssuer {
  issue(request: IssueCredentialRequest): Promise<IssuedCredential>;
  /** Revoke every live credential of a run: call when the run ends. */
  revokeForRun(ref: { workspaceId: string; runId: string }): Promise<number>;
}

export interface CredentialIssuerDeps {
  readonly store: CredentialStore;
  readonly secret: string;
  readonly now?: () => Date;
  readonly logger?: IssuanceLogger;
}

/**
 * Issues per-run credentials (AC1, AC2, AC3):
 * - expiry is the sooner of the task end and now + 15 minutes;
 * - the capability set is the agent's granted capabilities (catalog-enabled) intersected with the request;
 * - every issuance is one append-only row in `agent_credentials` (token hash, never the token) and one log line.
 * The database re-checks all of it on insert.
 */
export function createCredentialIssuer(deps: CredentialIssuerDeps): CredentialIssuer {
  const now = deps.now ?? (() => new Date());

  return {
    async issue(request) {
      const issuedAt = new Date(Math.floor(now().getTime() / 1000) * 1000);
      const expiresAt = computeCredentialExpiry({ now: issuedAt, taskEndsAt: request.taskEndsAt });
      if (!(await deps.store.isAgentActive(request))) throw new AgentNotActiveError();
      const granted = await deps.store.grantedCapabilities(request);
      const capabilities = intersectCapabilities(granted, request.requestedCapabilities);
      const droppedCapabilities = (request.requestedCapabilities ?? []).filter(
        (key) => !granted.includes(key),
      );
      const credentialId = randomUUID();

      const token = signCredentialToken(
        {
          jti: credentialId,
          agent_id: request.agentId,
          workspace_id: request.workspaceId,
          run_id: request.runId,
          caps: capabilities,
          iat: Math.floor(issuedAt.getTime() / 1000),
          exp: Math.floor(expiresAt.getTime() / 1000),
        },
        deps.secret,
      );
      await deps.store.insert({
        id: credentialId,
        workspaceId: request.workspaceId,
        agentId: request.agentId,
        runId: request.runId,
        tokenHash: hashCredentialToken(token),
        capabilities,
        issuedAt,
        expiresAt,
      });
      deps.logger?.info(
        {
          credential_id: credentialId,
          agent_id: request.agentId,
          run_id: request.runId,
          workspace_id: request.workspaceId,
          capability_count: capabilities.length,
          dropped_capability_count: droppedCapabilities.length,
          expires_at: expiresAt.toISOString(),
        },
        "agent credential issued",
      );
      return { token, credentialId, capabilities, droppedCapabilities, issuedAt, expiresAt };
    },

    revokeForRun(ref) {
      return deps.store.revokeForRun(ref);
    },
  };
}

export interface VerifyCredentialRequest {
  readonly workspaceId: string;
  readonly runId: string;
  /** The capability the tool call needs. */
  readonly capability: string;
  /** Optional: also require the credential to belong to this agent. */
  readonly agentId?: string;
}

/**
 * The answer to "may this credential be used for this call?". `policyCheckRequired` is always true: a credential
 * only proves the agent holds a capability. Every tool call still passes the policy engine (AGO-167) and a tier
 * 3 or 4 action still needs a human approval. Nothing here can approve or skip that.
 */
export type CredentialDecision =
  | {
      readonly ok: true;
      readonly credentialId: string;
      readonly agentId: string;
      readonly capabilities: readonly string[];
      readonly policyCheckRequired: true;
    }
  | { readonly ok: false; readonly reason: CredentialRejectionReason };

export interface CredentialVerifier {
  verify(token: string, request: VerifyCredentialRequest): Promise<CredentialDecision>;
}

export interface CredentialVerifierDeps {
  readonly store: CredentialStore;
  readonly secret: string;
  readonly now?: () => Date;
}

const reject = (reason: CredentialRejectionReason): CredentialDecision => ({ ok: false, reason });

/**
 * Rejects a credential that is malformed, badly signed, expired, revoked, unknown, or aimed at another
 * workspace, agent, run or capability. Both the signed claims and the stored row must agree, so a leaked
 * signing secret alone cannot mint a usable credential (no matching row) and a copied row alone cannot either.
 */
export function createCredentialVerifier(deps: CredentialVerifierDeps): CredentialVerifier {
  const now = deps.now ?? (() => new Date());

  return {
    async verify(token, request) {
      const checked = verifyCredentialToken(token, deps.secret);
      if (!checked.ok) return reject(checked.reason);
      const { claims } = checked;

      const nowMs = now().getTime();
      if (claims.exp * 1000 <= nowMs) return reject("expired");

      const stored = await deps.store.findByTokenHash(hashCredentialToken(token));
      if (stored?.id !== claims.jti) return reject("unknown_credential");
      if (stored.revokedAt !== null) return reject("revoked");
      // Current state beats the snapshot: an archived agent's credential is dead even if not yet revoked.
      if (stored.agentArchived) return reject("revoked");
      if (stored.expiresAt.getTime() <= nowMs) return reject("expired");

      if (
        stored.workspaceId !== request.workspaceId ||
        claims.workspace_id !== request.workspaceId
      ) {
        return reject("wrong_workspace");
      }
      if (
        request.agentId !== undefined &&
        (stored.agentId !== request.agentId || claims.agent_id !== request.agentId)
      ) {
        return reject("wrong_agent");
      }
      if (stored.runId !== request.runId || claims.run_id !== request.runId) {
        return reject("wrong_run");
      }
      // The snapshot (claims and stored row) is only an upper bound: the grant and the catalog entry must
      // still hold now. `liveCapabilities` is read in the same query as the row.
      if (
        !claims.caps.includes(request.capability) ||
        !stored.capabilities.includes(request.capability) ||
        !stored.liveCapabilities.includes(request.capability)
      ) {
        return reject("missing_capability");
      }
      return {
        ok: true,
        credentialId: stored.id,
        agentId: stored.agentId,
        capabilities: stored.liveCapabilities,
        policyCheckRequired: true,
      };
    },
  };
}
