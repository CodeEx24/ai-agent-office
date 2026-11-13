import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({ createAgentAction: vi.fn() }));

import { AgentWizard, type WizardCapability, type WizardSkill } from "./AgentWizard";

const WORKSPACE = "14100000-0000-4000-8000-0000000000a1";
const SKILLS: WizardSkill[] = [
  { id: "14100000-0000-4000-8000-0000000000b1", name: "Research summary", description: "" },
];
const CAPABILITIES: WizardCapability[] = [
  { key: "vault.read", name: "Read notes", description: "", tier: 0, defaultMode: "automatic" },
  { key: "email.send", name: "Send email", description: "", tier: 3, defaultMode: "approval" },
];
const TRIFECTA_CAPABILITIES: WizardCapability[] = [
  { key: "web.search", name: "Search the web", description: "", tier: 1, defaultMode: "automatic" },
  {
    key: "vault.read_private",
    name: "Read own private notes",
    description: "",
    tier: 0,
    defaultMode: "automatic",
  },
  {
    key: "message.send_outbound",
    name: "Send outbound messages",
    description: "",
    tier: 3,
    defaultMode: "approval",
  },
];

function setup(capabilities: WizardCapability[] = CAPABILITIES) {
  const user = userEvent.setup();
  const view = render(
    <AgentWizard workspaceId={WORKSPACE} skills={SKILLS} capabilities={capabilities} />,
  );
  const hidden = (name: string): string => {
    const input = view.container.querySelector<HTMLInputElement>(
      `input[type="hidden"][name="${name}"]`,
    );
    if (!input) throw new Error(`hidden input ${name} not found`);
    return input.value;
  };
  return { user, hidden };
}

async function fillBasics(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Name"), "Scout");
  await user.type(screen.getByLabelText("Role"), "Researcher");
  await user.selectOptions(screen.getByLabelText("Model"), "claude-haiku-5-5");
  await user.type(screen.getByLabelText("Prompt"), "Find sources.");
}

