"use server";

import { revalidatePath } from "next/cache";

import { AgentCredentialRejectedError, requireHumanRequest } from "../../lib/auth/human-only";
import { formDataToRecord, parseInput } from "../../lib/validation/parse-input";
import { capabilityEnabler } from "./capability-enabler";
import {
  ENABLE_AGENT_CREDENTIAL_ERROR,
  ENABLE_INVALID_ERROR,
  enableCapabilityInputSchema,
  enableCapabilityWith,
  type EnableCapabilityState,
} from "./enable-capability";
import { fetchPrerequisiteReport } from "./prerequisite-report";

/**
 * Turns a capability on (AGO-85). People only: an agent credential is refused before anything is read. Owners
 * only: the enabler requires the owner role and row-level security says the same. For `code.run`, `web.browse`
 * and `message.send_outbound` the four prerequisites are checked here, now, from the worker's own report; the
 * form carries two ids and nothing else, so there is no client flag to trust. The logic lives in
 * `enable-capability.ts` so it can be unit tested without an endpoint.
 */
export async function enableCapabilityAction(
  _prev: EnableCapabilityState,
  formData: FormData,
): Promise<EnableCapabilityState> {
  try {
    await requireHumanRequest();
  } catch (error) {
    if (error instanceof AgentCredentialRejectedError) {
      return { error: ENABLE_AGENT_CREDENTIAL_ERROR };
    }
    throw error;
  }

  const parsed = parseInput(
    enableCapabilityInputSchema,
    formDataToRecord(formData),
    ENABLE_INVALID_ERROR,
  );
  if (!parsed.success) return { error: ENABLE_INVALID_ERROR };

  const result = await enableCapabilityWith(
    { enabler: capabilityEnabler, report: () => fetchPrerequisiteReport() },
    parsed.data,
  );
  if (result.done) revalidatePath("/app/capabilities");
  return result;
}
