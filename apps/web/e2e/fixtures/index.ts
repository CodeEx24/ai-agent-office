import { test as base, expect } from "@playwright/test";

// Shared test entry point: every spec imports `test` and `expect` from here, never from
// "@playwright/test" directly, so cross-cutting guards apply to all specs.
//
// Add new fixtures here (for example a signed-in page once auth state exists, AGO-67).

/**
 * Fails the test when the page logs a console error or throws an uncaught exception.
 * Automatic: no spec has to opt in. A spec that expects an error must say so in its own
 * assertions and filter it out through `allowedConsoleErrors`.
 */
interface Fixtures {
  allowedConsoleErrors: RegExp[];
  consoleErrorGuard: undefined;
}

export const test = base.extend<Fixtures>({
  allowedConsoleErrors: [[], { option: true }],

  consoleErrorGuard: [
    // The fixture callback is named `run` (not `use`): eslint-plugin-react-hooks treats `use(...)` as a hook.
    async ({ page, allowedConsoleErrors }, run) => {
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const text = message.text();
        if (allowedConsoleErrors.some((pattern) => pattern.test(text))) return;
        errors.push(`console.error: ${text} (${message.location().url})`);
      });
      page.on("pageerror", (error) => {
        errors.push(`pageerror: ${error.message}`);
      });

      await run(undefined);

      expect(errors, "the page must not log console errors or throw").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
