import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({ enableCapabilityAction: vi.fn() }));

import { EnableCapabilityControl } from "./EnableCapabilityControl";

const BASE = {
  workspaceId: "12500000-0000-4000-8000-0000000000a1",
  capabilityId: "12500000-0000-4000-8000-0000000000c1",
  name: "Run code",
};

describe("EnableCapabilityControl", () => {
  it("disables the button and lists every failing check", () => {
    render(
      <EnableCapabilityControl
        {...BASE}
        isEnabled={false}
        blockedBy={["Sandbox hardened", "Credential broker in place"]}
      />,
    );
    expect(screen.getByRole("button", { name: "Enable" })).toBeDisabled();
    const list = screen.getByTestId("blocked-checks");
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Sandbox hardened", "Credential broker in place"]);
  });

  it("enables the button when nothing blocks it, and posts only the two ids", () => {
    render(<EnableCapabilityControl {...BASE} isEnabled={false} blockedBy={[]} />);
    expect(screen.getByRole("button", { name: "Enable" })).toBeEnabled();
    const form = screen.getByRole("form", { name: "Enable Run code" });
    const names = Array.from(form.querySelectorAll("input")).map((input) => input.name);
    expect(names.sort()).toEqual(["capabilityId", "workspaceId"]);
  });

  it("shows an enabled capability as enabled, with no button", () => {
    render(<EnableCapabilityControl {...BASE} isEnabled blockedBy={[]} />);
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
