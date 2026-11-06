import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { hasMinRole } from "@ago/shared";

import { getCurrentUser } from "../../../../features/auth/current-user";
import { AssignSkillPanel } from "../../../../features/skills/AssignSkillPanel";
import { MarkdownPreview } from "../../../../features/skills/MarkdownPreview";
import { SkillEditor } from "../../../../features/skills/SkillEditor";
import { getSkillDetail, SkillLibraryError } from "../../../../features/skills/skill-library";
import { VersionHistory } from "../../../../features/skills/VersionHistory";
import { getActiveWorkspace } from "../../../../features/workspaces/workspace-access";
import { parseInput } from "../../../../lib/validation/parse-input";

export const metadata: Metadata = { title: "Skill · Agent Office" };

const paramsSchema = z.strictObject({ skillId: z.uuid() });

// One skill: edit (owners) or read (everyone), its version history, and the agents that have it.
export default async function SkillPage({ params }: { params: Promise<{ skillId: string }> }) {
  const parsed = parseInput(paramsSchema, await params);
  if (!parsed.success) notFound();

  const user = await getCurrentUser();
  const workspace = user ? await getActiveWorkspace(user.id) : null;
  if (!workspace) redirect("/app");

  let detail;
  try {
    detail = await getSkillDetail(workspace.id, parsed.data.skillId);
  } catch (error) {
    if (error instanceof SkillLibraryError && error.code === "not_found") notFound();
    throw error;
  }

  const { skill, versions, assignments, agents } = detail;
  const canEdit = hasMinRole(workspace.role, "owner");

  return (
    <main className="mx-auto grid max-w-5xl gap-8 p-8">
      <header className="grid gap-1">
        <Link
          href="/app/skills"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← All skills
        </Link>
        <h1 className="text-2xl font-bold tracking-tight" data-testid="skill-name">
          {skill.name}
        </h1>
        <p className="text-sm text-muted-foreground" data-testid="skill-version">
          Version {skill.version}
        </p>
      </header>

      {canEdit ? (
        <SkillEditor
          workspaceId={workspace.id}
          skillId={skill.id}
          version={skill.version}
          description={skill.description}
          body={skill.body}
        />
      ) : (
        <section className="grid gap-2" aria-label="Skill text">
          {skill.description ? (
            <p className="text-sm text-muted-foreground">{skill.description}</p>
          ) : null}
          <div className="rounded-md border p-3">
            <MarkdownPreview text={skill.body} />
          </div>
          <p className="text-sm text-muted-foreground">Only workspace owners can edit skills.</p>
        </section>
      )}

      <AssignSkillPanel
        workspaceId={workspace.id}
        skillId={skill.id}
        assignments={assignments}
        agents={agents}
        canEdit={canEdit}
      />

      <VersionHistory versions={versions} currentVersion={skill.version} />
    </main>
  );
}