describe("AgentWizard", () => {
  it("starts on the basics step with no model preselected", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Basics" })).toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toHaveValue("");
  });

  it("names the field in each error, shows it next to the field and focuses the first one", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Next" }));

    for (const [label, text] of [
      ["Name", "Name is required"],
      ["Role", "Role is required"],
      ["Model", "Model is required"],
      ["Prompt", "Prompt is required"],
    ] as const) {
      const field = screen.getByLabelText(label);
      expect(field).toHaveAttribute("aria-invalid", "true");
      const messageId = field.getAttribute("aria-describedby") ?? "";
      expect(document.getElementById(messageId)).toHaveTextContent(text);
    }
    expect(screen.getByLabelText("Name")).toHaveFocus();
    expect(screen.getByRole("heading", { name: "Basics" })).toBeInTheDocument();
  });

  it("refuses a zero or too large daily budget and says which field", async () => {
    const { user } = setup();
    await fillBasics(user);
    await user.click(screen.getByRole("button", { name: "Next" })); // skills
    await user.click(screen.getByRole("button", { name: "Next" })); // capabilities
    await user.click(screen.getByRole("button", { name: "Next" })); // budget

    const budget = screen.getByLabelText(/Daily budget/);
    expect(budget).toHaveValue("5.00");
    await user.clear(budget);
    await user.type(budget, "0");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Daily budget must be more than $0.");
    expect(budget).toHaveFocus();

    await user.clear(budget);
    await user.type(budget, "500");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Daily budget can be at most $50.00.");
  });

  it("keeps the draft when going back and forward", async () => {
    const { user } = setup();
    await fillBasics(user);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Skills" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Scout");
    expect(screen.getByLabelText("Model")).toHaveValue("claude-haiku-5-5");
  });

  it("offers no 'automatic' choice for a Tier 3 capability and sends it as approval", async () => {
    const { user, hidden } = setup();
    await fillBasics(user);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));

    await user.click(screen.getByRole("checkbox", { name: /Send email/ }));
    expect(screen.getByText("Needs approval every time")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Send email: Runs/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /Read notes/ }));
    const lowTierMode = screen.getByLabelText(/Read notes: Runs/);
    expect(lowTierMode).toHaveValue("automatic");

    expect(JSON.parse(hidden("capabilities"))).toEqual([
      { key: "email.send", mode: "approval" },
      { key: "vault.read", mode: "automatic" },
    ]);
  });

  it("reviews everything, including Strict mode, before creating", async () => {
    const { user, hidden } = setup();
    await fillBasics(user);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("checkbox", { name: /Research summary/ }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByRole("heading", { name: "Review" })).toBeInTheDocument();
    const review = screen.getByTestId("review");
    expect(review).toHaveTextContent("Scout");
    expect(review).toHaveTextContent("Researcher");
    expect(review).toHaveTextContent("Research summary");
    expect(review).toHaveTextContent("$5.00");
    expect(review).toHaveTextContent("Strict");
    expect(screen.getByRole("button", { name: "Create agent" })).toBeInTheDocument();
    expect(JSON.parse(hidden("skillIds"))).toEqual([SKILLS[0]?.id]);
    // the form has no field through which a mode could be chosen
    expect(hidden("name")).toBe("Scout");
    expect(document.querySelector('[name="mode"]')).toBeNull();
  });

  it("moves on with Enter in a field instead of submitting early", async () => {
    const { user } = setup();
    await fillBasics(user);
    await user.type(screen.getByLabelText("Name"), "{Enter}");
    expect(screen.getByRole("heading", { name: "Skills" })).toBeInTheDocument();
  });

  describe("template picker (AGO-136)", () => {
    const WITH_TEMPLATE_KEYS: WizardCapability[] = [
      ...CAPABILITIES,
      {
        key: "tasks.manage",
        name: "Manage tasks",
        description: "",
        tier: 1,
        defaultMode: "automatic",
      },
      { key: "code.run", name: "Run code", description: "", tier: 3, defaultMode: "approval" },
    ];

    it("starts with no template and pre-fills every basic field when one is chosen", async () => {
      const { user } = setup(WITH_TEMPLATE_KEYS);
      const picker = screen.getByLabelText("Start from a template (optional)");
      expect(picker).toHaveValue("");

      await user.selectOptions(picker, "researcher");
      expect(screen.getByLabelText("Name")).toHaveValue("Researcher");
      expect(screen.getByLabelText("Role")).toHaveValue("Researcher");
      expect(screen.getByLabelText("Model")).toHaveValue("claude-sonnet-5-5");
      expect(screen.getByLabelText("Prompt")).toHaveDisplayValue(/You are a Researcher/);
    });

    it("keeps everything editable after a template is chosen", async () => {
      const { user } = setup(WITH_TEMPLATE_KEYS);
      await user.selectOptions(screen.getByLabelText("Start from a template (optional)"), "writer");
      const name = screen.getByLabelText("Name");
      await user.clear(name);
      await user.type(name, "Editor");
      expect(name).toHaveValue("Editor");
    });

    it("pre-ticks the template's capabilities, still reviewable, and forces Tier 3 to approval", async () => {
      const { user, hidden } = setup(WITH_TEMPLATE_KEYS);
      await user.selectOptions(
        screen.getByLabelText("Start from a template (optional)"),
        "developer",
      );
      expect(JSON.parse(hidden("capabilities"))).toEqual([
        { key: "vault.read", mode: "automatic" },
        { key: "code.run", mode: "approval" },
      ]);
      expect(hidden("dailyBudget")).toBe("10.00");

      await user.click(screen.getByRole("button", { name: "Next" })); // skills
      await user.click(screen.getByRole("button", { name: "Next" })); // capabilities
      expect(screen.getByRole("checkbox", { name: /Run code/ })).toBeChecked();
      expect(screen.getByText("Needs approval every time")).toBeInTheDocument();
    });

    it("leaves out a capability the workspace does not offer", async () => {
      const { user, hidden } = setup(); // no tasks.manage in this workspace
      await user.selectOptions(
        screen.getByLabelText("Start from a template (optional)"),
        "manager",
      );
      expect(JSON.parse(hidden("capabilities"))).toEqual([
        { key: "vault.read", mode: "automatic" },
      ]);
    });

    it("never sends a mode: the agent still starts in Strict mode", async () => {
      const { user } = setup(WITH_TEMPLATE_KEYS);
      await user.selectOptions(
        screen.getByLabelText("Start from a template (optional)"),
        "analyst",
      );
      for (let i = 0; i < 4; i += 1) {
        await user.click(screen.getByRole("button", { name: "Next" }));
      }
      expect(screen.getByTestId("review")).toHaveTextContent("Strict");
      expect(document.querySelector('[name="mode"]')).toBeNull();
      expect(document.querySelector('[name="templateId"]')).toBeNull();
    });
  });

  describe("trifecta lint (AGO-138)", () => {
    async function toCapabilities(user: ReturnType<typeof userEvent.setup>) {
      await fillBasics(user);
      await user.click(screen.getByRole("button", { name: "Next" })); // skills
      await user.click(screen.getByRole("button", { name: "Next" })); // capabilities
    }

    it("explains the block as soon as all three are ticked and keeps Next from moving on", async () => {
      const { user } = setup(TRIFECTA_CAPABILITIES);
      await toCapabilities(user);
      await user.click(screen.getByLabelText(/Search the web/));
      await user.click(screen.getByLabelText(/Read own private notes/));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await user.click(screen.getByLabelText(/Send outbound messages/));

      expect(screen.getByRole("alert")).toHaveTextContent(/this combination is blocked/);
      expect(screen.getByRole("alert")).toHaveTextContent("Search the web");
      await user.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByRole("heading", { name: "Capabilities" })).toBeInTheDocument();
      expect(screen.getByRole("group")).toHaveAttribute(
        "aria-describedby",
        "agent-capabilities-error",
      );
    });

    it("lets the owner continue after one of the three is removed", async () => {
      const { user } = setup(TRIFECTA_CAPABILITIES);
      await toCapabilities(user);
      for (const name of [/Search the web/, /Read own private notes/, /Send outbound messages/]) {
        await user.click(screen.getByLabelText(name));
      }
      await user.click(screen.getByLabelText(/Send outbound messages/));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByRole("heading", { name: "Budget" })).toBeInTheDocument();
    });
  });
});
