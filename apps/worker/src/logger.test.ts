import { describe, expect, it } from "vitest";

import { REDACTED, createLogger, scrubString, withContext } from "./logger.js";

function collector() {
  const lines: string[] = [];
  return { lines, destination: { write: (chunk: string) => void lines.push(chunk) } };
}

function parse(line: string | undefined): Record<string, unknown> {
  return JSON.parse(line ?? "{}") as Record<string, unknown>;
}

describe("createLogger", () => {
  it("emits one JSON object per line", () => {
    const { lines, destination } = collector();
    createLogger({ destination }).info("hello");
    const entry = parse(lines[0]);
    expect(entry).toMatchObject({ level: "info", service: "worker", msg: "hello" });
    expect(typeof entry.time).toBe("string");
  });

  it("binds run_id, agent_id and workspace_id on child loggers", () => {
    const { lines, destination } = collector();
    const log = withContext(createLogger({ destination }), {
      run_id: "run-1",
      agent_id: "agent-1",
      workspace_id: "ws-1",
    });
    log.info("step");
    expect(parse(lines[0])).toMatchObject({
      run_id: "run-1",
      agent_id: "agent-1",
      workspace_id: "ws-1",
    });
  });

  it("only binds the ids that are present", () => {
    const { lines, destination } = collector();
    withContext(createLogger({ destination }), { run_id: "run-1" }).info("x");
    const entry = parse(lines[0]);
    expect(entry.run_id).toBe("run-1");
    expect(entry).not.toHaveProperty("agent_id");
  });

  it("redacts secret-named keys, nested and camelCase", () => {
    const { lines, destination } = collector();
    createLogger({ destination }).info(
      { token: "t0k", nested: { apiKey: "k", ANTHROPIC_API_KEY: "a", ok: 1 } },
      "m",
    );
    const entry = parse(lines[0]);
    expect(entry.token).toBe(REDACTED);
    expect(entry.nested).toEqual({ apiKey: REDACTED, ANTHROPIC_API_KEY: REDACTED, ok: 1 });
  });

  it("redacts credentials in URLs in messages, values and errors", () => {
    const { lines, destination } = collector();
    const url = "postgres://user:hunter2@db.example.test:5432/app";
    const log = createLogger({ destination });
    log.info({ target: url }, `connecting to ${url}`);
    log.error({ err: new Error(`connect failed ${url}`) }, "boom");
    const raw = lines.join("");
    expect(raw).not.toContain("hunter2");
    expect(raw).toContain("db.example.test");
  });
});

describe("scrubString", () => {
  it("leaves URLs without credentials alone", () => {
    expect(scrubString("http://127.0.0.1:8787/health")).toBe("http://127.0.0.1:8787/health");
  });
});
