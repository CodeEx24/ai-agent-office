// Stack-free stand-in for the Supabase Auth settings endpoint (AGO-67).
// The sign-in page reads /auth/v1/settings on the Next server, so a browser-side page.route
// cannot stub it. In stack-free runs Playwright starts this server and points the app at it,
// which makes the provider buttons deterministic even if a real stack happens to be running.
import { createServer } from "node:http";

const port = Number(process.env.E2E_STUB_AUTH_PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error("E2E_STUB_AUTH_PORT is required");

const server = createServer((request, response) => {
  if (request.url?.startsWith("/auth/v1/settings")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ external: { email: true, google: true, github: true } }));
    return;
  }
  response.writeHead(404).end();
});

server.listen(port, "127.0.0.1");
