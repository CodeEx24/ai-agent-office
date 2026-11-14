import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({
  archiveAgentAction: vi.fn(),
  duplicateAgentAction: vi.fn(),
  unarchiveAgentAction: vi.fn(),
}));

import { AgentRowActions } from "./AgentRowActions";

const WORKSPACE = "89000000-0000-4000-8000-0000000000a1";
const AGENT_ID = "89000000-0000-4000-8000-0000000000b1";

function setup(isArchived: boolean) {
  return render(
    <AgentRowActions workspaceId={WORKSPACE} agent={{ id: AGENT_ID, name: "Scout", isArchived }} />,
  );
}

describe("AgentRowActions", () => {
  it("offers edit, duplicate and archive for an active agent", () => {
    setup(false);
    expect(screen.getByRole("link", { name: "Edit Scout" })).toHaveAttribute(
      "href",
      `/app/agents/${AGENT_ID}`,
    );
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(screen.getByText("Duplicate Scout")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unarchive" })).not.toBeInTheDocument();
  });

  it("offers view and unarchive, but no duplicate, for an archived agent", () => {
    setup(true);
    expect(screen.getByRole("link", { name: "View Scout" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unarchive" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.queryByText("Duplicate Scout")).not.toBeInTheDocument();
  });

  it("proposes a name for the copy and says it starts in Strict mode", () => {
    setup(false);
    const form = screen.getByRole("form", { name: "Duplicate Scout", hidden: true });
    expect(within(form).getByLabelText("Name of the copy", { selector: "input" })).toHaveValue(
      "Scout copy",
    );
    expect(form).toHaveTextContent(/starts in Strict mode/);
    expect(form).toHaveTextContent(/same settings, skills and capabilities/);
  });

  it("sends only the ids from the archive form, never a status or an archive time", () => {
    const view = setup(false);
    const form = view.container.querySelector<HTMLFormElement>('form[aria-label="Archive Scout"]');
    if (!form) throw new Error("archive form not found");
    const names = [...form.querySelectorAll("input")].map((input) => input.name).sort();
    expect(names).toEqual(["agentId", "workspaceId"]);
  });
});
