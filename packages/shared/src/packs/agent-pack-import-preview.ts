import {
  AGENT_DAILY_BUDGET_DEFAULT_CENTS,
  AGENT_DAILY_BUDGET_MAX_CENTS,
  AGENT_MODEL_IDS,
} from "../agents/agent-limits.js";
import { lintTrifecta, trifectaMappedKeys, type TrifectaLeg } from "../agents/trifecta-lint.js";
import { MIN_NEVER_AUTOMATIC_TIER } from "../capabilities/capability-schemas.js";
import { verifyPackChecksum, type PackChecksumStatus } from "./agent-pack-export.js";
import { parseAgentPack } from "./agent-pack-migrate.js";
import {
  MAX_PACK_AGENTS,
  MAX_PACK_NOTES,
  MAX_PACK_SKILLS,
  type AgentPack,
  type PackAgent,
} from "./agent-pack-schemas.js";

/**
 * Agent pack import, dry run (AGO-193, epic EP-19). The pure core of "what would this pack change?".
 *
 * Nothing here reads a database or the network or writes anything: the caller passes the workspace's current
 * state in as plain data (`PreviewContext`) and gets a plain result back. The API route and `pnpm pack:import`
 * share this one path, and AGO-194 (the real import) starts from `buildImportPreview` too.
 *
 * Node only (the checksum uses `node:crypto`), so it is NOT in the client-safe barrel: import it from
 * `@ago/shared/pack-import-preview`.
 *
 * Pack text is untrusted. The result carries names, numbers and fixed reason codes, never a prompt, a skill
 * body or a note. Every name that does reach a message goes through `safeText` (control and direction
 * characters stripped, length bounded). The secret scan reports where a secret-looking value is, never the value.
 */

// ---------------------------------------------------------------- limits and the pre-parse guard

/** Largest pack file accepted, in bytes. Checked on the raw bytes before any JSON parse. */
export const MAX_PACK_BYTES = 5 * 1024 * 1024;
/** Deepest `{` / `[` nesting accepted. A real pack is about 4 deep. */
export const MAX_PACK_DEPTH = 12;
/** Most JSON values (objects, arrays, strings, numbers) in one pack. */
export const MAX_PACK_NODES = 200_000;
/** Longest piece of pack text echoed in a message. */
export const MAX_ECHO_LENGTH = 80;
/** Most schema issues returned for an invalid pack. */
export const MAX_REPORTED_ISSUES = 20;

export type PackRejectionCode =
  | "too_large"
  | "too_deep"
  | "too_complex"
  | "invalid_json"
  | "not_a_pack"
  | "too_many_agents"
  | "too_many_skills"
  | "too_many_notes"
  | "invalid_pack";

export interface PackRejectionIssue {
  path: string;
  message: string;
}

/** Why a file was refused. The message is fixed text plus numbers; it never repeats pack content. */
export interface PackRejection {
  code: PackRejectionCode;
  message: string;
  /** Only for `invalid_pack`: at most MAX_REPORTED_ISSUES entries, each shortened and cleaned. */
  issues?: PackRejectionIssue[];
}

/** Strips control and direction-override characters and bounds the length. For any untrusted text in a message. */
export function safeText(value: string, max: number = MAX_ECHO_LENGTH): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    const isDirection = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    out += isControl || isDirection || code === 0x2028 || code === 0x2029 ? "?" : char;
    if (out.length > max) break;
  }
  return out.length > max ? `${out.slice(0, max)}...` : out;
}

function reject(code: PackRejectionCode, message: string): { ok: false; error: PackRejection } {
  return { ok: false, error: { code, message } };
}

/** Linear scan of nesting depth that understands strings. Stops at the first breach. */
function exceedsDepth(text: string, limit: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
      if (depth > limit) return true;
    } else if (char === "}" || char === "]") {
      depth -= 1;
    }
  }
  return false;
}

