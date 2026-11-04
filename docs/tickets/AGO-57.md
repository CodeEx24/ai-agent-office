# AGO-57 - US-004 Scaffold the monorepo

## Overview
First code in the repo: a pnpm + Turborepo monorepo with `apps/web`, `apps/worker`, `packages/shared`, `packages/ui`, `packages/assets` and `vault-template/`. Jira: AGO-57, epic EP-00, wave 1. Kept to the scaffold only; the Next.js app, lint/test tooling, shadcn, Supabase and CI belong to AGO-61, AGO-111, AGO-115, AGO-78 and AGO-92.

## Implementation details
- Root: `package.json` (`packageManager` pnpm@10.17.1, `engines.node >=24`, scripts build/dev/typecheck/clean), `pnpm-workspace.yaml` (`apps/*`, `packages/*`), `turbo.json`, `tsconfig.base.json`, `README.md`.
- Each package is a minimal `@ago/*` TypeScript placeholder (`src/index.ts`, `tsconfig.json`, `tsconfig.build.json`) that builds with `tsc` to `dist/`.
- Path aliases: `tsconfig.base.json` `paths` maps `@ago/shared`, `@ago/ui`, `@ago/assets` to source; `workspace:*` deps link them for builds. Imports: ui -> shared; worker -> shared; web -> shared, ui, assets.
- `vault-template/` is a plain folder with a README (not a package).

### Decisions taken (recommended option chosen, no human available)
- TypeScript pinned to `~5.9.3` rather than 7.x: matches the Next 16 / React Compiler ecosystem; CLAUDE.md only requires "strict". Revisit in a tooling ticket.
- Placeholder packages are plain `tsc` builds (no bundler): smallest thing that builds, no locked-stack impact.
- Packages export built `dist/`; the alias to `src` is for type-check and editors only (`tsconfig.build.json` clears `paths`), so build output never reaches into sibling source.
- Supabase CLI not added: left to AGO-78 per coordinator note.
- No `lint`/`test` scripts: AGO-111 owns them, so those gates are skipped until then.

## API changes
None.

## Database changes
None.

## Dependencies on other tickets
Blocks AGO-61, AGO-78, AGO-111, AGO-143. No blockers.

## Known limitations
- Placeholder code only; no runtime behavior.
- `pnpm lint` and `pnpm test` do not exist yet.

## Testing notes
`pnpm install --frozen-lockfile && pnpm build && pnpm typecheck`. Verified locally with `pnpm build --force` (cache bypassed). A delete-everything clean-clone run was not done in this worktree because the permission prompt denied the `rm -rf`; CI (AGO-92) will cover the clean clone.

## Follow-up tasks
- AGO-111: add lint/format/test and root scripts.
- Revisit the TypeScript major once the Next.js app lands (AGO-61).

### QA follow-up tests (tester, no harness yet)
AGO-57 has no UI, so there are no Playwright specs to write. AC1 to AC3 were proven by hand from a clean clone (`pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm dev`, `pnpm clean`). To lock them in once AGO-111 (Vitest) and AGO-92 (CI) land, add:
- `AC1: clean clone installs and builds` - CI job: fresh checkout, `pnpm install --frozen-lockfile && pnpm build` exits 0 (AGO-92).
- `AC2: workspace packages import each other through the @ago aliases` - Vitest in `apps/worker`: `WORKER_NAME` equals `"@ago/worker (Agent Office)"`, which exercises `@ago/shared`. Compile-level negative: typecheck fails when an `@ago/shared` export is renamed.
- `AC3: README layout matches the repo` - Vitest: every path in the README Layout table exists, and every command listed under Commands is a root `package.json` script.
- `AC3: pnpm clean removes build output` - after `pnpm clean`, no package has a `dist/`.
- Note for the implementer: `pnpm dev` is a no-op (no package defines a `dev` task); the README says it runs every package's dev task.
