# AGO-51 - US-043 Guarantee timeout means deny

- Ticket: https://stratyge.atlassian.net/browse/AGO-51 (Story, Epic EP-16, wave 2, WS-E, sprint 9)
- PRs: https://github.com/CodeEx24/ai-agent-office/pull/66
- Blocked by: AGO-21 (approval request flow, done). Unblocks AGO-162 (Phase 1 gate). Builds on AGO-47 (merged, e694493).
- Risk: **high** (human-in-the-loop invariant: timeout means deny)
- Status: In progress (record accepted by the owner via the orchestrator, 2026-11-14)

## Overview
"As the product owner, I want: guarantee timeout means deny. Ensure expired approvals deny and notify the agent, with no auto-approve path in code."

Acceptance criteria (verbatim):
- Static check finds no code path that approves on timeout
- Agent receives a denial message
- Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done)

## Finding from exploring the code
The runtime half is already built and tested by AGO-21 and AGO-47: the sweeper (`expire-approvals.ts`) and the resume-time check (`resolveApproval` in `agent-loop.ts`) only ever write `rejected` for a late pending row, emit `approval.decided` (`expired`, `timeout`) and close the call `approval_expired` with a model-visible text ("expired before a human answered. It was not run."). Tests: `agent-loop.approvals.test.ts` (AC2 block). So this ticket adds the **guarantee** (a static check that keeps it true) plus a thin acceptance test that pins the agent-facing denial on the sweeper path, and docs.

## Scope
In:
1. **Static check** `apps/worker/src/approvals/no-auto-approve.test.ts` (Vitest, no new dependency; uses the TypeScript compiler API already in the root). It scans every non-test `.ts`/`.tsx` under `apps/**` and `packages/**` and every `supabase/migrations/*.sql`, and fails on:
   - R1 a write of `approved` to an approval's `status`: object property `status: <approved>`, assignment `x.status = <approved>`, or SQL `UPDATE ... SET status = 'approved'` (literal, or a `$n` bound to an approved value in the call's params);
   - R2 any use of an approved value (`APPROVAL_STATUS.approved`, `"approved"`, `outcome: "approved"`, `approved: true`) inside a function whose name says timeout/expiry/deadline/ttl/sweep, or in an object that also has `decided_by`/`resumed_by: "timeout"`;
   - R3 SQL in migrations that approves from a trigger, function or cron (`UPDATE ... approvals ... status = 'approved'`); RLS policies that let a human decide are not updates and stay allowed.
   Human decision paths go in an explicit allowlist (`HUMAN_DECISION_FILES`, empty today; AGO-58 adds its route there, with review).
2. **Proof it works**: fixtures planted in the test for each rule must each be reported; clean look-alikes (the real read-only uses such as `status === approved` comparisons) must not. A sanity assertion makes sure the real scan saw files, so it cannot pass by scanning nothing.
3. **Acceptance test** for AC2 on the sweeper path: expire via `expireDueApprovals`, then resume; assert the tool never ran, the row is `rejected` (never `approved`), `tool_call.failed` has `approval_expired`, and the model's next request carries the denial text. The resume-time path is already covered.
4. `docs/features/approvals.md` (additive): a "Timeout means deny" section naming the check, the rules and the allowlist.

Out: the human decide route (AGO-58), any change to budget or claims code (AGO-40, AGO-160), UI, migrations.

## Decisions
| # | Decision | Who / when |
|---|---|---|
| 1 | On timeout the system writes `rejected` (a denial), never `approved`; unchanged from AGO-21. `rejected` is the system-denial status; `denied` stays reserved for a human. | design, from AGO-21 record |
| 2 | Static check is a Vitest test (not under `scripts/`), AST-based, no new dependency. | brief |
| 3 | Record ACCEPTED. | owner, via orchestrator, 2026-11-14 |
| 4 | The check covers both writes of status `approved` outside the human decide path (TS literals, computed status variables, SQL strings in `.ts`, and `.sql` migrations, functions and triggers) and timeout/expiry handlers that resolve to allow or proceed. Planted fixtures cover a direct update, a computed status variable, a SQL string and a ternary on expiry; each must fail the check. Fixtures live in `__fixtures__/` which the real scan excludes explicitly. | owner, via orchestrator, 2026-11-14 |
| 5 | The scan includes `supabase/migrations` for functions or triggers that set `approved`, to prove there is no DB-side auto-approve. | owner, via orchestrator, 2026-11-14 |
| 6 | The AC2 test asserts an explicit denial with a reason code, no tool side effect, the run does not hang, and a run_event is appended. | owner, via orchestrator, 2026-11-14 |
| 7 | A test asserts a pending approval past its limit only ever moves to a deny state (`rejected` or `denied`), never `approved`. | owner, via orchestrator, 2026-11-14 |

