import { SECRET_REF_PREFIX, secretNameOf } from "@ago/shared";

import { createSecretScrubber } from "./secret-scrubber.js";

import type { CredentialVerifier } from "../identity/index.js";
import type { SecretStore } from "./secret-store.js";
import type { BrokerAuditEntry, BrokerDenialReason } from "@ago/shared";

/**
 * The credential broker (AGO-157). Secrets stay on the server: a tool names a secret by reference and the broker
 * runs the tool's function with the value. There is no method here that returns a value to the caller. The
 * function's text result and any error it throws are scrubbed of the value before they leave.
 *
 * What the broker is not: it never approves anything. The policy engine still decides every tool call (and a
 * human every tier 3 or 4 action) before the tool, and so before the broker, runs.
 */

/** Where audit entries go besides the log. A sink that throws makes the call fail closed (nothing released). */
export interface BrokerAuditSink {
  record(entry: BrokerAuditEntry): void | Promise<void>;
}

/** The slice of the logger the broker needs. Never given a value, a token or a tool input. */
interface BrokerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface BrokerCallRequest {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly toolName: string;
  /** The capability the tool needs (its catalog key). */
  readonly capability: string;
  /** What the tool was given: must be `secret:<name>`. */
  readonly secretRef: string;
  /** The run's agent credential (AGO-148). Held by the worker; never shown to the model. */
  readonly credentialToken: string | undefined;
}

/** The broker refused: no value was released. The message is fixed text plus a stable code. */
export class BrokerDeniedError extends Error {
  readonly reason: BrokerDenialReason;
  constructor(reason: BrokerDenialReason) {
    super(`credential broker refused the call (${reason}); no secret was used`);
    this.name = "BrokerDeniedError";
    this.reason = reason;
  }
}

/** The tool's function failed. The message is scrubbed; the original error is not kept. */
export class BrokerToolError extends Error {
  constructor(scrubbedMessage: string) {
    super(scrubbedMessage);
    this.name = "BrokerToolError";
  }
}

export interface CredentialBroker {
  /**
   * Run `action` with the secret the reference names. Resolves to the function's text, scrubbed. Throws
   * `BrokerDeniedError` (nothing released) or `BrokerToolError` (released, then the function failed).
   */
  withSecret(
    request: BrokerCallRequest,
    action: (secret: string) => Promise<string>,
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface CredentialBrokerDeps {
  readonly verifier: CredentialVerifier;
  readonly secrets: SecretStore;
  readonly sink?: BrokerAuditSink;
  readonly logger?: BrokerLogger;
  readonly now?: () => Date;
}

export function createCredentialBroker(deps: CredentialBrokerDeps): CredentialBroker {
  const now = deps.now ?? (() => new Date());

  /** Log and sink. Throws only when the sink does; callers decide whether that matters. */
  async function audit(
    request: BrokerCallRequest,
    outcome: BrokerAuditEntry["outcome"],
    reason: BrokerAuditEntry["reason"],
  ): Promise<void> {
    const entry: BrokerAuditEntry = {
      at: now().toISOString(),
      workspaceId: request.workspaceId,
      runId: request.runId,
      agentId: request.agentId,
      toolName: request.toolName,
      capability: request.capability,
      // Only ever a valid reference (a name) or null: a malformed input could be a pasted key.
      secretRef: secretNameOf(request.secretRef) === null ? null : request.secretRef,
      outcome,
      reason,
    };
    deps.logger?.info(
      {
        workspace_id: entry.workspaceId,
        run_id: entry.runId,
        agent_id: entry.agentId,
        tool_name: entry.toolName,
        capability: entry.capability,
        // The name only, under a neutral key: the logger masks `secret:<x>` and secret-looking keys, and a
        // name is not sensitive. The sink gets the full reference.
        broker_ref:
          entry.secretRef === null ? null : entry.secretRef.slice(SECRET_REF_PREFIX.length),
        outcome,
        reason,
      },
      "credential broker call",
    );
    await deps.sink?.record(entry);
  }

  /** A denial is audited best effort: the refusal stands even when the sink is down. */
  async function deny(
    request: BrokerCallRequest,
    reason: BrokerDenialReason,
  ): Promise<BrokerDeniedError> {
    try {
      await audit(request, "denied", reason);
    } catch {
      deps.logger?.error({ reason }, "credential broker could not audit a denial");
    }
    return new BrokerDeniedError(reason);
  }

  return {
    async withSecret(request, action, signal) {
      const name = secretNameOf(request.secretRef);
      if (name === null) throw await deny(request, "invalid_reference");
      if (request.credentialToken === undefined || request.credentialToken === "") {
        throw await deny(request, "no_credential");
      }

      const decision = await deps.verifier.verify(request.credentialToken, {
        workspaceId: request.workspaceId,
        runId: request.runId,
        agentId: request.agentId,
        capability: request.capability,
      });
      if (!decision.ok) throw await deny(request, decision.reason);

      let secret: string | null;
      try {
        secret = await deps.secrets.resolve({
          workspaceId: request.workspaceId,
          name,
          capability: request.capability,
        });
      } catch {
        // The store's error may carry connection details: report the code only.
        secret = null;
      }
      if (secret === null) throw await deny(request, "secret_unavailable");

      // Audit before release: a call that cannot be recorded does not happen.
      try {
        await audit(request, "allowed", null);
      } catch {
        throw await deny(request, "audit_unavailable");
      }

      const scrub = createSecretScrubber(secret);
      let text: string;
      try {
        signal?.throwIfAborted();
        const result: unknown = await action(secret);
        if (typeof result !== "string") throw new TypeError("the tool function must return text");
        text = scrub(result);
      } catch (error) {
        try {
          await audit(request, "error", "tool_error");
        } catch {
          deps.logger?.error({}, "credential broker could not audit a tool failure");
        }
        throw new BrokerToolError(scrub(error instanceof Error ? error.message : "tool failed"));
      }
      return text;
    },
  };
}
