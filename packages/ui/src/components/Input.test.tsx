import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Input } from "./Input";
import { Label } from "./Label";

describe("Input and Label", () => {
  it("associates the label with the input and accepts typing", async () => {
    render(
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" />
      </div>,
    );
    const input = screen.getByLabelText("Email");
    await userEvent.type(input, "a@b.co");
    expect(input).toHaveValue("a@b.co");
  });
});
