import type { Locator, Page } from "@playwright/test";

/** Page object for `/`. Add one file per route; keep selectors here, assertions in the spec. */
export class HomePage {
  readonly heading: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole("heading", { level: 1, name: "Agent Office" });
  }

  async goto() {
    await this.page.goto("/");
  }
}
