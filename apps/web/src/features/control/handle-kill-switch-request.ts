import { killSwitchBodySchema } from "@ago/shared";
import type { NextRequest } from "next/server";

import { rejectAgentCredential } from "../../lib/auth/human-only";
import { invalidInputResponse, parseInput } from "../../lib/validation/parse-input";
import { recordAgentRouteRejection } from "../approvals/record-agent-rejection";
import { WorkspaceAccessError } from "../workspaces/workspace-access";
import { activateKillSwitch, KillSwitchError, releaseKillSwitch } from "./request-kill-switch";

// Never cache: the answer depends on the caller's session.
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

/**
 * The shared body of `POST /api/control/kill` and `POST /api/control/kill/release` (AGO-84). Human only, in this
 * order: (1) an agent credential is refused with 403 and an audit event BEFORE anything else (the AGO-58 guard,
 * reused, not copied); (2) input is validated (400); (3) the caller must be signed in (401) and an owner of the
 * workspace (403); (4) the change is recorded (200 with the counts).
 * The proxy already refuses agent credentials on these paths; this check is the second layer.
 */
export async function handleKillSwitchRequest(
  request: NextRequest,
  action: "activate" | "release",
): Promise<Response> {
  const agentDenied = rejectAgentCredential(request);
  if (agentDenied) {
    await recordAgentRouteRejection({
      headers: request.headers,
      pathname: request.nextUrl.pathname,
      method: request.method,
    });
    return agentDenied;
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return invalidInputResponse("Request body must be JSON.");
  }
  const body = parseInput(killSwitchBodySchema, rawBody);
  if (!body.success) return invalidInputResponse(body.message);

  try {
    const result =
      action === "activate"
        ? await activateKillSwitch(body.data)
        : await releaseKillSwitch(body.data);
    return Response.json(
      {
        scope: body.data.scope,
        status: action === "activate" ? "active" : "released",
        runs_stopped: result.runs_stopped,
        credentials_revoked: result.credentials_revoked,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return jsonError(error.code, error.code === "unauthenticated" ? 401 : 403);
    }
    if (error instanceof KillSwitchError) return jsonError("kill_switch_unavailable", 500);
    throw error;
  }
}
