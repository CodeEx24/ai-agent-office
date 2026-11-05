import { expect, isLiveStack, test } from "./fixtures";
import { SignInPage } from "./pages/sign-in-page";
import { WorkspacePage } from "./pages/workspace-page";
import {
  asAnon,
  asServiceRole,
  asUser,
  createUser,
  membershipsOf,
  onboard,
  roleInWorkspace,
  workspaceName,
} from "./support/stack-api";

// AGO-82 AC1 (onboarding is exactly-once) and AC3 (cross-tenant isolation). Needs the local
// stack (E2E_SUPABASE=1). API checks use the same Data API and JWTs a browser client has.
test.describe("AGO-82 AC3: a user cannot reach another workspace (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");

  async function twoTenants() {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const aliceWorkspace = await onboard(alice, "Alice Lab");
    const bobWorkspace = await onboard(bob, "Bob Studio");
    return { alice, bob, aliceWorkspace, bobWorkspace };
  }

  test("AC3: a user's token reads their own workspace and members, and nothing of another's", async () => {
    const { alice, aliceWorkspace, bobWorkspace } = await twoTenants();

    const workspaces = await asUser<{ id: string }[]>(alice, "/rest/v1/workspaces?select=id");
    const members = await asUser<{ workspace_id: string }[]>(
      alice,
      "/rest/v1/members?select=workspace_id",
    );
    const byId = await asUser<unknown[]>(alice, `/rest/v1/workspaces?id=eq.${bobWorkspace}`);
    const membersById = await asUser<unknown[]>(
      alice,
      `/rest/v1/members?workspace_id=eq.${bobWorkspace}`,
    );

    expect(workspaces.body.map((row) => row.id)).toEqual([aliceWorkspace]);
    expect(members.body.map((row) => row.workspace_id)).toEqual([aliceWorkspace]);
    expect(byId.body).toEqual([]);
    expect(membersById.body).toEqual([]);
  });

  test("AC3 (negative): a user cannot write to another workspace or its members", async () => {
    const { alice, bob, bobWorkspace } = await twoTenants();

    const rename = await asUser<unknown[]>(alice, `/rest/v1/workspaces?id=eq.${bobWorkspace}`, {
      method: "PATCH",
      body: { name: "Pwned" },
      prefer: "return=representation",
    });
    const join = await asUser(alice, "/rest/v1/members", {
      method: "POST",
      body: { workspace_id: bobWorkspace, user_id: alice.id, role: "owner" },
    });
    const evict = await asUser(
      alice,
      `/rest/v1/members?workspace_id=eq.${bobWorkspace}&user_id=eq.${bob.id}`,
      { method: "DELETE" },
    );
    const demote = await asUser(
      alice,
      `/rest/v1/members?workspace_id=eq.${bobWorkspace}&user_id=eq.${bob.id}`,
      { method: "PATCH", body: { role: "viewer" } },
    );

    expect(rename.body).toEqual([]);
    expect([join.status, evict.status, demote.status]).toEqual([403, 403, 403]);
    expect(await workspaceName(bobWorkspace)).toBe("Bob Studio");
    expect(await roleInWorkspace(bobWorkspace, bob.id)).toBe("owner");
    expect(await membershipsOf(alice.id)).toHaveLength(1);
  });

  test("AC3 (negative): the anon key alone reads and writes nothing", async () => {
    const { bobWorkspace } = await twoTenants();

    const workspaces = await asAnon<{ code: string }>("/rest/v1/workspaces?select=id");
    const members = await asAnon<{ code: string }>("/rest/v1/members?select=user_id");
    const rename = await asAnon<{ code: string }>(`/rest/v1/workspaces?id=eq.${bobWorkspace}`, {
      method: "PATCH",
      body: { name: "Anon was here" },
    });

    for (const result of [workspaces, members, rename]) {
      expect(result.status).toBe(401);
      expect(result.body.code).toBe("42501");
    }
    expect(await workspaceName(bobWorkspace)).toBe("Bob Studio");
  });

  test("AC3 (negative): the onboarding RPC refuses anon and cannot be aimed at another user", async () => {
    const { alice, bob, bobWorkspace } = await twoTenants();
    const victim = await createUser("victim");

    const anon = await asAnon<{ code: string }>("/rest/v1/rpc/onboard_current_user", {
      method: "POST",
      body: { p_workspace_name: "Anon Co" },
    });
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe("42501");

    // The function only knows the caller; extra arguments naming someone else do not resolve.
    for (const extra of [
      { p_user_id: victim.id },
      { user_id: victim.id },
      { p_owner: victim.id },
    ]) {
      const spoof = await asUser<{ code: string }>(alice, "/rest/v1/rpc/onboard_current_user", {
        method: "POST",
        body: { p_workspace_name: "Spoof Co", ...extra },
      });
      expect(spoof.status).toBe(404);
      expect(spoof.body.code).toBe("PGRST202");
    }

    expect(await membershipsOf(victim.id)).toEqual([]);
    expect(await membershipsOf(bob.id)).toHaveLength(1);
    expect(await roleInWorkspace(bobWorkspace, alice.id)).toBeUndefined();
  });

  test("AC3 (negative): calling the RPC again never hands out another user's workspace", async () => {
    const { alice, aliceWorkspace, bobWorkspace } = await twoTenants();

    const again = await asUser<string>(alice, "/rest/v1/rpc/onboard_current_user", {
      method: "POST",
      body: { p_workspace_name: "Another try" },
    });

    expect(again.body).toBe(aliceWorkspace);
    expect(again.body).not.toBe(bobWorkspace);
    expect(await membershipsOf(alice.id)).toHaveLength(1);
  });

  test("AC3: the app never shows another tenant's workspace, whatever the URL asks for", async ({
    page,
  }) => {
    const { alice, bobWorkspace } = await twoTenants();
    const signIn = new SignInPage(page);
    await signIn.goto("/sign-in?next=%2Fapp");
    await signIn.signInWithMagicLink(alice.email);
    const workspace = new WorkspacePage(page);
    await expect(workspace.workspaceName).toHaveText("Alice Lab");

    for (const url of [
      `/app?workspace=${bobWorkspace}`,
      `/app?workspace_id=${bobWorkspace}`,
      `/app?id=${bobWorkspace}`,
    ]) {
      await page.goto(url);
      await expect(workspace.workspaceName).toHaveText("Alice Lab");
      await expect(page.getByText("Bob Studio")).toHaveCount(0);
    }
  });
});

