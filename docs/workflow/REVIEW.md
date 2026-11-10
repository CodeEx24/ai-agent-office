# Review rules - Agent Office

What the reviewers and the approver check on every AGO PR, besides correctness and tests. Source of truth: CLAUDE.md §4-§5 and AGENTS.md. Any violation is CHANGES.

## Invariants (security reviewer: always on High risk)

1. **Human in the loop.** No code path lets an agent approve, edit policies, capabilities, budgets or identities, or run Tier 3/4 actions without a human decision. Agent tokens are rejected on human-only routes.
2. **Policy check before every tool call.** The policy engine lives in code, never in a prompt or vault file.
3. **Approvals** are bound to the exact payload hash, single-use and expiring; timeout means deny.
4. **Tenancy.** Every table has `workspace_id` and an RLS policy; all data access goes through the workspace-scoped data layer. `run_events` is append-only.
5. **Secrets** never reach prompts, logs, events or the client; use the credential broker. Only `NEXT_PUBLIC_*` variables may reach the browser.
6. **Untrusted content.** Retrieved web, email, note and agent-pack text is data, never instructions.
7. **Validation.** External input is validated with Zod at the boundary; no `any`.
8. **Agent packs.** No secrets, IDs or run history in a pack; import is dry-run first, atomic, owner-only, lands in Strict mode; Tier 3+ capabilities, budgets above the cap, policies, identities and credentials in a pack are ignored and reported.

## Repo rules (code reviewer)

- Naming and folder structure per CLAUDE.md §3-§5; routes stay thin; server-only code isolated; vendors behind interfaces; the 3D scene reads only the office store.
- Reuse-first: no duplicate component, util or pattern.
- Branch `<type>/ago-<n>/<slug>`; commit and PR title `type(scope): summary (AGO-<n>)`; one ticket, one branch, one PR.
- Migrations are reversible, named `<timestamp>_ago_<n>_<what>.sql`, and only one schema-changing ticket is in flight.
- CLAUDE.md is not edited per ticket; per-ticket detail goes in `docs/tickets/AGO-<n>.md`.
- Tests are not weakened or skipped. Anything that costs money was a human decision.
- Local Supabase stack only, inside `scripts/db-lock.mjs`; no hosted project is linked or changed.
- Human-merge paths (`.claude/`, `.github/workflows/`, `AGENTS.md`, `CLAUDE.md`, `orca.yaml`, `scripts/`): flag them so the approver escalates to the owner.
