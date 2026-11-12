# Credentials: the credential broker

Secrets stay on the server. An agent, and the model behind it, never sees a key value: a tool names a secret by reference (`secret:crm_api_key`) and the worker-side broker uses it for the tool. Ticket: AGO-157. Agent identity and short-lived credentials are AGO-148.

## How a secret is used

1. The model is shown a tool with a `secret_ref` field and its own arguments. It can only name a reference. A pasted key does not match `secret:<name>`, so the call fails validation and the tool never runs.
2. The policy engine decides the call as usual (the broker never approves anything).
3. The tool hands the reference and its work function to `broker.withSecret`. The broker:
   - checks the run's agent credential (AGO-148) for the tool's capability;
   - asks the `SecretStore` for the value, scoped by workspace and by the capabilities the secret is bound to (any miss looks the same: `secret_unavailable`);
   - writes the audit entry **before** releasing the value (if it cannot be recorded, the call does not happen);
   - runs the function with the value, then scrubs the returned text and any error of the value and its base64, base64url, hex, URL-encoded and JSON-escaped forms, plus the shared credential patterns (AGO-104).

## Audit

Each call produces one log line and one `BrokerAuditSink` entry: workspace, run, agent, tool, capability, the reference name, outcome (`allowed`, `denied`, `error`) and a stable reason code. Never a value, a token or the tool's input. Denials are audited too.

## Building a tool

```ts
const crmLookup = createBrokeredTool({
  name: "crm_lookup", description: "...", tier: 1, capabilityKey: "crm.read",
  args: { query: z.string() }, modelProperties: { query: { type: "string" } }, modelRequired: ["query"],
  broker, credentialFor: (ctx) => tokenForRun(ctx.runId),
  run: (args, secret) => callCrm(args.query, secret), // returns text
});
```

## Where values live

`SecretStore` is an interface. `createInMemorySecretStore` is for tests and first wiring; the database vault (encryption at rest, UI) is AGO-185.

## Limits

- A function that transforms the value (hashes it, then returns it) can defeat value matching. Review tools that handle secrets; the policy engine and tiers still apply.
- Wiring the broker and a run's credential into the production tool registry comes with the first secret-using tool.

## Tests

`pnpm --filter @ago/worker test credentials` includes `broker.e2e.test.ts`: the real tool loop with a scripted model that is asked for the key. It searches the prompts, run events, logs and audit for the value and its encodings.
