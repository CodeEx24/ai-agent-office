import { randomUUID } from "node:crypto";

import { agentConfigChangeSchema } from "@ago/shared";

import type { ProposalStore } from "./proposal-store.js";
import type { ConfigGuardResult } from "@ago/shared";

/**
 * The gate for any agent-side write to protected configuration (AGO-154): an agent's prompt, skills,
 * policies and boot files. It has no way to apply a change. Whatever an agent submits becomes a pending
 * proposal for a person to review, or is denied; the caller must not touch the target in either case.
 *
 * - Input is validated at the boundary; anything malformed is denied.
 * - If the proposal cannot be stored the change is denied (fail closed), never applied.
 * - It never throws and never returns or logs the proposed content, only the proposal id or a reason code.
 */
export interface ConfigGuardDeps {
  readonly store: ProposalStore;
  readonly newId?: () => string;
  readonly now?: () => Date;
}

export async function guardConfigChange(
  input: unknown,
  deps: ConfigGuardDeps,
): Promise<ConfigGuardResult> {
  const parsed = agentConfigChangeSchema.safeParse(input);
  if (!parsed.success) return { outcome: "denied", reason: "invalid_change" };

  const id = (deps.newId ?? randomUUID)();
  try {
    await deps.store.create({
      id,
      ...parsed.data,
      status: "pending",
      createdAt: (deps.now ?? (() => new Date()))().toISOString(),
    });
  } catch {
    return { outcome: "denied", reason: "proposal_store_failed" };
  }
  return { outcome: "proposed", proposalId: id };
}
