import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createWorkspaceAction = vi.fn();

vi.mock("./actions", () => ({
  createWorkspaceAction: (...args: unknown[]) => createWorkspaceAction(...args) as unknown,
}));

import { OnboardingForm } from "./OnboardingForm";

describe("OnboardingForm (AGO-201)", () => {
  beforeEach(() => {
    createWorkspaceAction.mockReset();
  });

  it("starts with the suggested name", () => {
    render(<OnboardingForm defaultName="alex's workspace" />);
    expect(screen.getByLabelText("Workspace name")).toHaveValue("alex's workspace");
  });

  it("keeps what the user typed after a failed submit, and shows the error", async () => {
    createWorkspaceAction.mockResolvedValue({ error: "Something went wrong.", name: "Acme Labs" });
    const user = userEvent.setup();
    render(<OnboardingForm defaultName="alex's workspace" />);

    const input = screen.getByLabelText("Workspace name");
    await user.clear(input);
    await user.type(input, "Acme Labs");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong.");
    await waitFor(() => {
      expect(screen.getByLabelText("Workspace name")).toHaveValue("Acme Labs");
    });
  });
});
