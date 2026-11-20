---
status: open
tickets: [AGO-65]
order: 2
estimate: 10 min
---

# Create the egress allowlist file

**Why.** Sandboxed runs have no network by default. When worker code gives a run egress, the egress proxy lets it reach only the hosts you list here. With no file, every request is blocked (default deny), so nothing breaks if you skip this; runs just cannot reach anything.

**What you need.** Shell access to the machine that runs the worker, and the workspace id(s) you want to allow hosts for.

## Steps

1. Create a JSON file outside the repo (for example next to the worker's other config). Use the shape below. A host is an exact name or `*.example.com` (subdomains only, not the apex). No scheme, port, path, IP address or bare `*`.

   ```json
   {
     "version": 1,
     "workspaces": {
       "<workspace id>": { "hosts": ["api.example.com", "*.cdn.example.com"], "ports": [443] }
     }
   }
   ```

   `ports` is optional and defaults to 80 and 443.

2. Point the worker at it with this environment variable (name only; the value is the file's path):

   ```
   EGRESS_ALLOWLIST_FILE=...
   ```

3. Restart is not needed: the file is re-read for every run. Keep it writable only by you; anyone who can edit it can open the network.

## Check it worked

A run with egress to a listed host succeeds. A run to an unlisted host gets a 403 from the proxy, and the worker log shows an `egress.blocked` warning with the run id, workspace id, host, port and reason (never the URL path or query). If the file has any mistake (bad JSON, an unknown key, a bad host), the worker logs a warning and **blocks everything**, so fix the warning's cause and the next run picks it up.

## Notes

Only people with access to the worker host can change this list; there is no agent-facing way to edit it. A screen for it, backed by the database, is a follow-up (see `docs/tickets/AGO-65.md`).