test.describe("AGO-82 AC1: onboarding creates exactly one workspace (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");

  test("AC1: a second tab submitting onboarding at the same time still gives one workspace", async ({
    context,
    page,
  }) => {
    const user = await createUser("tabs");
    const signIn = new SignInPage(page);
    await signIn.goto("/sign-in?next=%2Fapp");
    await signIn.signInWithMagicLink(user.email);
    const first = new WorkspacePage(page);
    await expect(first.nameInput).toBeVisible();
    const secondPage = await context.newPage();
    const second = new WorkspacePage(secondPage);
    await second.goto();
    await expect(second.nameInput).toBeVisible();
    await first.nameInput.fill("Tab One");
    await second.nameInput.fill("Tab Two");

    await Promise.all([first.createButton.click(), second.createButton.click()]);

    await expect(first.workspaceName).toBeVisible();
    await expect(second.workspaceName).toBeVisible();
    const memberships = await membershipsOf(user.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe("owner");
    const workspaces = await asServiceRole<unknown[]>(
      `/rest/v1/workspaces?id=eq.${memberships[0]?.workspace_id ?? ""}&select=id`,
    );
    expect(workspaces.body).toHaveLength(1);
    // Both tabs agree on which one it is.
    expect(await first.workspaceName.textContent()).toBe(await second.workspaceName.textContent());
  });

  test("AC1: parallel RPC calls from one user create one workspace and one owner membership", async () => {
    const user = await createUser("race");

    const ids = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        asUser<string>(user, "/rest/v1/rpc/onboard_current_user", {
          method: "POST",
          body: { p_workspace_name: `Race ${String(index)}` },
        }),
      ),
    );

    expect(new Set(ids.map((result) => result.status))).toEqual(new Set([200]));
    expect(new Set(ids.map((result) => result.body)).size).toBe(1);
    const memberships = await membershipsOf(user.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe("owner");
  });

  test("AC1 (negative): a blank or over-long workspace name creates nothing", async () => {
    const user = await createUser("names");

    for (const name of ["", "   ", "x".repeat(121)]) {
      const result = await asUser<{ code: string }>(user, "/rest/v1/rpc/onboard_current_user", {
        method: "POST",
        body: { p_workspace_name: name },
      });
      expect(result.status, `name of length ${String(name.length)}`).toBe(400);
      expect(result.body.code).toBe("22023");
    }

    expect(await membershipsOf(user.id)).toEqual([]);
  });

  test("AC1 (edge): an over-long name typed in the form is clamped to 120 characters, never stored longer", async ({
    page,
  }) => {
    const user = await createUser("longname");
    const signIn = new SignInPage(page);
    await signIn.goto("/sign-in?next=%2Fapp");
    await signIn.signInWithMagicLink(user.email);
    const workspace = new WorkspacePage(page);

    await workspace.nameInput.fill("y".repeat(121));
    await workspace.createButton.click();

    await expect(workspace.workspaceName).toHaveText("y".repeat(120));
    const [membership] = await membershipsOf(user.id);
    expect((await workspaceName(membership?.workspace_id ?? ""))?.length).toBe(120);
  });
});
