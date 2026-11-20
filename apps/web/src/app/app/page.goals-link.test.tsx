import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getActiveWorkspace: vi.fn(),
}));
vi.mock("../../features/auth/current-user", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("../../features/workspaces/workspace-access", () => ({
  getActiveWorkspace: mocks.getActiveWorkspace,
}));
vi.mock("../../features/control/KillSwitchControl", () => ({
  KillSwitchControl: () => <div data-testid="kill-switch" />,
}));
vi.mock("../../features/workspaces/OnboardingForm", () => ({
  OnboardingForm: () => <div data-testid="onboarding-form" />,
}));

import WorkspaceHomePage from "./page";

async function renderPage() {
  render(await WorkspaceHomePage());
}

beforeEach(() => {
  mocks.getCurrentUser.mockReset();
  mocks.getActiveWorkspace.mockReset();
  mocks.getCurrentUser.mockResolvedValue({ id: "u1", email: "alex@example.test" });
});

describe("AGO-113 dashboard link to the goal inbox (round 2)", () => {
  it.each(["viewer", "member", "owner"])("links to /app/goals for a %s", async (role) => {
    mocks.getActiveWorkspace.mockResolvedValue({ id: "w1", name: "Acme", role });
    await renderPage();
    expect(screen.getByRole("link", { name: "Goals" })).toHaveAttribute("href", "/app/goals");
  });

  it("keeps the other dashboard links next to the goals link", async () => {
    mocks.getActiveWorkspace.mockResolvedValue({ id: "w1", name: "Acme", role: "member" });
    await renderPage();
    expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute("href", "/app/agents");
    expect(screen.getByRole("link", { name: "Skills" })).toHaveAttribute("href", "/app/skills");
    expect(screen.getByRole("link", { name: "Approvals" })).toHaveAttribute(
      "href",
      "/app/approvals",
    );
  });

  it("shows no goals link when the user has no workspace yet", async () => {
    mocks.getActiveWorkspace.mockResolvedValue(null);
    await renderPage();
    expect(screen.getByTestId("onboarding-form")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Goals" })).not.toBeInTheDocument();
  });

  it("shows no goals link when nobody is signed in", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.getActiveWorkspace.mockResolvedValue(null);
    await renderPage();
    expect(mocks.getActiveWorkspace).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Goals" })).not.toBeInTheDocument();
  });
});
