import { expect, test } from "./fixtures";
import { HomePage } from "./pages/home-page";

// AGO-118 acceptance criteria that a user (or CI) can observe in the running production build.
test.describe("AGO-118 harness", () => {
  test("AC1: the home page loads on the production build with no console errors", async ({
    page,
  }) => {
    const home = new HomePage(page);
    const websockets: string[] = [];
    page.on("websocket", (socket) => websockets.push(socket.url()));

    const response = await page.goto("/");

    expect(response?.ok()).toBe(true);
    await expect(page).toHaveTitle("Agent Office");
    await expect(home.heading).toBeVisible();
    // `next dev` opens an HMR websocket; `next start` (the production build) never does.
    expect(websockets, "the app under test must be a production build, not next dev").toEqual([]);
  });

  test.describe("unknown route", () => {
    // The browser logs the 404 itself as a "Failed to load resource" console error.
    test.use({ allowedConsoleErrors: [/Failed to load resource.*404/] });

    test("AC1: an unknown route returns 404 and the app stays up", async ({ page }) => {
      const missing = await page.goto("/this-route-does-not-exist");
      expect(missing?.status()).toBe(404);

      const home = new HomePage(page);
      const response = await page.goto("/");
      expect(response?.ok()).toBe(true);
      await expect(home.heading).toBeVisible();
    });
  });
});
