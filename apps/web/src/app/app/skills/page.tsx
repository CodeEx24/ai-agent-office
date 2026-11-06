import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { hasMinRole } from "@ago/shared";

import { getCurrentUser } from "../../../features/auth/current-user";
import { CreateSkillForm } from "../../../features/skills/CreateSkillForm";
import { listSkills } from "../../../features/skills/skill-library";
import { getActiveWorkspace } from "../../../features/workspaces/workspace-access";

export const metadata: Metadata = { title: "Skills · Agent Office" };

// The skill library (AGO-128). Everyone in the workspace can read it; only owners can add skills.
// No request input is read here: the workspace comes from the signed-in user's membership.
/** @no-input */
export default async function SkillsPage() {
  const user = await getCurrentUser();
  const workspace = user ? await getActiveWorkspace(user.id) : null;
  if (!workspace) redirect("/app");

  const skills = await listSkills(workspace.id);
  const canEdit = hasMinRole(workspace.role, "owner");

  return (
    <main className="mx-auto grid max-w-3xl gap-6 p-8 [&>*]:min-w-0">
      <header className="grid gap-1">
        <h1 className="text-2xl font-bold tracking-tight">Skills</h1>
        <p className="text-sm text-muted-foreground">
          Markdown know-how you control. Assign a skill to an agent to teach it how you work. A
          skill never grants a permission.
        </p>
      </header>

      {skills.length === 0 ? (
        <p className="text-muted-foreground">No skills yet.</p>
      ) : (
        <ul className="grid min-w-0 gap-2" data-testid="skill-list">
          {skills.map((skill) => (
            <li key={skill.id} className="min-w-0 rounded-md border">
              <Link
                href={`/app/skills/${skill.id}`}
                className="flex items-baseline justify-between gap-3 px-3 py-2 hover:bg-accent"
              >
                <span className="min-w-0">
                  <span className="font-medium [overflow-wrap:anywhere]">{skill.name}</span>
                  {skill.description ? (
                    <span className="block text-sm [overflow-wrap:anywhere] text-muted-foreground">
                      {skill.description}
                    </span>
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground">v{skill.version}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {canEdit ? (
        <section className="grid gap-3" aria-label="Add a skill">
          <h2 className="text-lg font-semibold">New skill</h2>
          <CreateSkillForm workspaceId={workspace.id} />
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only workspace owners can add or edit skills.
        </p>
      )}
    </main>
  );
}
