import { readFile } from "node:fs/promises";

import { EGRESS_DEFAULT_PORTS, egressAllowlistFileSchema } from "@ago/shared";

import type { EgressRuntimeAllowlist } from "./egress-launcher.js";
import { compileAllowlist } from "./egress-proxy.js";

/**
 * The per-workspace egress allowlist (AGO-65). It is a JSON file edited by a human on the worker host
 * (`EGRESS_ALLOWLIST_FILE`); there is no code path for an agent to add a host. Default deny: a missing,
 * unreadable, malformed or partly invalid file, or a workspace that is not listed, yields an empty allowlist.
 * The file is re-read on every call, so an edit takes effect on the next run without a restart.
 */

/** Nothing allowed. */
export const DENY_ALL_EGRESS: EgressRuntimeAllowlist = { hosts: [], ports: [] };

export interface EgressAllowlistProvider {
  /** Never throws and never returns more than the file grants. */
  forWorkspace(workspaceId: string): Promise<EgressRuntimeAllowlist>;
}

export interface FileEgressAllowlistOptions {
  /** Path of the JSON file. Undefined means egress is not configured: everything is denied. */
  readonly path: string | undefined;
  /** Called with a short reason (never file contents) when the file is unusable. */
  readonly warn?: (message: string) => void;
  /** Test seam. */
  readonly readText?: (path: string) => Promise<string>;
}

export function createFileEgressAllowlistProvider(
  options: FileEgressAllowlistOptions,
): EgressAllowlistProvider {
  const readText = options.readText ?? ((path: string) => readFile(path, "utf8"));
  const warn = (message: string): void => {
    try {
      options.warn?.(message);
    } catch {
      // logging must never change the decision
    }
  };

  return {
    async forWorkspace(workspaceId: string): Promise<EgressRuntimeAllowlist> {
      if (options.path === undefined || options.path === "") return DENY_ALL_EGRESS;
      let text: string;
      try {
        text = await readText(options.path);
      } catch {
        warn("egress allowlist file is missing or unreadable; denying all egress");
        return DENY_ALL_EGRESS;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        warn("egress allowlist file is not valid JSON; denying all egress");
        return DENY_ALL_EGRESS;
      }
      const parsed = egressAllowlistFileSchema.safeParse(json);
      if (!parsed.success) {
        warn("egress allowlist file does not match the schema; denying all egress");
        return DENY_ALL_EGRESS;
      }
      // One bad host anywhere makes the whole file untrusted: a list must not half-apply.
      for (const entry of Object.values(parsed.data.workspaces)) {
        try {
          compileAllowlist(entry.hosts);
        } catch {
          warn("egress allowlist file has an invalid host entry; denying all egress");
          return DENY_ALL_EGRESS;
        }
      }
      const entry = Object.hasOwn(parsed.data.workspaces, workspaceId)
        ? parsed.data.workspaces[workspaceId]
        : undefined;
      if (entry === undefined || entry.hosts.length === 0) return DENY_ALL_EGRESS;
      return { hosts: entry.hosts, ports: entry.ports ?? EGRESS_DEFAULT_PORTS };
    },
  };
}
