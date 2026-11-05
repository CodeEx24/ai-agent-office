/**
 * Typed fixtures for the local seed (supabase/seed.sql, AGO-122). Tests import these ids instead of
 * re-inventing data. seed-ids.test.ts fails if this file and seed.sql drift apart.
 */

export const SEED_WORKSPACE_ID = "12200001-0000-4000-8000-000000000001";
export const SEED_OWNER_USER_ID = "12200010-0000-4000-8000-000000000001";
export const SEED_OWNER_EMAIL = "seed-owner@agent-office.local";
export const SEED_OWNER_MEMBER_ID = "12200011-0000-4000-8000-000000000001";

export const SEED_AGENTS = [
  { id: "12200020-0000-4000-8000-000000000001", name: "Scout" },
  { id: "12200020-0000-4000-8000-000000000002", name: "Scribe" },
  { id: "12200020-0000-4000-8000-000000000003", name: "Reviewer" },
] as const;

export const SEED_SKILLS = [
  { id: "12200030-0000-4000-8000-000000000001", name: "research-summary" },
  { id: "12200030-0000-4000-8000-000000000002", name: "note-writing" },
  { id: "12200030-0000-4000-8000-000000000003", name: "peer-review" },
] as const;

export const SEED_TASKS = [
  {
    id: "12200060-0000-4000-8000-000000000001",
    title: "Research office layout options",
    agentId: SEED_AGENTS[0].id,
  },
  {
    id: "12200060-0000-4000-8000-000000000002",
    title: "Draft the onboarding note",
    agentId: SEED_AGENTS[1].id,
  },
  {
    id: "12200060-0000-4000-8000-000000000003",
    title: "Review the onboarding note",
    agentId: SEED_AGENTS[2].id,
  },
  { id: "12200060-0000-4000-8000-000000000004", title: "Summarise weekly progress", agentId: null },
  { id: "12200060-0000-4000-8000-000000000005", title: "Tidy the vault index", agentId: null },
] as const;

/** Row counts the seed produces for the seeded workspace. */
export const SEED_COUNTS = {
  workspaces: 1,
  members: 1,
  agents: SEED_AGENTS.length,
  skills: SEED_SKILLS.length,
  tasks: SEED_TASKS.length,
} as const;