/** Counts values without recursion; true as soon as the limit is passed. */
function exceedsNodes(root: unknown, limit: number): boolean {
  const stack: unknown[] = [root];
  let count = 0;
  while (stack.length > 0) {
    const value = stack.pop();
    count += 1;
    if (count > limit) return true;
    if (Array.isArray(value)) {
      for (const item of value as unknown[]) stack.push(item);
    } else if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value)) stack.push(item);
    }
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The checks that run before the schema parse: size, nesting depth, JSON syntax, then pack-wide counts and
 * total value count. Cheap checks first, so an oversized or deeply nested file never reaches the full parse.
 */
export function inspectPackText(
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: PackRejection } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_PACK_BYTES) {
    return reject(
      "too_large",
      `The file is too large (${String(Math.ceil(bytes / 1024))} KB). The limit is ${String(MAX_PACK_BYTES / 1024 / 1024)} MB.`,
    );
  }
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (exceedsDepth(body, MAX_PACK_DEPTH)) {
    return reject(
      "too_deep",
      `The file is nested more than ${String(MAX_PACK_DEPTH)} levels deep, which no agent pack needs.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    // The parser's own message quotes the bad text, so it is not passed on.
    return reject("invalid_json", "The file is not valid JSON.");
  }
  if (!isPlainObject(value)) {
    return reject("not_a_pack", "The file is JSON but not an agent pack (expected an object).");
  }
  if (exceedsNodes(value, MAX_PACK_NODES)) {
    return reject(
      "too_complex",
      `The file holds more than ${String(MAX_PACK_NODES)} values, which no agent pack needs.`,
    );
  }
  const counts: [string, PackRejectionCode, number][] = [
    ["agents", "too_many_agents", MAX_PACK_AGENTS],
    ["skills", "too_many_skills", MAX_PACK_SKILLS],
    ["notes", "too_many_notes", MAX_PACK_NOTES],
  ];
  for (const [field, code, limit] of counts) {
    const list = value[field];
    if (Array.isArray(list) && list.length > limit) {
      return reject(
        code,
        `The pack has ${String(list.length)} ${field}. The limit is ${String(limit)}.`,
      );
    }
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------- the preview

/** The per-agent daily budget ceiling. One helper so a workspace cap (AGO-40) can replace it later. */
export function getPackBudgetCapCents(): number {
  return AGENT_DAILY_BUDGET_MAX_CENTS;
}

export interface ExistingPackAgent {
  name: string;
  role: string;
  model: string;
  thinkingEffort: string;
  prompt: string;
  archived: boolean;
}

export interface ExistingPackSkill {
  name: string;
  version: number;
  body: string;
}

export interface CatalogCapability {
  key: string;
  tier: number;
  scope: string;
}

/** The workspace's current state, as plain data. */
export interface PreviewContext {
  existingAgents: readonly ExistingPackAgent[];
  existingSkills: readonly ExistingPackSkill[];
  catalog: readonly CatalogCapability[];
  /** Defaults to the agent model allowlist. */
  allowedModels?: readonly string[];
  /** Defaults to `getPackBudgetCapCents()`. */
  budgetCapCents?: number;
}

export type PreviewAction = "create" | "update" | "skip";

export type IgnoredReason =
  | "tier_3_or_4_capability"
  | "unknown_capability"
  | "budget_above_cap"
  | "autonomy_mode_forced_strict"
  | "department_not_applied"
  | "notes_not_imported";

export type BlockerCode = "checksum_mismatch" | "model_not_allowed" | "trifecta_combination";

export interface PreviewCapability {
  name: string;
  scope: string;
  /** From the workspace catalog; null when the catalog has no such capability. */
  tier: number | null;
  status: "applied" | "ignored";
  ignoredReason?: "tier_3_or_4_capability" | "unknown_capability";
  /** Tier 3 or 4: always needs a human approval, never applied from a pack. */
  tier3plus: boolean;
  /** Part of a trifecta combination the pack declares on this agent. */
  trifecta: boolean;
}

export interface PreviewAgent {
  name: string;
  action: PreviewAction;
  /** An agent with this name already exists in the workspace. */
  conflict: boolean;
  /** For `update`: which fields differ. Field names only. */
  changedFields: string[];
  existingIsArchived: boolean;
  model: string;
  modelAllowed: boolean;
  /** The budget import would apply: the pack's, or the default when the pack's is above the cap. */
  appliedBudgetCents: number;
  packBudgetCents: number;
  /** Import always lands agents in Strict mode. */
  landsIn: "strict";
  capabilities: PreviewCapability[];
  trifecta: { declared: boolean; remainsAfterIgnoring: boolean; legs: TrifectaLeg[] };
  skills: string[];
}

export interface PreviewSkill {
  name: string;
  action: PreviewAction;
  conflict: boolean;
  /** For `update`: the stored version and the pack's. */
  version: { current: number; pack: number } | null;
}

export type ReferenceKind = "secret" | "integration" | "department";

export interface PreviewReference {
  kind: ReferenceKind;
  name: string;
  agent: string;
}

export interface PreviewIgnored {
  reason: IgnoredReason;
  agent?: string;
  /** A capability name, a number or a short label; never pack prose. */
  item: string;
}

export interface PreviewBlocker {
  code: BlockerCode;
  agent?: string;
  message: string;
}

type TierBucket = "0" | "1" | "2" | "3" | "4" | "unknown";

export interface ImportPreview {
  /** False when any blocker exists: import is all-or-nothing. */
  importable: boolean;
  packName: string;
  packVersion: number;
  checksum: PackChecksumStatus;
  agents: PreviewAgent[];
  skills: PreviewSkill[];
  references: PreviewReference[];
  ignored: PreviewIgnored[];
  blockers: PreviewBlocker[];
  summary: {
    agents: Record<PreviewAction, number>;
    skills: Record<PreviewAction, number>;
    conflicts: number;
    capabilitiesByTier: Record<TierBucket, number>;
    tier3plus: number;
    notes: number;
  };
}

const INTEGRATION_PREFIX = "integration.";
const TRIFECTA_KEYS = new Set(trifectaMappedKeys());
const COMPARED_AGENT_FIELDS = ["role", "model", "thinkingEffort", "prompt"] as const;

function emptyCounts(): Record<PreviewAction, number> {
  return { create: 0, update: 0, skip: 0 };
}

interface Collector {
  references: PreviewReference[];
  ignored: PreviewIgnored[];
  blockers: PreviewBlocker[];
}

function previewCapabilities(
  agent: PackAgent,
  agentName: string,
  catalog: ReadonlyMap<string, CatalogCapability>,
  trifectaDeclared: boolean,
  collect: Collector,
): PreviewCapability[] {
  return agent.capabilities.map((capability) => {
    const entry = catalog.get(capability.name);
    const capabilityName = safeText(capability.name);
    const tier = entry ? entry.tier : null;
    const tier3plus = tier !== null && tier >= MIN_NEVER_AUTOMATIC_TIER;
    const trifecta = trifectaDeclared && TRIFECTA_KEYS.has(capability.name);
    const base = { name: capabilityName, scope: capability.scope, tier, tier3plus, trifecta };
    if (tier === null) {
      collect.ignored.push({
        reason: "unknown_capability",
        agent: agentName,
        item: capabilityName,
      });
      return { ...base, status: "ignored", ignoredReason: "unknown_capability" };
    }
    if (tier3plus) {
      collect.ignored.push({
        reason: "tier_3_or_4_capability",
        agent: agentName,
        item: capabilityName,
      });
      return { ...base, status: "ignored", ignoredReason: "tier_3_or_4_capability" };
    }
    return { ...base, status: "applied" };
  });
}

function previewAgent(agent: PackAgent, context: PreviewContext, collect: Collector): PreviewAgent {
  const catalog = new Map(context.catalog.map((entry) => [entry.key, entry]));
  const allowedModels = context.allowedModels ?? AGENT_MODEL_IDS;
  const budgetCap = context.budgetCapCents ?? getPackBudgetCapCents();
  const name = safeText(agent.name);

  const declaredKeys = agent.capabilities.map((capability) => capability.name);
  const declaredLint = lintTrifecta(declaredKeys);
  const capabilities = previewCapabilities(agent, name, catalog, !declaredLint.ok, collect);

  const appliedKeys = agent.capabilities
    .filter((_, index) => capabilities[index]?.status === "applied")
    .map((capability) => capability.name);
  const appliedLint = lintTrifecta(appliedKeys);
  if (!appliedLint.ok) {
    collect.blockers.push({
      code: "trifecta_combination",
      agent: name,
      message: `Agent "${name}" would hold a blocked capability combination (untrusted content, private data and outbound sending together). Remove one of those capabilities from the pack.`,
    });
  }

  const modelAllowed = allowedModels.includes(agent.model);
  if (!modelAllowed) {
    collect.blockers.push({
      code: "model_not_allowed",
      agent: name,
      message: `Agent "${name}" uses a model that is not on the allowlist ("${safeText(agent.model)}").`,
    });
  }

  const overBudget = agent.dailyBudgetCents > budgetCap;
  if (overBudget) {
    collect.ignored.push({
      reason: "budget_above_cap",
      agent: name,
      item: `${String(agent.dailyBudgetCents)} cents (cap ${String(budgetCap)})`,
    });
  }
  if (agent.autonomyMode !== "strict") {
    collect.ignored.push({
      reason: "autonomy_mode_forced_strict",
      agent: name,
      item: agent.autonomyMode,
    });
  }
  if (agent.department !== undefined) {
    const department = safeText(agent.department);
    collect.ignored.push({ reason: "department_not_applied", agent: name, item: department });
    collect.references.push({ kind: "department", name: department, agent: name });
  }
  for (const secretRef of agent.secretRefs ?? []) {
    collect.references.push({ kind: "secret", name: safeText(secretRef), agent: name });
  }
  for (const key of declaredKeys) {
    if (key.startsWith(INTEGRATION_PREFIX)) {
      collect.references.push({ kind: "integration", name: safeText(key), agent: name });
    }
  }

  const existing = context.existingAgents.find((candidate) => candidate.name === agent.name);
  const changedFields = existing
    ? COMPARED_AGENT_FIELDS.filter((field) => existing[field] !== agent[field])
    : [];
  const action: PreviewAction = !existing
    ? "create"
    : changedFields.length === 0
      ? "skip"
      : "update";

  return {
    name,
    action,
    conflict: existing !== undefined,
    changedFields: [...changedFields],
    existingIsArchived: existing?.archived ?? false,
    model: safeText(agent.model),
    modelAllowed,
    appliedBudgetCents: overBudget
      ? Math.min(AGENT_DAILY_BUDGET_DEFAULT_CENTS, budgetCap)
      : agent.dailyBudgetCents,
    packBudgetCents: agent.dailyBudgetCents,
    landsIn: "strict",
    capabilities,
    trifecta: {
      declared: !declaredLint.ok,
      remainsAfterIgnoring: !appliedLint.ok,
      legs: declaredLint.ok
        ? []
        : (Object.keys(declaredLint.legs) as TrifectaLeg[]).filter(
            (leg) => declaredLint.legs[leg].length > 0,
          ),
    },
    skills: agent.skills.map((skill) => safeText(skill)),
  };
}

function previewSkills(pack: AgentPack, context: PreviewContext): PreviewSkill[] {
  return pack.skills.map((skill) => {
    const existing = context.existingSkills.find((candidate) => candidate.name === skill.name);
    const action: PreviewAction = !existing
      ? "create"
      : existing.body === skill.body
        ? "skip"
        : "update";
    return {
      name: safeText(skill.name),
      action,
      conflict: existing !== undefined,
      version:
        existing && action === "update" ? { current: existing.version, pack: skill.version } : null,
    };
  });
}

function summarise(
  agents: readonly PreviewAgent[],
  skills: readonly PreviewSkill[],
  notes: number,
): ImportPreview["summary"] {
  const summary: ImportPreview["summary"] = {
    agents: emptyCounts(),
    skills: emptyCounts(),
    conflicts: 0,
    capabilitiesByTier: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, unknown: 0 },
    tier3plus: 0,
    notes,
  };
  for (const agent of agents) {
    summary.agents[agent.action] += 1;
    if (agent.conflict) summary.conflicts += 1;
    for (const capability of agent.capabilities) {
      const bucket = (capability.tier === null ? "unknown" : String(capability.tier)) as TierBucket;
      summary.capabilitiesByTier[bucket] += 1;
      if (capability.tier3plus) summary.tier3plus += 1;
    }
  }
  for (const skill of skills) {
    summary.skills[skill.action] += 1;
    if (skill.conflict) summary.conflicts += 1;
  }
  return summary;
}

/** What importing a validated pack would do. Pure: the caller supplies the workspace state. */
export function buildImportPreview(pack: AgentPack, context: PreviewContext): ImportPreview {
  const collect: Collector = { references: [], ignored: [], blockers: [] };

  const checksum = verifyPackChecksum(pack);
  if (checksum === "mismatch") {
    collect.blockers.push({
      code: "checksum_mismatch",
      message:
        "The checksum does not match the pack content: the file was edited after export, or it is damaged. Export it again, or remove the checksum only if you trust the edit.",
    });
  }

  const agents = pack.agents.map((agent) => previewAgent(agent, context, collect));
  const skills = previewSkills(pack, context);

  const notes = pack.notes?.length ?? 0;
  if (notes > 0) {
    collect.ignored.push({ reason: "notes_not_imported", item: `${String(notes)} note(s)` });
  }

  return {
    importable: collect.blockers.length === 0,
    packName: safeText(pack.metadata.name),
    packVersion: pack.packVersion,
    checksum,
    agents,
    skills,
    references: collect.references,
    ignored: collect.ignored,
    blockers: collect.blockers,
    summary: summarise(agents, skills, notes),
  };
}

export type ValidatePackTextResult =
  { ok: true; pack: AgentPack } | { ok: false; error: PackRejection };

/**
 * Guard, then the full schema parse (version upgrade, strict shape, secret scan). The loader calls this first so
 * it only reads the workspace for a pack that is worth previewing. Issues carry paths and short, cleaned messages.
 */
export function validatePackText(text: string): ValidatePackTextResult {
  const inspected = inspectPackText(text);
  if (!inspected.ok) return inspected;
  const parsed = parseAgentPack(inspected.value);
  if (!parsed.ok) {
    const issues = parsed.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
      path: safeText(issue.path, 200),
      message: safeText(issue.message, 200),
    }));
    const total = parsed.issues.length;
    return {
      ok: false,
      error: {
        code: "invalid_pack",
        message:
          `The file is not a valid agent pack (${String(total)} problem${total === 1 ? "" : "s"}` +
          `${total > issues.length ? `, first ${String(issues.length)} shown` : ""}).`,
        issues,
      },
    };
  }
  return { ok: true, pack: parsed.pack };
}

export type PreviewPackTextResult =
  { ok: true; preview: ImportPreview } | { ok: false; error: PackRejection };

/** The whole dry run on a file's text: validate, then preview. For callers that already hold the context. */
export function previewAgentPackText(text: string, context: PreviewContext): PreviewPackTextResult {
  const validated = validatePackText(text);
  if (!validated.ok) return validated;
  return { ok: true, preview: buildImportPreview(validated.pack, context) };
}
