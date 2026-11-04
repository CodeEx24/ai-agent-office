import { expect, test } from "./fixtures";
import { HomePage } from "./pages/home-page";

test.describe("smoke", () => {
  // The console-error guard in ./fixtures fails this test on any console error or page error.
  test("home page loads with its title and heading", async ({ page }) => {
    const home = new HomePage(page);

    const response = await page.goto("/");

    expect(response?.ok()).toBe(true);
    await expect(page).toHaveTitle("Agent Office");
    await expect(home.heading).toBeVisible();
  });
});
