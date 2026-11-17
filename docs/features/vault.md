# Vault service
Tickets: AGO-121 (US-055, epic EP-05)

## What it does
Every workspace has its own git repository holding its Markdown vault, built from `vault-template/`. All reads and writes go through one service, `VaultStore`; nothing else touches the repo. Each change is a git commit whose author says whether a person or an agent made it. Agents cannot write `_meta/AGENTS.md` or other boot files.

## Starter layout
`_meta/` (`AGENTS.md`, `README.md`), `agents/`, `skills/`, `projects/`, `tasks/`, `inbox/`, `logs/`. The template lives in `vault-template/`; a new vault is an exact copy plus one `Initialize vault` commit.

## Configuration
| Env var | Meaning | Default |
|---|---|---|
| `VAULT_ROOT_DIR` | Folder holding one repo per workspace (`<root>/<workspace_id>`) | `.vault-data` (git-ignored) |
| `VAULT_TEMPLATE_DIR` | Starter layout to copy | `vault-template/` at the repo root |

The worker host needs the `git` CLI. Use `loadVaultConfig(env)` to read both.

## Data model
No database tables. The repo location is derived from the workspace id (a UUID, lower-cased), so there is no registry to keep in step.

## Using it
```ts
const store = new GitVaultStore(loadVaultConfig(process.env));
await store.write({ workspaceId, principal: { kind: "human", userId }, path: "projects/plan.md", content });
await store.read({ workspaceId, path: "projects/plan.md" });
await store.list({ workspaceId, dir: "projects" });
await store.history({ workspaceId, path: "projects/plan.md" });
```
Every call returns `{ ok: true, value }` or `{ ok: false, reason }`. Reasons: `invalid_workspace`, `invalid_path`, `invalid_principal`, `human_only_path`, `symlink_not_allowed`, `not_found`, `not_a_file`, `too_large`, `invalid_content`, `store_failed`. A denial never carries note text.

## Provisioning
Lazy and idempotent: the first call for a workspace creates the repo; later calls find it. The repo is built in a temp folder and renamed into place, so callers racing on first access (even from several processes) never produce a half-built or double-initialised repo. `ensureVault(workspaceId)` is exported for the workspace-creation flow to call later.

## Security rules
- **Confinement:** paths are checked lexically (no `..`, absolute, drive or UNC form, backslash, NUL or control characters, `.git`, NTFS short or device names) and then on disk (a symlink anywhere on the path is refused).
- **Isolation:** the repo folder comes only from a validated UUID; a caller can never pass a location.
- **Human-only boot files:** an agent principal cannot write or remove `_meta/AGENTS.md`, any `AGENTS.md`, `CLAUDE.md`, `BOOT.md`, or anything in `_boot/` or `.claude/` (same rule as the self-modification guard, AGO-154). Agents can read them. The principal comes from trusted code, never from note text.
- **Git safety:** no shell; fixed subcommands; user text only after `--` or on stdin; no user or system git config; hooks never run.
- **Provenance seam:** the git author is `human:<id>` or `agent:<id>`, with an `Agent-Run:` trailer when a run id is known. `history()` returns it parsed.

## Main files
- `apps/worker/src/vault/vault-store.ts`: the `VaultStore` interface.
- `apps/worker/src/vault/git-vault-store.ts`: the git backend.
- `apps/worker/src/vault/vault-config.ts`: `loadVaultConfig`.
- `packages/shared/src/vault/vault-schemas.ts`: path check, principal, layout constants.
- `vault-template/`: the starter vault.

## Known limitations
- Needs `git` on the worker host and in the container image (deploy follow-up).
- The symlink check is lstat-based; the repo folder is service-owned and must not be writable by other processes.
- Writes are serialised in one process only; run one worker per vault root until a cross-process lock exists. The store assumes one worker per vault root until follow-up F1 (a failed-write rollback could otherwise overwrite another worker's commit).
- Agents can still write `.gitignore` and `.gitattributes`, which can make later writes fail in that workspace (a person can repair it); follow-up F3.
- Names with `~<digit>` and Windows device names are refused.

## Follow-ups
AGO-144 (write tool with checkpoints), AGO-165 (provenance), AGO-109 (backups); call `ensureVault` from workspace creation; add git to the worker image; document `VAULT_ROOT_DIR` in `.env.example`.
