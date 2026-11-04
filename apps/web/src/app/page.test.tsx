import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import HomePage from "./page";

describe("HomePage", () => {
  it("renders the product heading and the theme toggle", () => {
    render(<HomePage />);
    expect(screen.getByRole("heading", { name: "Agent Office" })).toBeInTheDocument();
    expect(screen.getByTestId("theme-toggle")).toBeInTheDocument();
  });
});
