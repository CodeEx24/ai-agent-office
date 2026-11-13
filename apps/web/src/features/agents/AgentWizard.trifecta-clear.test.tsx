import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { STARTER_CAPABILITIES } from "@ago/shared";

vi.mock("./actions", () => ({ createAgentAction: vi.fn() }));

import { AgentWizard, type WizardCapability } from "./AgentWizard";
import { createAgentAction } from "./actions";

const WORKSPACE = "13800000-0000-4000-8000-0000000000a2";
const ALL: WizardCapability[] = STARTER_CAPABILITIES.map((c) => ({
  key: c.key,
  name: c.name,
  description: c.description,
  tier: c.tier,
  defaultMode: c.defaultMode,
}));

const SEARCH = /Search the web/;
const PRIVATE = /Read own private notes/;
const MESSAGE = /Send outbound messages/;
const TASKS = /Manage tasks/;

type User = ReturnType<typeof userEvent.setup>;

function setup() {
  const user = userEvent.setup();
  render(<AgentWizard workspaceId={WORKSPACE} skills={[]} capabilities={ALL} />);
  return { user };
}

async function toCapabilities(user: User) {
  await user.type(screen.getByLabelText("Name"), "Scout");
  await user.type(screen.getByLabelText("Role"), "Researcher");
  await user.selectOptions(screen.getByLabelText("Model"), "claude-haiku-5-5");
  await user.type(screen.getByLabelText("Prompt"), "Find sources.");
  await user.click(screen.getByRole("button", { name: "Next" }));
  await user.click(screen.getByRole("button", { name: "Next" }));
}

async function tick(user: User, patterns: RegExp[]) {
  for (const p of patterns) await user.click(screen.getByRole("checkbox", { name: p }));
}

const next = (user: User) => user.click(screen.getByRole("button", { name: "Next" }));

beforeEach(() => {
  vi.mocked(createAgentAction).mockReset();
});

describe("AGO-138 AC1 round 2: the message follows the current selection", () => {
  it("lets the owner reach Create agent after removing a leg following a blocked Next", async () => {
    const { user } = setup();
    await toCapabilities(user);
    await tick(user, [SEARCH, PRIVATE, MESSAGE]);
    await next(user);
    expect(screen.getByRole("alert")).toHaveTextContent(/blocked/);

    await user.click(screen.getByRole("checkbox", { name: MESSAGE }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await next(user); // budget
    await next(user); // review
    expect(screen.getByRole("button", { name: "Create agent" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps Next blocked and the message shown when a leg is removed and ticked again before pressing Next", async () => {
    const { user } = setup();
    await toCapabilities(user);
    await tick(user, [SEARCH, PRIVATE, MESSAGE]);
    await next(user);
    await user.click(screen.getByRole("checkbox", { name: MESSAGE }));
    await user.click(screen.getByRole("checkbox", { name: MESSAGE }));
    expect(screen.getByRole("alert")).toHaveTextContent(/this combination is blocked/);
    await next(user);
    expect(screen.getByRole("heading", { name: "Capabilities" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create agent" })).not.toBeInTheDocument();
  });

  it("still shows the message when an unrelated neutral capability is ticked while blocked", async () => {
    const { user } = setup();
    await toCapabilities(user);
    await tick(user, [SEARCH, PRIVATE, MESSAGE]);
    await next(user);
    await user.click(screen.getByRole("checkbox", { name: TASKS }));
    expect(screen.getByRole("alert")).toHaveTextContent(/this combination is blocked/);
    await next(user);
    expect(screen.getByRole("heading", { name: "Capabilities" })).toBeInTheDocument();
  });

  it("shows exactly one alert while blocked, never the stale and the live message together", async () => {
    const { user } = setup();
    await toCapabilities(user);
    await tick(user, [SEARCH, PRIVATE, MESSAGE]);
    await next(user);
    await user.click(screen.getByRole("checkbox", { name: TASKS }));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });
});

describe("AGO-138 AC1 round 2: a server refusal on capabilities", () => {
  async function reachServerRefusal(user: User) {
    vi.mocked(createAgentAction).mockResolvedValue({
      fieldErrors: { capabilities: "Server refused this capability set." },
    });
    await toCapabilities(user);
    await tick(user, [SEARCH, PRIVATE]);
    await next(user); // budget
    await next(user); // review
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Capabilities" })).toBeInTheDocument(),
    );
  }

  it("shows the server message on the Capabilities step", async () => {
    const { user } = setup();
    await reachServerRefusal(user);
    expect(screen.getByRole("alert")).toHaveTextContent("Server refused this capability set.");
  });

  it("clears the server message once the selection changes", async () => {
    const { user } = setup();
    await reachServerRefusal(user);
    await user.click(screen.getByRole("checkbox", { name: TASKS }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("group")).not.toHaveAttribute("aria-describedby");
  });

  it("shows the live trifecta message, not the stale server one, when the change completes a trifecta", async () => {
    const { user } = setup();
    await reachServerRefusal(user);
    await user.click(screen.getByRole("checkbox", { name: MESSAGE }));
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(/this combination is blocked/);
    expect(alerts[0]).not.toHaveTextContent("Server refused");
  });
});

describe("AGO-138 AC2 round 2: a template then edits", () => {
  async function pickTemplate(user: User, id: string) {
    await user.selectOptions(screen.getByLabelText("Start from a template (optional)"), id);
    await next(user);
    await next(user);
  }

  it.each(["researcher", "analyst"])(
    "%s: removing a ticked leg after a blocked Next clears the message and Next moves on",
    async (id) => {
      const { user } = setup();
      await pickTemplate(user, id);
      for (const p of [SEARCH, PRIVATE, MESSAGE]) {
        const box = screen.getByRole("checkbox", { name: p });
        if (!(box as HTMLInputElement).checked) await user.click(box);
      }
      await next(user);
      expect(screen.getByRole("alert")).toHaveTextContent(/blocked/);

      await user.click(screen.getByRole("checkbox", { name: MESSAGE }));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await next(user);
      expect(screen.getByRole("heading", { name: "Budget" })).toBeInTheDocument();
    },
  );
});
