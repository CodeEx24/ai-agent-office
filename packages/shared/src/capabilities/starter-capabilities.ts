import type { CapabilityDefinition } from "./capability-schemas.js";

/**
 * The v1 starter catalog: 12 capabilities seeded into every workspace.
 *
 * The Master List these came from was not found in the repo or tracker when AGO-125 was built, so this
 * list is the v1 source of truth. It mirrors `private.seed_workspace_capabilities()` in
 * `supabase/migrations/20261106140001_ago_125_capability_catalog.sql`; `starter-capabilities.test.ts`
 * fails when the two drift. To amend the catalog, change both in the same pull request (a new migration
 * replaces the SQL function) and update docs/tickets/AGO-125.md.
 *
 * Rules: tier 3 and 4 always default to approval. Tier 4 is irreversible or costly.
 */
export const STARTER_CAPABILITIES = [
  {
    key: "vault.read",
    name: "Read shared notes",
    description: "Read notes in the shared vault.",
    tier: 0,
    scope: "workspace",
    defaultMode: "automatic",
  },
  {
    key: "vault.read_private",
    name: "Read own private notes",
    description: "Read the agent's own private notes.",
    tier: 0,
    scope: "agent",
    defaultMode: "automatic",
  },
  {
    key: "web.search",
    name: "Search the web",
    description: "Run a web search and read the result snippets.",
    tier: 1,
    scope: "external",
    defaultMode: "automatic",
  },
  {
    key: "tasks.manage",
    name: "Manage tasks",
    description: "Create and update tasks in the workspace.",
    tier: 1,
    scope: "workspace",
    defaultMode: "automatic",
  },
  {
    key: "vault.write_own",
    name: "Write own notes",
    description: "Create and edit the agent's own notes.",
    tier: 2,
    scope: "agent",
    defaultMode: "approval",
  },
  {
    key: "vault.write_shared",
    name: "Write shared notes",
    description: "Create and edit notes in the shared vault.",
    tier: 2,
    scope: "workspace",
    defaultMode: "approval",
  },
  {
    key: "code.run",
    name: "Run code",
    description: "Run code in the sandbox.",
    tier: 3,
    scope: "sandbox",
    defaultMode: "approval",
  },
  {
    key: "web.browse",
    name: "Browse the web",
    description: "Open and interact with web pages.",
    tier: 3,
    scope: "external",
    defaultMode: "approval",
  },
  {
    key: "message.send_outbound",
    name: "Send outbound messages",
    description: "Send a message to someone outside the workspace.",
    tier: 3,
    scope: "external",
    defaultMode: "approval",
  },
  {
    key: "integration.write",
    name: "Write to integrations",
    description: "Change data in a connected external service.",
    tier: 3,
    scope: "external",
    defaultMode: "approval",
  },
  {
    key: "payments.execute",
    name: "Execute payments",
    description: "Spend money or move funds.",
    tier: 4,
    scope: "external",
    defaultMode: "approval",
  },
  {
    key: "data.delete_irreversible",
    name: "Delete data permanently",
    description: "Permanently delete data with no way back.",
    tier: 4,
    scope: "workspace",
    defaultMode: "approval",
  },
] as const satisfies readonly CapabilityDefinition[];

export type StarterCapabilityKey = (typeof STARTER_CAPABILITIES)[number]["key"];
