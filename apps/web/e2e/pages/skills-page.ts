import type { Locator, Page } from "@playwright/test";

/** Page object for the skill library: the list `/app/skills` and one skill `/app/skills/[skillId]`. */
export class SkillsPage {
  // List page
  readonly skillList: Locator;
  readonly newSkillForm: Locator;
  readonly newName: Locator;
  readonly newDescription: Locator;
  readonly newBody: Locator;
  readonly createButton: Locator;
  // One skill
  readonly name: Locator;
  readonly version: Locator;
  readonly editor: Locator;
  readonly body: Locator;
  readonly description: Locator;
  readonly preview: Locator;
  readonly saveButton: Locator;
  readonly saveStatus: Locator;
  readonly history: Locator;
  readonly assignments: Locator;
  readonly agentSelect: Locator;
  readonly assignButton: Locator;
  readonly noAssignments: Locator;
  readonly formAlert: Locator;

  constructor(private readonly page: Page) {
    this.skillList = page.getByTestId("skill-list");
    this.newSkillForm = page.getByRole("form", { name: "New skill" });
    this.newName = this.newSkillForm.getByLabel("Name", { exact: true });
    this.newDescription = this.newSkillForm.getByLabel("Description", { exact: true });
    this.newBody = this.newSkillForm.getByLabel("Skill text (Markdown)");
    this.createButton = page.getByRole("button", { name: "Create skill" });
    this.name = page.getByTestId("skill-name");
    this.version = page.getByTestId("skill-version");
    this.editor = page.getByRole("form", { name: "Edit skill" });
    this.body = page.getByLabel("Skill text (Markdown)");
    this.description = this.editor.getByLabel("Description", { exact: true });
    this.preview = page.getByRole("region", { name: "Preview" });
    this.saveButton = page.getByRole("button", { name: "Save" });
    this.saveStatus = page.getByTestId("save-status");
    this.history = page.getByTestId("version-history");
    this.assignments = page.getByTestId("assignments");
    this.agentSelect = page.getByLabel("Agent", { exact: true });
    this.assignButton = page.getByRole("button", { name: "Assign" });
    this.noAssignments = page.getByText("No agent has this skill yet.");
    this.formAlert = page.getByRole("alert");
  }

  async gotoList() {
    await this.page.goto("/app/skills");
  }

  async gotoSkill(skillId: string) {
    await this.page.goto(`/app/skills/${skillId}`);
  }

  versionEntry(version: number): Locator {
    return this.page.getByTestId(`version-${String(version)}`);
  }

  removeButton(agentName: string): Locator {
    return this.page.getByRole("button", { name: `Remove from ${agentName}` });
  }
}
