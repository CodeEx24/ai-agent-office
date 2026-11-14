# Budgets and hard stops

Tickets: AGO-40 (created: usage tracking and hard stops)

## What it does

Three limits keep an agent from spending more than a person agreed to. Each one is a **hard stop**: the model call is refused *before* any money is spent, the run ends, and a `budget.exceeded` event is appended to the run's history with a reason a person can read.

| Limit | Unit | Scope | Where it is set |
|---|---|---|---|
| Max tokens per run | tokens | one run | Agent wizard, "Max tokens per run" (optional; empty uses the worker default) |
| Daily budget | US cents | one agent, one UTC day | Agent wizard, "Daily budget" |
| Monthly budget | US cents | one workspace, one UTC month | Workspace row in `budgets_usage` set by an owner; never above the platform cap |

An agent can never raise or change any of these. The wizard and the owner-only functions are the only way to set them.

## How a call is checked

1. **Before the call.** The worker estimates the *worst case* cost of the call: the prompt (estimated at 3 characters per token, so it is over- rather than under-counted) plus the **whole output allowance** (`maxOutputTokens`). It holds that amount against the agent's daily row and the workspace's monthly row in one atomic step. If either does not fit, nothing is held, the model is **not called**, and the run stops.
2. **After the call.** The real cost (from the model's reported token usage) replaces the held amount. A cheaper call releases the difference. A dearer call is an **overrun**: the ledger records the higher cost, a `budget.exceeded` event with `call_cost_overran_reservation` is appended, and the run stops if it still wanted to do more work. If the model had just given its final answer, the run completes (nothing more is spent) and the event is still recorded.
3. **A model with no price is refused.** It is never treated as free.
4. **If the budget cannot be checked** (the database is unreachable, a row is missing), the call is refused: no check means no spend.

The run's own token limit is checked the same way as before this ticket (`run.limit_reached`), and now also appends `budget.exceeded` with `run_token_limit_reached` first.

## Reason codes

Every refusal and stop appends one `budget.exceeded` run event with `scope`, `reason`, `limit`, `used` and (when known) `estimate`. A `run.stopped` event with `stopped_by: "budget"` follows a money stop.

| `reason` | `scope` | Meaning |
|---|---|---|
| `run_token_limit_reached` | `run` | The run used its token budget. |
| `agent_daily_limit_would_be_exceeded` | `agent_daily` | The next call could take the agent past its daily budget. |
| `workspace_monthly_limit_would_be_exceeded` | `workspace_monthly` | The next call could take the workspace past its monthly budget. |
| `model_not_priced` | `pricing` | The model has no entry in the price table. |
| `budget_check_failed` | `ledger` | The ledger could not answer, so the call was refused. |
| `call_cost_overran_reservation` | `ledger` | A call cost more than was held for it. |
| `call_outcome_unknown_charged` | `ledger` | A call ended without a clear answer from the provider (a dropped connection after the request was sent, a malformed answer, an abort), so it may have been billed. Its full held amount was counted as spent. A call the provider rejected with an HTTP error status is released instead and records no event. |

Plain-language texts for every code are in `BUDGET_STOP_MESSAGES` (`packages/shared/src/budget/budget.ts`).

## Numbers

- **Platform monthly cap: 100,000 cents ($1,000.00)**, the constant `WORKSPACE_MONTHLY_BUDGET_CAP_CENTS` in `packages/shared`. A workspace with no monthly budget uses the cap. An owner may only **lower** it; a stored value above the cap is clamped to it.
- **Daily budget:** an agent with no stored budget gets the wizard default of 500 cents ($5.00). The platform ceiling for one agent is 5,000 cents ($50.00).
- **Periods** are UTC days and UTC months.
- **Money is whole cents, rounded up** per call, so the ledger can over-count by up to 1 cent per call and never under-counts.

### Price table (cents per million tokens)

Static, in `packages/shared/src/budget/budget.ts` (`MODEL_PRICES`). **These are conservative placeholders, not a verified price list. The owner should compare them with the current model pricing and edit the table.** A model missing from it is refused, so adding a model to the wizard's list also needs a price here (a test enforces this).

| Model | Input | Output |
|---|---|---|
| `claude-haiku-5-5` | 100 | 500 |
| `claude-sonnet-5-5` | 300 | 1,500 |
| `claude-opus-5-5` | 500 | 2,500 |
| `claude-fable-5-1` | 1,500 | 7,500 |

## Data model

No migration. The existing `public.budgets_usage` table is the ledger: one row per agent per UTC day (`agent_id` set), and one row per workspace per UTC month (`agent_id` null). `cost_used_cents` and `tokens_used` are written only by the worker's service connection. An owner's monthly budget is `cost_budget_cents` on the workspace row. The agent's daily budget is `agents.daily_budget_cents`. The per-run token limit is `agents.run_limits.maxTokens` (AGO-166), written only by the owner-only `set_agent_run_limits()`.

The reserve is one conditional upsert per row (`insert ... on conflict do update ... where used + amount <= limit`), both rows in one transaction, so two runs cannot both take the last cents.

## Boundaries

- The agent loop (`apps/worker/src/agent/agent-loop.ts`) calls the guard; the guard (`apps/worker/src/budget/`) decides; the loop writes the events.
- `workspace_id` scopes every ledger statement. Usage columns have no grant for the `authenticated` role.
- A budget stop is not an approval and cannot be approved around: there is no path for an agent to continue after one.

## Known limitations

- The estimate uses a rough 3-characters-per-token rule, so a very large prompt can be refused slightly early. That is the safe side.
- Prices are static and manual until a pricing source exists.
- A call that the worker abandons mid-flight (a crash or an abort) keeps its reservation, so the ledger over-counts rather than under-counts.
- There is no screen yet to set the workspace monthly budget or to browse usage; owners set it in the database for now (follow-up).
