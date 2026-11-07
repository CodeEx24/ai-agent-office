import type { Locator, Page } from "@playwright/test";

/** Page object for the agent creation wizard `/app/agents/new` and the agent list `/app/agents`. */
export class AgentWizardPage {
  readonly form: Locator;
  readonly name: Locator;
  readonly role: Locator;
  readonly model: Locator;
  readonly prompt: Locator;
  readonly dailyBudget: Locator;
  readonly nextButton: Locator;
  readonly backButton: Locator;
  readonly createButton: Locator;
  readonly review: Locator;
  readonly formAlert: Locator;
  readonly agentList: Locator;

  constructor(private readonly page: Page) {
    this.form = page.getByRole("form", { name: "New agent" });
    this.name = page.getByLabel("Name", { exact: true });
    this.role = page.getByLabel("Role", { exact: true });
    this.model = page.getByLabel("Model", { exact: true });
    this.prompt = page.getByLabel("Prompt", { exact: true });
    this.dailyBudget = page.getByLabel(/Daily budget/);
    this.nextButton = page.getByRole("button", { name: "Next" });
    this.backButton = page.getByRole("button", { name: "Back" });
    this.createButton = page.getByRole("button", { name: "Create agent" });
    this.review = page.getByTestId("review");
    this.formAlert = this.form.getByRole("alert");
    this.agentList = page.getByTestId("agent-list");
  }

  async goto() {
    await this.page.goto("/app/agents/new");
  }

  /** The inline error element next to a field, e.g. `fieldError("name")`. */
  fieldError(field: string): Locator {
    return this.page.locator(`#agent-${field}-error`);
  }

  async fillBasics(values: { name: string; role?: string; model?: string; prompt?: string }) {
    await this.name.fill(values.name);
    await this.role.fill(values.role ?? "Researcher");
    await this.model.selectOption(values.model ?? "claude-haiku-5-5");
    await this.prompt.fill(values.prompt ?? "Find sources and summarise them.");
  }

  async next() {
    await this.nextButton.click();
  }

  /** Clicks Next `steps` times from the current step (the caller supplies valid input). */
  async advance(steps: number) {
    for (let i = 0; i < steps; i += 1) await this.next();
  }

  skill(name: RegExp | string): Locator {
    return this.page.getByRole("checkbox", { name });
  }

  capability(name: RegExp | string): Locator {
    return this.page.getByRole("checkbox", { name });
  }

  /** Overwrites a hidden input the browser posts, as someone with dev tools would. */
  async tamper(field: string, value: string) {
    await this.page.evaluate(
      ([fieldName, fieldValue]) => {
        const input = document.querySelector<HTMLInputElement>(`input[name="${fieldName}"]`);
        if (!input) throw new Error(`no hidden input named ${fieldName}`);
        input.value = fieldValue;
      },
      [field, value] as const,
    );
  }

  /** Adds a hidden input the form does not have (a field the schema does not know). */
  async inject(field: string, value: string) {
    await this.page.evaluate(
      ([fieldName, fieldValue]) => {
        const form = document.querySelector("form[aria-label='New agent']");
        if (!form) throw new Error("the wizard form is not on the page");
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
