import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

import * as Sentry from "@sentry/node";
import { describe, expect, it } from "vitest";

import { createLogger, withContext } from "./logger.js";
import { createErrorTracker, type ErrorTracker } from "./sentry.js";

// AGO-201 AC1 (QA): the shared redaction now also covers sk- keys with dotted tails, bare tokens in
// URL paths and Bearer / apikey values in free text. Each shape is pushed through BOTH consumers:
// the worker logger (pino destination) and Sentry scrubbing (a LOCAL fake ingest over the real
// HTTP transport; nothing leaves the machine). Earlier shapes are replayed so a regression shows.
// Every fake secret is built at runtime so no secret-shaped literal sits in the source (gitleaks).

const BODY = "Zk4m".repeat(12);
const PART_A = "Qw7e".repeat(6);
const PART_B = "Rt5y".repeat(6);
const B64 = Buffer.from(`svc:${BODY}`).toString("base64");

interface Shape {
  readonly label: string;
  readonly text: string;
  /** A fragment of the secret that must not survive anywhere in the output. */
  readonly secret: string;
}

/** The three shapes AGO-201 adds, with spellings from the ticket and from QA probing. */
const NEW_SHAPES: readonly Shape[] = [
  { label: "sk- key with a dotted tail", text: `key sk-${PART_A}.${PART_B}`, secret: PART_B },
  {
    label: "sk-ant- key with a dotted tail",
    text: `key sk-ant-api03-${PART_A}.${PART_B}`,
    secret: PART_B,
  },
  {
    label: "sk-proj- key with a dotted tail",
    text: `key sk-proj-${PART_A}.${PART_B}-end`,
    secret: PART_B,
  },
  {
    label: "sk- key with several dots",
    text: `key sk-${PART_A}.${PART_B}.${BODY}`,
    secret: BODY,
  },
  {
    label: "token in a URL path (/token/<value>)",
    text: `GET /v1/token/${BODY} 200`,
    secret: BODY,
  },
  {
    label: "token in a full URL path",
    text: `GET https://api.example.test/token/${BODY}?page=2`,
    secret: BODY,
  },
  { label: "token after /tokens/", text: `DELETE /api/tokens/${BODY}/revoke`, secret: BODY },
  {
    label: "reset password path",
    text: `POST https://x.example.test/reset/password/${BODY}`,
    secret: BODY,
  },
  { label: "path with an upper-case credential word", text: `GET /Token/${BODY}`, secret: BODY },
  { label: "/access-token/ path", text: `GET /access-token/${BODY}`, secret: BODY },
  { label: "/bearer/ path", text: `GET /bearer/${BODY}`, secret: BODY },
  { label: "/otp/ path", text: "GET /otp/48151623", secret: "48151623" },
  { label: "path token with a dot", text: `GET /token/${PART_A}.${PART_B}`, secret: PART_B },
  {
    label: "Bearer in an Authorization header line",
    text: `Authorization: Bearer ${BODY}`,
    secret: BODY,
  },
  { label: "Bearer with a colon", text: `got bearer: ${BODY}`, secret: BODY },
  { label: "Bearer with =", text: `Bearer=${BODY}`, secret: BODY },
  { label: "quoted Bearer", text: `header "Bearer ${BODY}" rejected`, secret: BODY },
  { label: "short (4 character) Bearer value", text: "Bearer Ab3x", secret: "Ab3x" },
  { label: "apikey followed by a space", text: `apikey ${BODY}`, secret: BODY },
  { label: "api key: value", text: `api key: ${BODY}`, secret: BODY },
  { label: "api_key with a quoted value", text: `api_key "${BODY}"`, secret: BODY },
  { label: "x-api-key header", text: `x-api-key: ${BODY}`, secret: BODY },
  { label: "api key is <value>", text: `the api key is ${BODY} ok`, secret: BODY },
];

/** Earlier shapes (AGO-104, AGO-143): they must keep working. */
const EARLIER_SHAPES: readonly Shape[] = [
  { label: "plain sk- key", text: `key sk-${BODY}`, secret: BODY },
  { label: "sk-ant- key", text: `key sk-ant-api03-${BODY}`, secret: BODY },
  {
    label: "sk-proj- key with an underscore",
    text: `key sk-proj-${PART_A}_${PART_B}`,
    secret: PART_B,
  },
  { label: "sk-svcacct- key", text: `key sk-svcacct-${BODY}`, secret: BODY },
  { label: "JWT", text: `session eyJ${"hDr1".repeat(5)}.eyJ${PART_A}.${BODY}`, secret: BODY },
  { label: "GitHub token", text: `token ghp_${"Gh1p".repeat(9)}`, secret: "Gh1pGh1p" },
  {
    label: "Supabase secret key",
    text: `key sb_secret_${BODY.slice(0, 24)}`,
    secret: BODY.slice(0, 24),
  },
  { label: "AWS access key", text: `key AKIA${"Q7ZX".repeat(4)}`, secret: "Q7ZXQ7ZX" },
  {
    label: "URL with credentials",
    text: `connect postgres://worker:${BODY}@db.internal.test:5432/app`,
    secret: BODY,
  },
  {
    label: "apikey in a query string",
    text: `GET https://x.example.test/cb?apikey=${BODY}&page=2`,
    secret: BODY,
  },
  {
    label: "access_token in a URL fragment",
    text: `redirect https://x.example.test/cb#access_token=${BODY}&type=bearer`,
    secret: BODY,
  },
  { label: "password assignment", text: `password: ${BODY}`, secret: BODY },
  { label: "client_secret assignment", text: `client_secret=${BODY}`, secret: BODY },
  { label: "Basic auth header", text: `Authorization: Basic ${B64}`, secret: B64.slice(0, 20) },
  { label: "Cookie header", text: `Cookie: sb-access-token=${BODY}; theme=dark`, secret: BODY },
  { label: "Set-Cookie header", text: `Set-Cookie: session=${BODY}; Path=/`, secret: BODY },
  {
    label: "private key block",
    text: `-----BEGIN PRIVATE KEY-----\n${BODY}\n-----END PRIVATE KEY-----`,
    secret: BODY,
  },
];

