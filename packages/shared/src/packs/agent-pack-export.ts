import { createHash } from "node:crypto";

import { AGENT_DAILY_BUDGET_DEFAULT_CENTS } from "../agents/agent-limits.js";
import type { CapabilityScope } from "../capabilities/capability-schemas.js";
import { canonicalJson } from "./canonical-json.js";
import {
  PACK_CHECKSUM_ALGORITHM,
  PACK_VERSION,
  agentPackSchema,
  type AgentPack,
  type PackThinkingEffort,
} from "./agent-pack-schemas.js";

/**
 * Agent pack export, the pure core (AGO-192). Node only (`node:crypto`), so it is NOT in the client-safe barrel:
 * import it from `@ago/shared/pack-export`. The API route and `pnpm pack:export` both call `buildAgentPack`.
 *
 * The input is plain data with no database ids and no credential columns: a caller that selects only the fields
 * of `PackSourceAgent` and `PackSourceSkill` cannot leak anything else, and `agentPackSchema` (strict objects plus
 * a scan for secret-shaped text) stops a planted value from reaching a file.
 */

export interface PackSourceSkill {
  name: string;
  version: number;
  body: string;
}

export interface PackSourceAgent {
  name: string;
  role: string;
  model: string;
  thinkingEffort: PackThinkingEffort;
  prompt: string;
  /** From `agents.mode`; the schema checks it against the policy modes. */
  mode: string;
  /** Null when the agent never had a budget set; exported as the platform default. */
  dailyBudgetCents: number | null;
  /** Skill names. */
  skills: readonly string[];
  /** Catalog key and scope only: tier, mode and who granted it are not exported. */
  capabilities: readonly { key: string; scope: CapabilityScope }[];
}

export interface PackSource {
  agents: readonly PackSourceAgent[];
  /** May hold more skills than the agents use; only used ones are exported. */
  skills: readonly PackSourceSkill[];
}

export interface BuildAgentPackOptions {
  name: string;
  /** Injected so a test (or a re-export) can fix the time. */
  now: Date;
  appVersion: string;
}

export type PackExportErrorCode = "no_agents" | "skill_missing" | "invalid_pack";

/** Thrown when a pack cannot be built. `issues` hold paths and messages only, never values. */
export class PackExportError extends Error {
  constructor(
    readonly code: PackExportErrorCode,
    readonly issues: readonly string[] = [],
  ) {
    super(`Agent pack export failed: ${code}${issues.length ? ` (${issues.join("; ")})` : ""}`);
    this.name = "PackExportError";
  }
}

export interface BuiltAgentPack {
  pack: AgentPack;
  /** The exact file text: canonical JSON of `pack` plus one newline. */
  json: string;
  /** Lowercase hex SHA-256, the same value as `pack.checksum.value`. */
  checksum: string;
}

function byName<T extends { name: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** SHA-256 of the UTF-8 bytes of the canonical JSON of the pack with its `checksum` field removed. */
export function computePackChecksum(pack: Omit<AgentPack, "checksum"> | AgentPack): string {
  const content: Record<string, unknown> = { ...pack };
  delete content.checksum;
  return createHash("sha256").update(canonicalJson(content), "utf8").digest("hex");
}

/** The pack as it was before its checksum was added: the content the checksum covers. */
export function withoutChecksum(pack: AgentPack): Omit<AgentPack, "checksum"> {
  const content: Record<string, unknown> = { ...pack };
  delete content.checksum;
  return content as Omit<AgentPack, "checksum">;
}

export type PackChecksumStatus = "missing" | "valid" | "mismatch";

/** Recomputes the checksum of a parsed pack. A pack without one is "missing", not an error. */
export function verifyPackChecksum(pack: AgentPack): PackChecksumStatus {
  if (!pack.checksum) return "missing";
  return pack.checksum.value === computePackChecksum(pack) ? "valid" : "mismatch";
}

export function buildAgentPack(source: PackSource, options: BuildAgentPackOptions): BuiltAgentPack {
  if (source.agents.length === 0) throw new PackExportError("no_agents");

  const skillsByName = new Map(source.skills.map((skill) => [skill.name, skill]));
  const usedSkillNames = new Set<string>();
  for (const agent of source.agents) {
    for (const skillName of agent.skills) {
      if (!skillsByName.has(skillName)) throw new PackExportError("skill_missing");
      usedSkillNames.add(skillName);
    }
  }

  const content = {
    packVersion: PACK_VERSION,
    metadata: {
      name: options.name,
      exportedAt: options.now.toISOString(),
      appVersion: options.appVersion,
    },
    agents: byName(source.agents).map((agent) => ({
      name: agent.name,
      role: agent.role,
      model: agent.model,
      thinkingEffort: agent.thinkingEffort,
      prompt: agent.prompt,
      skills: [...new Set(agent.skills)].sort(),
      capabilities: [...agent.capabilities]
        .map((capability) => ({ name: capability.key, scope: capability.scope }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      dailyBudgetCents: agent.dailyBudgetCents ?? AGENT_DAILY_BUDGET_DEFAULT_CENTS,
      autonomyMode: agent.mode,
    })),
    skills: [...usedSkillNames].sort().map((skillName) => {
      const skill = skillsByName.get(skillName);
      return { name: skillName, version: skill?.version ?? 1, body: skill?.body ?? "" };
    }),
  };

  const checked = agentPackSchema.safeParse(content);
  if (!checked.success) {
    // Paths and messages only: a message never echoes a value, and a value never leaves this function.
    throw new PackExportError(
      "invalid_pack",
      checked.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }

  const value = computePackChecksum(checked.data);
  const pack: AgentPack = {
    ...checked.data,
    checksum: { algorithm: PACK_CHECKSUM_ALGORITHM, value },
  };
  return { pack, json: `${canonicalJson(pack)}\n`, checksum: value };
}