## Boundaries
- **Always:** keep the check red-on-violation, fail closed on unknown statuses, scope by workspace.
- **Ask first:** a migration (none needed), a new dependency (none), any edit to agent-loop beyond a small additive change (none planned).
- **Never:** write `approved` from the worker, loop, sweeper or any timeout path; touch budget or claims code.

## API changes
None.

## Database changes
None. No migration.

## Dependencies on other tickets
AGO-21 (done), AGO-47 (done). AGO-58 must add its human-only route to `HUMAN_DECISION_FILES`.

## Known limitations
The static check is a tripwire, not a proof. It follows values inside one file: constants, pure aliases (`const s = APPROVAL_STATUS`, an import alias), `+` and template concatenation, ternaries, SQL `||` joins and plpgsql variables. It does not follow these shapes, so review is the backstop for them:
- computed keys: `{ ["status"]: "approved" }`, `{ [k]: "approved" }`, `row["sta" + "tus"] = ...`
- object and array indirection: `const S = { ok: "approved" }; S.ok`, `["approved"][0]`
- cross-file indirection: a constant, helper or return value defined in another module
- runtime-built values: `.join("")`, `.toLowerCase()`, row data, a function's return value, a parameter
- plpgsql dynamic SQL (`execute format(...)`), and SQL assembled in another file
- setter calls whose name is not a write verb (`set`, `update`, `mark`, `save`, `write`, `change`, `transition`, `record`) followed by `Status`, `Decision` or `Outcome`, or whose status argument is not a literal or a bound alias (`store.write(id, "approved")`)
- name shadowing: variables and aliases are bound per file, not per function or block, and the last declaration wins, so a name reused in another function can bind to the wrong value (a false positive or a miss)
- flow-insensitive reassignment: one value per name per file. A variable bound to approved and later reassigned to a safe value still counts (a false positive), and a variable reassigned to approved through an expression the scanner cannot evaluate (`v := f()`) is missed
- INSERT with `$n` bound to approved: only a literal `'approved'` in an INSERT is caught
- plpgsql declaration forms the variable binder does not read (a plain `v := 'approved'` assignment is still caught): `v constant text := 'approved'`, `v text not null := 'approved'`, `v t.col%type := 'approved'`, and a schema-qualified type `v public.status_t := 'approved'`. Only `name [type] := value` and `name [type] default value`, with a one-word type and optional `(n)`, bind
- files outside the scanned roots. The scan covers `apps/`, `packages/` and `supabase/migrations/` only, and only `.ts`, `.tsx` and `.sql`. These are never read: `supabase/seed.sql`, `supabase/tests/*.sql`, `supabase/rollbacks/*.sql`, and `.js`, `.mjs` and `.cjs` files under `apps/` and `packages/`
- folders and files skipped on purpose: any folder named `e2e` (Playwright code that plays the human decider against a local database, `apps/web/e2e`), `__fixtures__`, `node_modules`, `dist`, `.next`, `.turbo`, `coverage`, plus `*.test.ts(x)`, `*.spec.ts(x)` and `*.d.ts` files. Code placed in one of these is not checked

The runtime guarantee (the RLS policy "an expired approval can no longer be approved", the worker's conditional `expire` and `consume`) stays the real enforcement.

## Testing notes
`pnpm --filter @ago/worker test -- no-auto-approve` and `agent-loop.approvals`. No database, no model calls.

## Follow-up tasks
- AGO-58: add the decide route to `HUMAN_DECISION_FILES`.
- Fix the timeout wake race (accepted gap in AGO-21) in or before AGO-58.

## Outcome
Feature guide: [docs/features/approvals.md](../features/approvals.md) (section "Timeout means deny (AGO-51)").
PR: https://github.com/CodeEx24/ai-agent-office/pull/66
