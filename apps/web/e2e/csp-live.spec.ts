import { expect, isLiveStack, test } from "./fixtures";
import { uniqueEmail } from "./support/live-stack";
import { SignInPage } from "./pages/sign-in-page";
import { WorkspacePage } from "./pages/workspace-page";

// AGO-66 AC3 on the signed-in surface: /app renders, hydrates and completes a server action under
// the CSP, with Supabase auth traffic allowed by connect-src. Needs the local stack (E2E_SUPABASE=1).
test.describe("AGO-66 CSP on /app (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");

  test("/app serves the CSP, hydrates and the onboarding action works with no CSP errors", async ({
    page,
  }) => {
    const email = uniqueEmail("csp");
    const documentCsp: string[] = [];
    page.on("response", (response) => {
      if (response.request().resourceType() === "document") {
        documentCsp.push(response.headers()["content-security-policy"] ?? "");
      }
    });

    await new SignInPage(page).goto("/sign-in?next=%2Fapp");
    await new SignInPage(page).signInWithMagicLink(email);
    const workspace = new WorkspacePage(page);
    await expect(workspace.heading).toBeVisible();

    // A client-driven server action (useActionState) only works if hydration succeeded.
    await workspace.createWorkspace("CSP Check");
    await expect(workspace.workspaceName).toHaveText("CSP Check");

    const appCsp = documentCsp.at(-1) ?? "";
    // 'wasm-unsafe-eval' follows 'strict-dynamic' (meshopt GLBs decode in WebAssembly).
    expect(appCsp).toMatch(
      /script-src 'self' 'nonce-[^']+' 'strict-dynamic' 'wasm-unsafe-eval'(;|$)/,
    );
    expect(appCsp).toContain("http://127.0.0.1:44321");
  });
});
