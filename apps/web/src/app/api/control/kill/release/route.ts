import type { NextRequest } from "next/server";

import { handleKillSwitchRequest } from "../../../../../features/control/handle-kill-switch-request";

/**
 * POST /api/control/kill/release: an owner releases the kill switch (AGO-84). Human only. Stopped runs stay stopped.
 * @no-input the body is validated with Zod (`parseInput`) in `handleKillSwitchRequest`; this route only delegates.
 */
export function POST(request: NextRequest): Promise<Response> {
  return handleKillSwitchRequest(request, "release");
}
