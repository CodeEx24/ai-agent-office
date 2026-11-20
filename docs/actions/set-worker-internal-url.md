---
status: open
tickets: [AGO-85]
order: 3
estimate: 5 min
---

# Tell the web app where the worker's prerequisite check lives

**Why.** Code running, web browsing and outbound messages can only be turned on while four checks pass: the sandbox is hardened, egress is default deny, the credential broker is in place, and approvals are bound to the payload hash. The web app does not run those checks itself; it asks the worker, over a read-only, loopback-only address, at the moment an owner clicks Enable. If the web app cannot reach the worker, it treats every check as failed, so **without this setting the Enable button for those three capabilities stays blocked** (nothing else breaks).

**What you need.** Shell access to wherever the web app's server environment is set, and the address the worker listens on. The worker's health server must be reachable from the web server **over loopback** (same machine, or a tunnel that arrives as loopback). The worker refuses any other caller on this route.

## Steps

1. Pick the base address of the worker's health server, with no path (for example `http://127.0.0.1:` followed by the worker's port). Use `http` or `https` only.

2. Set this environment variable for the **web app server** (name only; the value is the address):

   ```
   WORKER_INTERNAL_URL=...
   ```

   Do not put it in any client-side variable and do not prefix it with `NEXT_PUBLIC_`. It is read only on the server.

3. Restart the web app so it picks the variable up.

## Check it worked

Open **Capabilities** in the app as an owner. If the worker is running and its checks pass, the Enable button for Run code, Browse the web and Send outbound messages is active. If the variable is missing, wrong, or the worker is down or slow (it waits at most 2 seconds), the button stays disabled and lists the four checks as blocked. That is the safe default, not a bug: fix the address and reload the page.

You can also ask the worker directly from its own machine: a GET to `/prerequisites` on its health port returns each check's name, status and a short reason code, and nothing else. Any other caller, method or path gets a refusal.
