import { expect, isLiveStack, test } from "./fixtures";
import { SignInPage } from "./pages/sign-in-page";
import { WorkspacePage } from "./pages/workspace-page";
import {
  addMember,
  asServiceRole,
  asUser,
  createUser,
  membershipsOf,
  onboard,
  roleInWorkspace,
  softRemove,
  workspaceName,
  type TestUser,
} from "./support/stack-api";

// AGO-82 AC2: roles owner, member and viewer are stored and enforced. Needs the local stack
// (E2E_SUPABASE=1). Role changes and invites do not exist yet (AGO-112), so memberships for the
// non-owner roles are created with service_role, and every attempt to change one goes through
// the same Data API a browser client would use.
test.describe("AGO-82 AC2: roles are stored and enforced (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");

  /** A workspace with an owner, a member and a viewer. */
  async function workspaceWithAllRoles() {
    const owner = await createUser("owner");
    const member = await createUser("member");
    const viewer = await createUser("viewer");
    const workspaceId = await onboard(owner, "Roles Co");
    await addMember(workspaceId, member, "member");
    await addMember(workspaceId, viewer, "viewer");
    return { owner, member, viewer, workspaceId };
  }

  test("AC2: owner, member and viewer are stored as given", async () => {
    const { owner, member, viewer, workspaceId } = await workspaceWithAllRoles();

    expect(await roleInWorkspace(workspaceId, owner.id)).toBe("owner");
    expect(await roleInWorkspace(workspaceId, member.id)).toBe("member");
    expect(await roleInWorkspace(workspaceId, viewer.id)).toBe("viewer");
  });

  test("AC2 (negative): a role outside owner, member and viewer is rejected by the database", async () => {
    const owner = await createUser("owner");
    const stranger = await createUser("stranger");
    const workspaceId = await onboard(owner, "Closed Roles Co");

    const result = await asServiceRole<{ code: string }>("/rest/v1/members", {
      method: "POST",
      body: { workspace_id: workspaceId, user_id: stranger.id, role: "admin" },
    });

    expect(result.status).toBe(400);
    expect(result.body.code).toBe("23514");
    expect(await membershipsOf(stranger.id)).toEqual([]);
  });

  for (const role of ["member", "viewer"] as const) {
    test(`AC2: /app shows a ${role} the workspace they belong to and their role`, async ({
      page,
    }) => {
      const owner = await createUser("owner");
      const workspaceId = await onboard(owner, `Shared ${role} Co`);
      const guest = await createUser(role);
      const signIn = new SignInPage(page);
      await signIn.goto("/sign-in?next=%2Fapp");
      await signIn.signInWithMagicLink(guest.email);
      const workspace = new WorkspacePage(page);
      await expect(workspace.nameInput).toBeVisible();

      await addMember(workspaceId, guest, role);
      await workspace.goto();

      await expect(workspace.workspaceName).toHaveText(`Shared ${role} Co`);
      await expect(workspace.workspaceRole).toHaveText(role);
      await expect(workspace.nameInput).toHaveCount(0);
    });
  }

  test("AC2: only an owner can rename the workspace", async () => {
    const { owner, workspaceId, member, viewer } = await workspaceWithAllRoles();

    for (const [who, user] of [
      ["viewer", viewer],
      ["member", member],
    ] as const satisfies readonly (readonly [string, TestUser])[]) {
      const denied = await asUser<unknown[]>(user, `/rest/v1/workspaces?id=eq.${workspaceId}`, {
        method: "PATCH",
        body: { name: `Renamed by ${who}` },
        prefer: "return=representation",
      });
      expect(denied.body, `${who} rename must change nothing`).toEqual([]);
      expect(await workspaceName(workspaceId)).toBe("Roles Co");
    }

    const allowed = await asUser<{ name: string }[]>(
      owner,
      `/rest/v1/workspaces?id=eq.${workspaceId}`,
      { method: "PATCH", body: { name: "Renamed by owner" }, prefer: "return=representation" },
    );
    expect(allowed.body.map((row) => row.name)).toEqual(["Renamed by owner"]);
    expect(await workspaceName(workspaceId)).toBe("Renamed by owner");
  });

  test("AC2 (negative): nobody can change a role through PostgREST, including their own", async () => {
    const { owner, member, viewer, workspaceId } = await workspaceWithAllRoles();

    const attempts: [string, TestUser, string, string][] = [
      ["member promotes self", member, member.id, "owner"],
      ["viewer promotes self", viewer, viewer.id, "owner"],
      ["owner demotes self", owner, owner.id, "viewer"],
      ["owner promotes the viewer", owner, viewer.id, "owner"],
      ["member promotes the viewer", member, viewer.id, "owner"],
    ];
    for (const [label, actor, targetId, newRole] of attempts) {
      const result = await asUser<{ code: string }>(
        actor,
        `/rest/v1/members?workspace_id=eq.${workspaceId}&user_id=eq.${targetId}`,
        { method: "PATCH", body: { role: newRole } },
      );
      expect(result.status, label).toBe(403);
      expect(result.body.code, label).toBe("42501");
    }

    expect(await roleInWorkspace(workspaceId, owner.id)).toBe("owner");
    expect(await roleInWorkspace(workspaceId, member.id)).toBe("member");
    expect(await roleInWorkspace(workspaceId, viewer.id)).toBe("viewer");
  });

  test("AC2 (negative): nobody can add, delete or restore memberships through PostgREST", async () => {
    const { owner, member, viewer, workspaceId } = await workspaceWithAllRoles();
    const outsider = await createUser("outsider");

    for (const actor of [owner, member, viewer]) {
      const insert = await asUser<{ code: string }>(actor, "/rest/v1/members", {
        method: "POST",
        body: { workspace_id: workspaceId, user_id: outsider.id, role: "owner" },
      });
      expect(insert.status).toBe(403);
      const remove = await asUser<{ code: string }>(
        actor,
        `/rest/v1/members?workspace_id=eq.${workspaceId}&user_id=eq.${viewer.id}`,
        { method: "DELETE" },
      );
      expect(remove.status).toBe(403);
      const restore = await asUser<{ code: string }>(
        actor,
        `/rest/v1/members?workspace_id=eq.${workspaceId}&user_id=eq.${member.id}`,
        { method: "PATCH", body: { removed_at: null } },
      );
      expect(restore.status).toBe(403);
    }

    expect(await membershipsOf(outsider.id)).toEqual([]);
    expect(await roleInWorkspace(workspaceId, viewer.id)).toBe("viewer");
  });

  test("AC2: a soft-removed member loses access at once, with the token they already hold", async () => {
    const { member, workspaceId } = await workspaceWithAllRoles();
    const before = await asUser<{ id: string }[]>(member, "/rest/v1/workspaces?select=id");
    expect(before.body.map((row) => row.id)).toEqual([workspaceId]);

    await softRemove(workspaceId, member);

    const workspaces = await asUser<unknown[]>(member, "/rest/v1/workspaces?select=id");
    const members = await asUser<unknown[]>(member, "/rest/v1/members?select=user_id");
    expect(workspaces.body).toEqual([]);
    expect(members.body).toEqual([]);
    // The row is kept for audit, only access is gone.
    expect((await membershipsOf(member.id))[0]?.removed_at).not.toBeNull();
  });

  test("AC2: /app stops showing the workspace after the member is soft-removed", async ({
    page,
  }) => {
    const owner = await createUser("owner");
    const workspaceId = await onboard(owner, "Leaving Co");
    const guest = await createUser("guest");
    const signIn = new SignInPage(page);
    await signIn.goto("/sign-in?next=%2Fapp");
    await signIn.signInWithMagicLink(guest.email);
    const workspace = new WorkspacePage(page);
    await addMember(workspaceId, guest, "member");
    await workspace.goto();
    await expect(workspace.workspaceName).toHaveText("Leaving Co");

    await softRemove(workspaceId, guest);
    await page.reload();

    await expect(workspace.workspaceName).toHaveCount(0);
    await expect(page.getByText("Leaving Co")).toHaveCount(0);
    await expect(workspace.nameInput).toBeVisible();
  });
});
