import type { Locator, Page } from "@playwright/test";

import { fetchMagicLink, fetchSignInCode } from "../support/live-stack";

/** Page object for `/sign-in`. Selectors live here, assertions stay in the spec. */
export class SignInPage {
  readonly heading: Locator;
  readonly emailInput: Locator;
  readonly sendCodeButton: Locator;
  readonly codeInput: Locator;
  readonly verifyButton: Locator;
  readonly googleButton: Locator;
  readonly githubButton: Locator;
  readonly alert: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByText("Sign in to Agent Office");
    this.emailInput = page.getByLabel("Email");
    this.sendCodeButton = page.getByRole("button", { name: "Email me a sign-in code" });
    this.codeInput = page.getByLabel("Code");
    this.verifyButton = page.getByRole("button", { name: "Sign in" });
    this.googleButton = page.getByRole("button", { name: "Continue with Google" });
    this.githubButton = page.getByRole("button", { name: "Continue with GitHub" });
    // Scoped to <main>: Next's route announcer is also role="alert".
    this.alert = page.getByRole("main").getByRole("alert");
  }

  async goto(path = "/sign-in") {
    await this.page.goto(path);
  }

  /** Requests a code for `email` and waits for the code step to appear. */
  async requestCode(email: string) {
    await this.emailInput.fill(email);
    await this.sendCodeButton.click();
    await this.codeInput.waitFor();
  }

  /**
   * Signs in with the magic link from the same email (same browser context, so the PKCE verifier
   * cookie is present). Works whichever email template the running Auth server uses.
   */
  async signInWithMagicLink(email: string) {
    await this.requestCode(email);
    await this.page.goto(await fetchMagicLink(email));
  }

  /** The full email flow: request a code, read it from the mail catcher, enter it. */
  async signInWithEmailCode(email: string) {
    await this.requestCode(email);
    await this.codeInput.fill(await fetchSignInCode(email));
    await this.verifyButton.click();
  }
}
