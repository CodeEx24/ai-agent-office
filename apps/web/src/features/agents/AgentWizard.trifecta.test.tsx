import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { STARTER_CAPABILITIES } from "@ago/shared";

vi.mock("./actions", () => ({ createAgentAction: vi.fn() }));

import { AgentWizard, type WizardCapability } from "./AgentWizard";

const WORKSPACE = "13800000-0000-4000-8000-0000000000a1";
const ALL: WizardCapability[] = STARTER_CAPABILITIES.map((c) => ({
  key: c.key,
  name: c.name,
  description: c.description,
  tier: c.tier,
  defaultMode: c.defaultMode,
}));

function setup() {
  const user = userEvent.setup();
  const view = render(<AgentWizard workspaceId={WORKSPACE} skills={[]} capabilities={ALL} />);
  const hidden = (name: string): string => {
    const input = view.container.querySelector<HTMLInputElement>(
      `input[type="hidden"][name="${name}"]`,
    );
    if (!input) throw new Error(`hidden input ${name} not found`);
    return input.value;
  };
  return { user, hidden };
}

type User = ReturnType<typeof userEvent.setup>;

async function toCapabilities(user: User) {
  await user.type(screen.getByLabelText("Name"), "Scout");
  await user.type(screen.getByLabelText("Role"), "Researcher");
  await user.selectOptions(screen.getByLabelText("Model"), "claude-haiku-5-5");
  await user.type(screen.getByLabelText("Prompt"), "Find sources.");
  await user.click(screen.getByRole("button", { name: "Next" })); // skills
  await user.click(screen.getByRole("button", { name: "Next" })); // capabilities
}

// Checkbox accessible names start with the capability name (matched by pattern below).
const SEARCH = /Search the web/;
const BROWSE = /Browse the web/;
const PRIVATE = /Read own private notes/;
const SHARED = /Read shared notes/;
const MESSAGE = /Send outbound messages/;
const INTEGRATION = /Write to integrations/;

async function tickPattern(user: User, patterns: RegExp[]) {
  for (const pattern of patterns) await user.click(screen.getByRole("checkbox", { name: pattern }));
}

describe("AGO-138 AC1 in the wizard: all three legs are blocked with an explanation", () => {
  it.each([
    ["web.search + vault.read_private + message.send_outbound", [SEARCH, PRIVATE, MESSAGE]],
    ["web.browse + vault.read + integration.write", [BROWSE, SHARED, INTEGRATION]],
    ["web.search + vault.read + integration.write", [SEARCH, SHARED, INTEGRATION]],
    ["web.browse + vault.read_private + message.send_outbound", [BROWSE, PRIVATE, MESSAGE]],
  ])("blocks %s and Next stays on Capabilities", async (_name, patterns) => {
    const { user } = setup();
    await toCapabilities(user);
    await tickPattern(user, patterns);

    expect(screen.getByRole("alert")).toHaveTextContent(
      /^Capabilities: this combination is blocked/,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/Remove at least one/);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Capabilities" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create agent" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/blocked/);
  });

  it("marks the capabilities group as described by the explanation while blocked, and clears it after", async () => {
    const { user } = setup();
    await toCapabilities(user);
    await tickPattern(user, [SEARCH, PRIVATE, MESSAGE]);
    const group = screen.getByRole("group");
    const messageId = group.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(messageId)).toHaveTextContent(/this combination is blocked/);

    await user.click(screen.getByRole("checkbox", { name: MESSAGE }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(group).not.toHaveAttribute("aria-describedby");
  });

  it("keeps the explanation when a second Next is pressed (the block cannot be clicked through)", async () => {
    const { user } = setup();
    await toCapabilities(user);
    await tickPattern(user, [SEARCH, PRIVATE, MESSAGE]);
    for (let i = 0; i < 3; i += 1) await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Capabilities" })).toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("blocks again when a removed leg is ticked back", async () => {
    const { user } = setup();
    await toCapabilities(user);
    await tickPattern(user, [SEARCH, PRIVATE, MESSAGE]);
    await user.click(screen.getByRole("checkbox", { name: SEARCH }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: SEARCH }));
    expect(screen.getByRole("alert")).toHaveTextContent(/this combination is blocked/);
  });

  it("still sends the trifecta in the hidden field (the server, not the form, is the guard) but Create is out of reach", async () => {
    const { user, hidden } = setup();
    await toCapabilities(user);
    await tickPattern(user, [SEARCH, PRIVATE, MESSAGE]);
    expect(JSON.parse(hidden("capabilities"))).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Create agent" })).not.toBeInTheDocument();
  });
});

describe("AGO-138 AC1 edge cases in the wizard: two legs, one leg, none", () => {
  it.each([
    ["untrusted + private", [SEARCH, PRIVATE]],
    ["untrusted + outbound", [SEARCH, MESSAGE]],
    ["private + outbound", [PRIVATE, MESSAGE]],
    ["browse + shared notes + no outbound", [BROWSE, SHARED]],
    ["both keys of the outbound leg only", [MESSAGE, INTEGRATION]],
    ["one leg", [SEARCH]],
  ])("allows %s: no alert and Next moves to Budget", async (_name, patterns) => {
    const { user } = setup();
    await toCapabilities(user);
    await tickPattern(user, patterns);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Budget" })).toBeInTheDocument();
  });

  it("allows no capabilities at all", async () => {
    const { user } = setup();
    await toCapabilities(user);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Budget" })).toBeInTheDocument();
  });

  it("does not block neutral capabilities ticked beside two legs", async () => {
    const { user } = setup();
    await toCapabilities(user);
    await tickPattern(user, [SEARCH, PRIVATE, /Manage tasks/]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("AGO-138 AC2 in the wizard: the Researcher and the Analyst templates are not blocked", () => {
  it.each(["researcher", "analyst"])("picking %s leaves no alert and Next moves on", async (id) => {
    const { user } = setup();
    await user.selectOptions(screen.getByLabelText("Start from a template (optional)"), id);
    await user.click(screen.getByRole("button", { name: "Next" })); // skills
    await user.click(screen.getByRole("button", { name: "Next" })); // capabilities
    expect(screen.getByRole("heading", { name: "Capabilities" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Budget" })).toBeInTheDocument();
  });

  it("a template followed by ticking the one missing leg becomes blocked (Researcher + private notes)", async () => {
    const { user } = setup();
    await user.selectOptions(
      screen.getByLabelText("Start from a template (optional)"),
      "researcher",
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    // The Researcher holds web; add private notes and outbound until all three are present.
    for (const pattern of [PRIVATE, MESSAGE, SEARCH]) {
      const box = screen.getByRole("checkbox", { name: pattern });
      if (!(box as HTMLInputElement).checked) await user.click(box);
    }
    expect(screen.getByRole("alert")).toHaveTextContent(/this combination is blocked/);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Capabilities" })).toBeInTheDocument();
  });
});
