import type { Locator, Page } from "@playwright/test";

/** Page object for the protected landing page `/app`. */
export class WorkspacePage {
  readonly heading: Locator;
  readonly signedInEmail: Locator;
  readonly signOutButton: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole("heading", { level: 1, name: "Your workspace" });
    this.signedInEmail = page.getByTestId("signed-in-email");
    this.signOutButton = page.getByRole("button", { name: "Sign out" });
  }

  async goto() {
    await this.page.goto("/app");
  }
}
