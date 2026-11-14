import { createClient } from "@supabase/supabase-js";
import {
  bearerTokenOf,
  resolveAgentCredentialSigningSecret,
  runEventSchema,
  type Database,
} from "@ago/shared";
import { verifyCredentialToken } from "@ago/shared/credential-token";

import { getSupabasePublicEnv } from "../../lib/env";

/**
 * AGO-58 AC1: an agent credential calling an approval route gets a 403 AND an event.
 *
 * Order matters and is the whole safety argument:
 *  1. the token's signature is verified HERE, in the web layer, before the database is touched, so only a
 *     credential this system really signed can produce an event (a forged or malformed one is just a 403 and a
 *     log line: it names no real run, so there is nothing to attach an event to);
 *  2. the event has a fixed shape (agent, route, method). The token, headers, body and query never leave this file;
 *  3. the write goes through one narrow database function (`record_agent_approval_rejection`), not a table write:
 *     `run_events` is runtime-only and the web app holds no service role.
 *
 * It never throws and never changes the 403: a failure to record is reported to the caller and logged by code.
 */

/** Approval routes: everything under this prefix decides or reads approvals and is for people only. */
export const APPROVAL_ROUTE_PREFIX = "/api/approvals";

/** The code of the `error.raised` event the database function appends (fixed; the dashboard filters on it). */
export const REJECTION_EVENT_CODE = "approval_route_rejected";
const MAX_ROUTE_LENGTH = 400;
const REJECTION_METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export function isApprovalRoute(pathname: string): boolean {
  return pathname === APPROVAL_ROUTE_PREFIX || pathname.startsWith(`${APPROVAL_ROUTE_PREFIX}/`);
}

/** The one database call this module makes. Narrow on purpose so a test can fake it. */
export interface RejectionRecorderClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: { code?: string } | null }>;
}

export type RejectionOutcome =
  | "recorded"
  /** No usable signature (forged, malformed, no secret): a 403 with a log line, no event. */
  | "unverified"
  /** The credential was genuine but the event could not be written. */
  | "failed";

export interface RecordRejectionInput {
  readonly headers: { get(name: string): string | null };
  readonly pathname: string;
  readonly method: string;
  /** Test seams. Defaults: the configured signing secret and an anonymous Supabase client. */
  readonly secret?: string;
  readonly client?: RejectionRecorderClient;
  readonly log?: (message: string, fields: Record<string, string>) => void;
}

function configuredSecret(): string | undefined {
  try {
    const configured = process.env.AGENT_CREDENTIAL_SIGNING_SECRET;
    return resolveAgentCredentialSigningSecret({
      APP_ENV: process.env.APP_ENV === "local" ? "local" : "production",
      // An empty value counts as unset.
      AGENT_CREDENTIAL_SIGNING_SECRET:
        configured === undefined || configured === "" ? undefined : configured,
    });
  } catch {
    return undefined;
  }
}

/**
 * The function is executable by `service_role` only, so this server-only client uses `SUPABASE_SERVICE_ROLE_KEY`.
 * It is used for this one call and nowhere else in apps/web. Without the key there is no client: the caller logs
 * "failed" and the 403 is unchanged.
 */
function serviceClient(): RejectionRecorderClient | undefined {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (serviceKey === undefined || serviceKey === "") return undefined;
  const { url } = getSupabasePublicEnv();
  return createClient<Database>(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const defaultLog = (message: string, fields: Record<string, string>): void => {
  console.warn(message, fields);
};

export async function recordAgentRouteRejection(
  input: RecordRejectionInput,
): Promise<RejectionOutcome> {
  const log = input.log ?? defaultLog;
  try {
    const token = bearerTokenOf(input.headers.get("authorization"));
    const secret = input.secret ?? configuredSecret();
    if (token === undefined || secret === undefined) {
      log("agent credential refused on an approval route (no event: not verifiable)", {
        route: input.pathname,
        reason: "no_secret_or_token",
      });
      return "unverified";
    }

    const checked = verifyCredentialToken(token, secret);
    if (!checked.ok) {
      log("agent credential refused on an approval route (no event: not verifiable)", {
        route: input.pathname,
        reason: checked.reason,
      });
      return "unverified";
    }

    const { agent_id, workspace_id, run_id, jti } = checked.claims;
    // The event is an existing `error.raised` with a fixed code (the approved v1 event list is not amended here).
    // The database function builds the same payload itself from the validated route and method.
    const route = input.pathname.slice(0, MAX_ROUTE_LENGTH);
    const event = runEventSchema.safeParse({
      type: "error.raised",
      version: 1,
      payload: {
        code: REJECTION_EVENT_CODE,
        message: `${input.method} ${route}`,
        retryable: false,
      },
    });
    if (!REJECTION_METHODS.has(input.method) || !event.success) {
      log("agent credential refused on an approval route (no event: unsupported method)", {
        route: input.pathname,
        reason: "invalid_event",
      });
      return "unverified";
    }

    const client = input.client ?? serviceClient();
    if (client === undefined) {
      log("could not record the agent credential rejection", {
        route: input.pathname,
        code: "no_service_key",
      });
      return "failed";
    }
    const { error } = await client.rpc("record_agent_approval_rejection", {
      p_workspace_id: workspace_id,
      p_run_id: run_id,
      p_agent_id: agent_id,
      p_jti: jti,
      p_route: route,
      p_method: input.method,
    });
    if (error) {
      log("could not record the agent credential rejection", {
        route: input.pathname,
        code: error.code ?? "unknown",
      });
      return "failed";
    }
    return "recorded";
  } catch {
    log("could not record the agent credential rejection", {
      route: input.pathname,
      code: "exception",
    });
    return "failed";
  }
}
