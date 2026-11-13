# Agents

## The trifecta lint (AGO-138)

An agent that can read **untrusted content**, see **private data** and **send data out of the workspace** can be tricked by a hidden instruction on a web page into leaking what it can see. Any two of the three are allowed. All three together are blocked when an agent is created.

| Leg | Capabilities |
|---|---|
| Untrusted content | `web.search`, `web.browse` |
| Private data | `vault.read_private`, `vault.read` |
| Outbound communication | `message.send_outbound`, `integration.write` |

- **Where it runs:** the pure function `lintTrifecta` in `packages/shared/src/agents/trifecta-lint.ts` (zod-free, importable as `@ago/shared/trifecta-lint`). The wizard calls it live on the Capabilities step: the explanation appears as soon as the third leg is ticked and Next stays blocked. The server calls it in `agentCreator.createAgent`, the one path the wizard and "Create from template" both use, so a hand-made request is refused too, before the database is called.
- **What the owner sees:** an error on the Capabilities field naming the three legs, the capabilities behind each, and what to do (remove at least one).
- **Mode does not matter:** a capability granted as "needs approval" still counts, because an approval can be clicked through.
- **No override yet:** the ticket asks for a security-admin approval. No such role or approval flow exists, so the owner decided (2026-11-13) on a hard block and a follow-up for the approval path.
- **Adding a capability:** map it in `trifecta-lint.ts` or list it as neutral in `trifecta-lint.test.ts`; the test fails until you do. A key the lint does not know has no leg.
- **Role templates:** all eight pass. The Researcher has web search and no private notes; the Analyst has private notes and no web.
- **Not covered:** this is an application check. A database backstop in `create_agent` and agent editing (AGO-89) are follow-ups; AGO-89 should call `lintTrifecta` on every capability change.
