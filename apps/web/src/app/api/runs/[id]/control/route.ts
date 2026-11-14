import { runControlBodySchema, runIdParamSchema } from "@ago/shared";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { recordAgentRouteRejection } from "../../../../../features/approvals/record-agent-rejection";
import {
  RunControlError,
  requestRunControl,
} from "../../../../../features/runs/request-run-control";
import { WorkspaceAccessError } from "../../../../../features/workspaces/workspace-access";
import { rejectAgentCredential } from "../../../../../lib/auth/human-only";
import { invalidInputResponse, parseInput } from "../../../../../lib/validation/parse-input";

// Never cache: the answer depends on the caller's session.
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

/**
 * POST /api/runs/[id]/control: a person pauses, resumes or stops a run (AGO-86).
 * Body `{ workspace_id, action: "pause" | "resume" | "stop" }`; nothing else is accepted.
 *
 * Human only, in this order: (1) an agent credential is refused with 403 and an event BEFORE anything else (the
 * AGO-58 guard, reused); (2) input is validated (400); (3) the caller must be signed in (401) and a member of the
 * workspace (403); (4) the request is recorded for the worker (200), or 404 when it cannot apply: no such run in
 * this workspace, the run is in a state that action cannot reach, or it was already stopped.
 * The proxy already refuses agent credentials on this path; this check is the second layer.
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

  const params = parseInput(z.object({ id: runIdParamSchema }), await context.params);
  if (!params.success) return invalidInputResponse(params.message);

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return invalidInputResponse("Request body must be JSON.");
  }
  const body = parseInput(runControlBodySchema, rawBody);
  if (!body.success) return invalidInputResponse(body.message);

  try {
    const result = await requestRunControl({
      runId: params.data.id,
      workspaceId: body.data.workspace_id,
      action: body.data.action,
    });
    if (result === "not_applicable") return jsonError("not_found", 404);
    return Response.json(
      { id: params.data.id, action: body.data.action, status: "accepted" },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return jsonError(error.code, error.code === "unauthenticated" ? 401 : 403);
    }
    if (error instanceof RunControlError) return jsonError("control_unavailable", 500);
    throw error;
  }
}
