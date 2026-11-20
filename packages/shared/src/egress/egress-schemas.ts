import { z } from "zod";

/**
 * Egress allowlist contracts (AGO-65). A sandboxed run that needs the network reaches it only through the
 * egress proxy, which is default deny. The allowlist is edited by humans on the worker host (a JSON file);
 * nothing an agent can call changes it. Pure and dependency-free: the proxy itself re-checks every value.
 */

export const EGRESS_DEFAULT_PORTS: readonly number[] = [80, 443];
export const EGRESS_MAX_HOSTS_PER_WORKSPACE = 200;
export const EGRESS_MAX_PORTS_PER_WORKSPACE = 10;
export const EGRESS_HOST_MAX_LENGTH = 253;

/** Why the proxy refused a request. Logged with every block. */
export const EGRESS_BLOCK_REASONS = [
  "not_allowlisted",
  "port_not_allowed",
  "private_address",
  "invalid_host",
  "host_mismatch",
  "resolve_failed",
  "too_many_connections",
  "bad_request",
  "timeout",
  "upstream_error",
] as const;
export type EgressBlockReason = (typeof EGRESS_BLOCK_REASONS)[number];

/**
 * `example.com` (exactly that host) or `*.example.com` (any subdomain, not the apex). No scheme, port, path,
 * userinfo, IP literal or bare `*`. Further checks (IDN, TLD wildcards) happen in the proxy's normaliser.
 */
export const egressHostPatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(EGRESS_HOST_MAX_LENGTH)
  .refine((value) => !/[\s/\\:?#@[\]%]/u.test(value), "must be a bare host name")
  .refine(
    (value) => !value.slice(2).includes("*") && (!value.includes("*") || value.startsWith("*.")),
    {
      message: "only a leading '*.' wildcard is allowed",
    },
  );

export const egressWorkspaceEntrySchema = z.strictObject({
  hosts: z.array(egressHostPatternSchema).max(EGRESS_MAX_HOSTS_PER_WORKSPACE),
  /** Allowed destination ports. Defaults to 80 and 443. */
  ports: z
    .array(z.number().int().min(1).max(65_535))
    .min(1)
    .max(EGRESS_MAX_PORTS_PER_WORKSPACE)
    .optional(),
});
export type EgressWorkspaceEntry = z.infer<typeof egressWorkspaceEntrySchema>;

/** The allowlist file. Strict: an unknown key makes the whole file invalid, which means deny all. */
export const egressAllowlistFileSchema = z.strictObject({
  version: z.literal(1),
  workspaces: z.record(z.string().min(1).max(80), egressWorkspaceEntrySchema),
});
export type EgressAllowlistFile = z.infer<typeof egressAllowlistFileSchema>;

/** One proxy decision, as logged (one JSON line). Never carries a path, query, header or body. */
export const egressDecisionSchema = z.strictObject({
  event: z.enum(["egress.allowed", "egress.blocked"]),
  run_id: z.string(),
  workspace_id: z.string(),
  host: z.string(),
  port: z.number().int(),
  method: z.string(),
  reason: z.enum(EGRESS_BLOCK_REASONS).optional(),
});
export type EgressDecision = z.infer<typeof egressDecisionSchema>;
