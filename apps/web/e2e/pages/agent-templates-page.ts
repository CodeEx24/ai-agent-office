import type { Locator, Page } from "@playwright/test";

/** Page object for the one-click template gallery on the agent list `/app/agents` (AGO-136). */
export class AgentTemplatesPage {
  readonly gallery: Locator;
  readonly agentList: Locator;
  readonly alert: Locator;

  constructor(private readonly page: Page) {
    this.gallery = page.getByTestId("template-list");
    this.agentList = page.getByTestId("agent-list");
    this.alert = page.getByRole("alert");
  }

  async goto() {
    await this.page.goto("/app/agents");
  }

  createButton(templateName: string): Locator {
    return this.page.getByRole("button", { name: `Create ${templateName}`, exact: true });
  }

  /** The form behind one template card (its hidden inputs are what the browser posts). */
  form(templateName: string): Locator {
    return this.page.getByRole("form", { name: `Create ${templateName}` });
  }

  /** Overwrites a hidden input of one card, as someone with dev tools would. */
  async tamper(templateName: string, field: string, value: string) {
    await this.form(templateName)
      .locator(`input[name="${field}"]`)
      .evaluate((input, next) => {
        (input as HTMLInputElement).value = next;
      }, value);
  }

  /** Adds a hidden input the form does not have (a field the action's schema does not know). */
  async inject(templateName: string, field: string, value: string) {
    await this.form(templateName).evaluate(
      (form, [fieldName, fieldValue]) => {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = fieldName;
        input.value = fieldValue;
        form.appendChild(input);
      },
      [field, value] as const,
    );
  }
}
