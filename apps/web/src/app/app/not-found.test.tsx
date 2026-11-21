import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import AppNotFound from "./not-found";

/** AGO-153 round 2, change 2: a missing run keeps the user inside the app with a way out. */
describe("app not-found page", () => {
  it("says the page could not be found without saying whether it exists elsewhere", () => {
    render(<AppNotFound />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "We couldn't find that page",
    );
    expect(document.body.textContent).toMatch(/may belong to another workspace/);
  });

  it("links back to the office and to the agents", () => {
    render(<AppNotFound />);
    const nav = screen.getByRole("navigation", { name: "Where to go next" });
    expect(nav).toContainElement(screen.getByRole("link", { name: "Back to the office" }));
    expect(screen.getByRole("link", { name: "Back to the office" })).toHaveAttribute(
      "href",
      "/app/office",
    );
    expect(screen.getByRole("link", { name: "See your agents" })).toHaveAttribute(
      "href",
      "/app/agents",
    );
  });

  it("does not render its own app shell, so the layout's header and sign-out stay the only ones", () => {
    const { container } = render(<AppNotFound />);
    expect(container.querySelector("header")).toBeNull();
    expect(container.querySelectorAll("main")).toHaveLength(1);
  });
});