/** Ordinary text that must stay readable: redaction must not eat normal URLs and ids. */
const ORDINARY_TEXT: readonly string[] = [
  "GET https://app.example.test/app/workspaces/5f1d6c1a-0000-4000-8000-000000000001 200 12ms",
  "https://example.com/users/123e4567-e89b-12d3-a456-426614174000/agents?page=2",
  "run_id=run_01HZ agent_id=agent_9 step=3 finished",
  "GET /api/tokens/list 200",
  "GET /tokens/list",
  "GET /api/tokenizer/status",
  "GET /api/capabilities 429 retry-after=12",
  "queue depth is 14, nothing to retry",
  "risk-assessment-for-the-quarterly-report finished",
  "task-0001-describe-the-office-layout finished",
];

interface FakeIngest {
  readonly dsn: string;
  readonly bodies: string[];
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      resolve(
        request.headers["content-encoding"] === "gzip"
          ? gunzipSync(raw).toString("utf8")
          : raw.toString("utf8"),
      );
    });
    request.on("error", reject);
  });
}

async function startFakeIngest(): Promise<FakeIngest> {
  const bodies: string[] = [];
  const server: Server = createServer((request, response) => {
    readBody(request).then(
      (body) => {
        bodies.push(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      },
      () => {
        response.writeHead(400);
        response.end();
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    dsn: `http://publickey@127.0.0.1:${String(port)}/1`,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Sends one text through Sentry (breadcrumb and exception message) and returns every byte received. */
async function throughSentry(text: string): Promise<string> {
  const ingest = await startFakeIngest();
  const tracker: ErrorTracker = createErrorTracker({ dsn: ingest.dsn, environment: "local" });
  try {
    tracker.addBreadcrumb({ level: "info", message: text, context: {} });
    tracker.captureException(new Error(text));
    await tracker.close();
    const deadline = Date.now() + 10_000;
    while (!ingest.bodies.join("\n").includes('"exception"')) {
      if (Date.now() > deadline) throw new Error("fake ingest: timed out waiting for the event");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return ingest.bodies.join("\n");
  } finally {
    // Breadcrumbs live on Sentry's global scopes; clear them so one shape cannot taint the next.
    Sentry.getIsolationScope().clearBreadcrumbs();
    Sentry.getCurrentScope().clearBreadcrumbs();
    await ingest.close();
  }
}

/** Sends one text through the worker logger as message, structured field and Error. */
function throughLogger(text: string): string {
  const lines: string[] = [];
  const destination = { write: (chunk: string) => void lines.push(chunk) };
  const log = withContext(createLogger({ destination }), { run_id: "run_qa_201" });
  log.info(text);
  log.warn({ detail: text, nested: { note: text } }, "step failed");
  log.error(new Error(text));
  return lines.join("\n");
}

describe("AC1: redaction covers dotted sk- keys, URL-path tokens and Bearer/apikey in free text", () => {
  for (const shape of NEW_SHAPES) {
    it(`AC1: ${shape.label} is masked by the worker logger`, () => {
      const output = throughLogger(shape.text);
      expect(output).not.toContain(shape.secret);
      expect(output).toContain("[redacted]");
    });

    it(`AC1: ${shape.label} never reaches Sentry (message and breadcrumb)`, async () => {
      expect(await throughSentry(shape.text)).not.toContain(shape.secret);
    });
  }
});

describe("AC1 (no regressions): the shapes redacted before AGO-201 still are", () => {
  for (const shape of EARLIER_SHAPES) {
    it(`AC1: ${shape.label} is still masked by the worker logger`, () => {
      expect(throughLogger(shape.text)).not.toContain(shape.secret);
    });
  }

  it("AC1: every earlier shape is still masked in Sentry events", async () => {
    const combined = EARLIER_SHAPES.map((shape) => shape.text).join(" | ");
    const received = await throughSentry(combined);
    for (const shape of EARLIER_SHAPES) {
      expect(received, shape.label).not.toContain(shape.secret);
    }
  });
});

describe("AC1 (over-redaction): ordinary text stays readable", () => {
  for (const text of ORDINARY_TEXT) {
    it(`AC1: ordinary text is left intact: ${text.slice(0, 48)}`, () => {
      const output = throughLogger(text);
      expect(output).toContain(JSON.stringify(text).slice(1, -1));
      expect(output).not.toContain("[redacted]");
    });
  }

  it("AC1: a credential in a path does not blank the rest of the line", () => {
    const output = throughLogger(
      `GET https://api.example.test/v1/token/${BODY}/status 200 in 12ms`,
    );
    expect(output).toContain("https://api.example.test/v1/token/[redacted]/status 200 in 12ms");
  });
});
