import type { NextRequest } from "next/server";

import { handleKillSwitchRequest } from "../../../../features/control/handle-kill-switch-request";

/**
 * POST /api/control/kill: an owner pulls the kill switch for a workspace or one agent (AGO-84). Human only.
 * @no-input the body is validated with Zod (`parseInput`) in `handleKillSwitchRequest`; this route only delegates.
 */
export function POST(request: NextRequest): Promise<Response> {
  return handleKillSwitchRequest(request, "activate");
}
