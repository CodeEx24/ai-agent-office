import type { Locator, Page } from "@playwright/test";

/** Page object for the protected landing page `/app`. */
export class WorkspacePage {
  readonly heading: Locator;
  readonly signedInEmail: Locator;
  readonly signOutButton: Locator;
  // Onboarding (a signed-in user with no workspace yet), AGO-82
  readonly nameInput: Locator;
  readonly createButton: Locator;
  // Resolved workspace (after onboarding)
  readonly workspaceName: Locator;
  readonly workspaceRole: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole("heading", { level: 1, name: "Your workspace" });
    this.signedInEmail = page.getByTestId("signed-in-email");
    this.signOutButton = page.getByRole("button", { name: "Sign out" });
    this.nameInput = page.getByLabel("Workspace name");
    this.createButton = page.getByRole("button", { name: "Create workspace" });
    this.workspaceName = page.getByTestId("workspace-name");
    this.workspaceRole = page.getByTestId("workspace-role");
  }

  async goto() {
    await this.page.goto("/app");
  }

  /** Completes onboarding with `name` and waits for the resolved workspace to show. */
  async createWorkspace(name: string) {
    await this.nameInput.fill(name);
    await this.createButton.click();
    await this.workspaceName.waitFor();
  }
}
