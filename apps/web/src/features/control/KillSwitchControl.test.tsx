import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KillSwitchControl } from "./KillSwitchControl";

const WORKSPACE = "84000000-0000-4000-8000-0000000000a1";
const AGENT = { id: "84000000-0000-4000-8000-0000000000a2", name: "Scout" };

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("KillSwitchControl", () => {
  it("never fires on one click: it asks first, and Cancel backs out without a request", async () => {
    const fetchMock = stubFetch(Response.json({}));
    render(<KillSwitchControl workspaceId={WORKSPACE} />);

    await userEvent.click(screen.getByRole("button", { name: "Kill switch" }));
    expect(screen.getByText(/stops every run of this workspace/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Kill switch" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts a workspace scope after confirmation and reports the counts", async () => {
    const fetchMock = stubFetch(
      Response.json({
        scope: "workspace",
        status: "active",
        runs_stopped: 3,
        credentials_revoked: 4,
      }),
    );
    render(<KillSwitchControl workspaceId={WORKSPACE} />);

    await userEvent.click(screen.getByRole("button", { name: "Kill switch" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm kill" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "3 runs are stopping and 4 credentials were revoked",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/control/kill",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ workspace_id: WORKSPACE, scope: "workspace" }),
      }),
    );
  });

  it("posts an agent scope when given an agent", async () => {
    const fetchMock = stubFetch(
      Response.json({ scope: "agent", status: "active", runs_stopped: 1, credentials_revoked: 1 }),
    );
    render(<KillSwitchControl workspaceId={WORKSPACE} agent={AGENT} />);

    await userEvent.click(screen.getByRole("button", { name: "Kill switch" }));
    expect(screen.getByText(/stops every run of agent Scout/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Confirm kill" }));

    await screen.findByRole("status");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/control/kill",
      expect.objectContaining({
        body: JSON.stringify({ workspace_id: WORKSPACE, scope: "agent", agent_id: AGENT.id }),
      }),
    );
  });

  it("says plainly when the caller is not an owner", async () => {
    stubFetch(Response.json({ error: "forbidden" }, { status: 403 }));
    render(<KillSwitchControl workspaceId={WORKSPACE} />);

    await userEvent.click(screen.getByRole("button", { name: "Kill switch" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm kill" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Only a workspace owner");
  });

  it("says nothing changed when the request cannot be reached, and lets the owner try again", async () => {
    stubFetch(new Error("offline"));
    render(<KillSwitchControl workspaceId={WORKSPACE} />);

    await userEvent.click(screen.getByRole("button", { name: "Kill switch" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm kill" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Nothing was changed");
    });
    expect(screen.getByRole("button", { name: "Kill switch" })).toBeInTheDocument();
  });
});
