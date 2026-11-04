# AGO-61 - US-005 Set up Next.js 16 on a patched release

## Overview
Turns the `apps/web` placeholder from AGO-57 into a Next.js 16 app. Jira: AGO-61, epic EP-00, wave 1. Blocked by AGO-57 (done). Out of scope: shadcn/design tokens (AGO-115), lint/format/test tooling (AGO-111), env validation (AGO-70), auth (AGO-67).

## Implementation details
- `apps/web/package.json`: `next` pinned exactly to `16.4.5` (latest patched 16.x on npm, above the 16.4.1 floor), `react`/`react-dom` `19.2.9`, `babel-plugin-react-compiler` `1.0.0`, `tailwindcss` and `@tailwindcss/postcss` `4.3.4`. Scripts: `dev`, `build`, `start`, `typecheck`, `clean`.
- `apps/web/next.config.ts`: `reactCompiler: true`. Turbopack is the default bundler in Next 16.
- `apps/web/tsconfig.json`: extends `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`), overrides module settings for the bundler and adds the Next plugin.
- App Router: `src/app/layout.tsx`, `src/app/page.tsx` (minimal page using Tailwind utilities), `src/app/globals.css` (`@import "tailwindcss"`), `postcss.config.mjs`.
- Removed the placeholder `src/index.ts` and `tsconfig.build.json` (Next builds itself).
- Root `turbo.json`: `build` outputs now include `.next/**` (minus cache); `dev` passes `PORT` through. Without the pass-through, Turbo's strict env mode drops `PORT` and the dev server silently binds 3000, which breaks parallel worktrees (found while testing).
- `pnpm dev` from the root now starts the web dev server, fixing the AGO-57 README note. README updated.

## API changes
None.

## Database changes
None.

## Dependencies on other tickets
Needs AGO-57 (monorepo). AGO-78 also touches root `package.json` and the lockfile; on conflict, merge main and regenerate the lockfile.

## Known limitations
- No lint, unit test or E2E scripts exist yet (AGO-111, AGO-118), so those gates were skipped.
- `@ago/*` workspace dependencies are declared but not imported by the page yet. They export built `dist/`, and Next needs `transpilePackages` or built output once the app imports them.
- The Playwright MCP could not launch (Chrome not installed on this machine), so the browser check was done at HTTP level (see Testing notes).

## Testing notes
- `pnpm typecheck` and `pnpm build` pass (Next 16.4.5 Turbopack build, `/` prerendered static).
- `PORT=3100 pnpm dev`: server reports `http://localhost:3100`; `/` HTML contains `text-emerald-400`, and the served CSS defines `emerald-400`, so Tailwind v4 is processing the stylesheet.
- Not verified: computed styles / screenshot in a real browser.

## Decisions taken (recommended option chosen, no human available)
- Pin `next` to exactly 16.4.5, not a caret range: AC says "pins" and the point is a patched release.
- React `19.2.9` (CLAUDE.md says 19.2) rather than the newer 19.3.x.
- Keep TypeScript at `~5.9.3` from AGO-57.
- Page uses only Tailwind utilities, no design tokens, to leave AGO-115 clear.
- `PORT` pass-through in Turbo rather than a custom dev script, so `pnpm dev` stays one command.

## Follow-up tasks
- AGO-111: add lint/format/test scripts. AGO-118: Playwright harness and an E2E for `/` Tailwind rendering.
- When the app first imports `@ago/*`, configure `transpilePackages` or switch to source exports.
