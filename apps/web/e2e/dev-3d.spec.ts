import { expect, test } from "./fixtures";

test.describe("/dev/3d", () => {
  // The console-error guard in ./fixtures fails this test on any console error or page error.
  test("loads the model and switches between idle and walk with no console errors", async ({
    page,
  }) => {
    const response = await page.goto("/dev/3d");

    expect(response?.ok()).toBe(true);
    await expect(page.getByRole("heading", { name: "3D model test page" })).toBeVisible();
    await expect(page.locator("canvas")).toBeVisible();

    // Stats only render once the GLB has loaded and been parsed.
    const stats = page.getByTestId("dev-3d-stats");
    await expect(stats).not.toContainText("loading", { timeout: 30_000 });
    await expect(stats).toContainText(/idle/i);
    await expect(stats).toContainText(/walk/i);

    const walk = page.getByRole("button", { name: "Walk" });
    await walk.click();
    await expect(walk).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Idle" }).click();
    await expect(page.getByRole("button", { name: "Idle" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
