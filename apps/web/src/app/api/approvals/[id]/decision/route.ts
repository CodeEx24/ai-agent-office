import { approvalIdParamSchema, decideApprovalBodySchema } from "@ago/shared";
import type { NextRequest } from "next/server";
import { z } from "zod";

import {
  ApprovalDecisionError,
  decideApproval,
} from "../../../../../features/approvals/decide-approval";
import { recordAgentRouteRejection } from "../../../../../features/approvals/record-agent-rejection";
import { WorkspaceAccessError } from "../../../../../features/workspaces/workspace-access";
import { rejectAgentCredential } from "../../../../../lib/auth/human-only";
import { invalidInputResponse, parseInput } from "../../../../../lib/validation/parse-input";

// Never cache: the answer depends on the caller's session.
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

/**
 * POST /api/approvals/[id]/decision: a person approves or denies a pending approval (AGO-58).
 * Body `{ workspace_id, decision: "approved" | "denied" }`; nothing else is accepted (no payload hash).
 *
 * Human only, in this order: (1) an agent credential is refused with 403 and an event BEFORE anything else, even if
 * the request also carries a session cookie; (2) input is validated (400); (3) the caller must be signed in (401)
 * and a member of the workspace (403); (4) the update is scoped by workspace and `pending` (404 when nothing could
 * be decided: missing, other workspace, already decided, expired, used).
 * The proxy already refuses agent credentials on this path; this check is the second layer, and records the event
 * if the proxy was ever bypassed.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const agentDenied = rejectAgentCredential(request);
  if (agentDenied) {
    await recordAgentRouteRejection({
      headers: request.headers,
      pathname: request.nextUrl.pathname,
      method: request.method,
    });
    return agentDenied;
  }

  const params = parseInput(z.object({ id: approvalIdParamSchema }), await context.params);
  if (!params.success) return invalidInputResponse(params.message);

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return invalidInputResponse("Request body must be JSON.");
  }
  const body = parseInput(decideApprovalBodySchema, rawBody);
  if (!body.success) return invalidInputResponse(body.message);

  try {
    const result = await decideApproval({
      approvalId: params.data.id,
      workspaceId: body.data.workspace_id,
      decision: body.data.decision,
    });
    if (result.outcome === "not_decidable") return jsonError("not_found", 404);
    return Response.json({ id: result.id, status: result.status }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return jsonError(error.code, error.code === "unauthenticated" ? 401 : 403);
    }
    if (error instanceof ApprovalDecisionError) return jsonError("decision_unavailable", 500);
    throw error;
  }
}
