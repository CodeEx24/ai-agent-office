import {
  describePrerequisiteFailures,
  evaluatePrerequisites,
  isGatedCapability,
  type PrerequisiteResult,
} from "@ago/shared";
import { z } from "zod";

import { WorkspaceAccessError } from "../workspaces/workspace-access";

/**
 * Turning a risky capability on (AGO-85). The logic lives here, behind small interfaces, so it can be unit
 * tested without a database, a worker or an endpoint (everything exported from a "use server" file becomes a
 * callable endpoint). `actions.ts` is the endpoint; `capability-enabler.ts` is the real writer.
 *
 * The rules: owners only; the prerequisites are checked HERE, at enable time, from the worker's own report and
 * never from anything the browser sent; a failed, missing, late or malformed report is a failed check; the
 * refusal names the checks that did not pass, never raw error text. The tool-call gate re-checks at run time.
 */

export const enableCapabilityInputSchema = z.strictObject({
  workspaceId: z.uuid(),
  capabilityId: z.uuid(),
});
export type EnableCapabilityInput = z.infer<typeof enableCapabilityInputSchema>;

/** The row about to change, read through RLS. `null` when it is not in this workspace. */
export interface CapabilityToEnable {
  readonly key: string;
  readonly isEnabled: boolean;
}

export interface CapabilityEnabler {
  /** Owners only (throws `WorkspaceAccessError` otherwise). */
  find(input: EnableCapabilityInput): Promise<CapabilityToEnable | null>;
  /** The one write: sets `enabled` for this workspace's row. Throws on any failure. */
  enable(input: EnableCapabilityInput): Promise<void>;
}

export interface EnableCapabilityDeps {
  readonly enabler: CapabilityEnabler;
  readonly report: () => Promise<readonly PrerequisiteResult[]>;
}

export interface EnableCapabilityState {
  error?: string;
  /** Labels of the prerequisites that did not pass, when that is why the enable was refused. */
  failedChecks?: string[];
  done?: boolean;
}

export const ENABLE_AGENT_CREDENTIAL_ERROR =
  "Agents cannot turn a capability on. This action is for people only.";
export const ENABLE_OWNER_ONLY_ERROR = "Only a workspace owner can turn a capability on.";
export const ENABLE_NOT_FOUND_ERROR = "That capability was not found.";
export const ENABLE_FAILED_ERROR = "The capability could not be turned on. Please try again.";
export const ENABLE_INVALID_ERROR = "Invalid request.";

/** Runs the check against a fresh report and returns the human-readable failures (empty when satisfied). */
export async function checkPrerequisitesNow(
  capabilityKey: string,
  report: EnableCapabilityDeps["report"],
): Promise<{ isSatisfied: boolean; failedChecks: string[]; message: string }> {
  let results: readonly PrerequisiteResult[];
  try {
    results = await report();
  } catch {
    results = [];
  }
  const evaluation = evaluatePrerequisites(capabilityKey, [...results]);
  return {
    isSatisfied: evaluation.isSatisfied,
    failedChecks: evaluation.failures.map((failure) => failure.label),
    message: describePrerequisiteFailures(evaluation.failures),
  };
}

/** Enables the capability when, and only when, every prerequisite passes right now. Never throws. */
export async function enableCapabilityWith(
  deps: EnableCapabilityDeps,
  input: EnableCapabilityInput,
): Promise<EnableCapabilityState> {
  try {
    const capability = await deps.enabler.find(input);
    if (!capability) return { error: ENABLE_NOT_FOUND_ERROR };
    if (capability.isEnabled) return { done: true };

    if (isGatedCapability(capability.key)) {
      const check = await checkPrerequisitesNow(capability.key, deps.report);
      if (!check.isSatisfied) {
        return { error: check.message, failedChecks: check.failedChecks };
      }
    }

    await deps.enabler.enable(input);
    return { done: true };
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return {
        error:
          error.code === "unauthenticated"
            ? "Your session has expired. Please sign in again."
            : ENABLE_OWNER_ONLY_ERROR,
      };
    }
    return { error: ENABLE_FAILED_ERROR };
  }
}
