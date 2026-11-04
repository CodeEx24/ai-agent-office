## Ticket
AGO-### — <Jira link> · Wave <n> · Ticket notes: `docs/tickets/AGO-###.md`

## Acceptance criteria
<!-- Restate every AC from the ticket and how it is proven. -->
- [ ] AC1 — <criterion> → <test name / screenshot / command output>

## What changed
<!-- Short summary of the approach and the key files. -->

## Decisions taken
<!-- Each decision the agent made, the option chosen (recommended unless noted), and why. -->

## Checks
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass locally
- [ ] E2E run for critical paths (if touched)
- [ ] Migrations are reversible and every new table has `workspace_id` + an RLS policy (if DB touched)
- [ ] No secrets, IDs or tokens in code, logs, events or fixtures
- [ ] Policy check before every tool call, approvals bound to payload hash (if agent runtime touched)

## Risk and rollback
<!-- What could break and how to roll back. -->
