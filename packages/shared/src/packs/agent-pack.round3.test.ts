import { describe, expect, it, vi } from "vitest";

import { findSecretShape, parseAgentPack } from "./index.js";
import { SECRET_VALUE_PATTERNS } from "../redaction/redact.js";

// Pack-level ratio tests parse many notes several times, so give every test here room on a slow runner.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Round 3 tests for AGO-191: the JWT shape is linear on "eyJ-" text, a duplicate secret-shaped
 * secretRefs entry is not echoed, and a credential URL with an empty user name is found.
 * Every fake secret is assembled at runtime so no realistic secret is committed.
 */

type Loose = Record<string, unknown>;

function validPack(): Loose {
  return {
    packVersion: 1,
    metadata: { name: "Sales team", exportedAt: "2026-11-13T10:30:00+08:00", appVersion: "1.2.3" },
    agents: [
      {
        name: "Closer",
        role: "Sales lead",
        model: "some-future-model-id",
        thinkingEffort: "high",
        prompt: "Follow up with warm leads.",
        skills: ["Outreach"],
        capabilities: [{ name: "vault.read", scope: "workspace" }],
        dailyBudgetCents: 1200,
        autonomyMode: "standard",
        department: "Sales",
        secretRefs: ["secret:crm_api_key"],
      },
    ],
    skills: [{ name: "Outreach", version: 2, body: "# Outreach\n\nBe brief." }],
    notes: [{ title: "Hand-off", body: "Check the pipeline weekly." }],
  };
}

/** Linear is ~2x per doubling and quadratic ~4x; the median over several doublings ignores one noisy step. */
const MAX_MEDIAN_GROWTH_FOR_2X_INPUT = 3.0;
const MAX_GROWTH_FOR_4X_INPUT = 11; // linear ~4x, quadratic ~16x
const TIMER_FLOOR_MS = 2;

/** Best of seven runs after one warm-up run, so JIT and cache start-up do not count. */
function timeIt(run: () => unknown): number {
  run();
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * Time `findSecretShape` on inputs that grow by 2x per step and return the cost ratio of each step.
 * The inputs are large enough to keep timings well above timer noise, so no ms floor is needed.
 */
function doublingRatios(build: (size: number) => string, sizes: number[]): number[] {
  const timings = sizes.map((size) => {
    const text = build(size);
    return timeIt(() => findSecretShape(text));
  });
  return timings.slice(1).map((ms, index) => ms / timings[index]!);
}

/** Time `parseAgentPack` on a valid pack whose notes are replaced by `notes`. */
function timeParse(notes: unknown[]): { ms: number; result: ReturnType<typeof parseAgentPack> } {
  const pack = validPack();
  pack.notes = notes;
  let result = parseAgentPack(pack);
  const ms = timeIt(() => {
    result = parseAgentPack(pack);
  });
  return { ms, result };
}

const jwt = () => ["eyJ" + "h".repeat(12), "eyJ" + "p".repeat(10), "s".repeat(14)].join(".");

describe("AC (security round 2): the JWT shape is linear on eyJ- text", () => {
  for (const repeats of [5000, 10_000, 20_000, 80_000]) {
    it(`findSecretShape returns null on "eyJ-" repeated ${String(repeats)} times`, () => {
      expect(findSecretShape("eyJ-".repeat(repeats))).toBeNull();
    });
  }

  it("findSecretShape cost grows about 4x, not 16x, when the eyJ- input is 4x longer", () => {
    const small = "eyJ-".repeat(80_000);
    const large = "eyJ-".repeat(320_000);
    const smallMs = timeIt(() => findSecretShape(small));
    const largeMs = timeIt(() => findSecretShape(large));
    expect(largeMs / Math.max(smallMs, TIMER_FLOOR_MS)).toBeLessThan(MAX_GROWTH_FOR_4X_INPUT);
  });

  it("findSecretShape cost grows about 2x, not 4x, per doubling of the eyJ- input (median of three steps)", () => {
    const ratios = doublingRatios(
      (repeats) => "eyJ-".repeat(repeats),
      [80_000, 160_000, 320_000, 640_000],
    );
    expect(median(ratios), ratios.map((ratio) => ratio.toFixed(2)).join(", ")).toBeLessThan(
      MAX_MEDIAN_GROWTH_FOR_2X_INPUT,
    );
  });

  it("parseAgentPack returns only a length issue on a 200k-character note of eyJ- text, and cost grows linearly", () => {
    const small = timeParse([{ title: "n", body: "eyJ-".repeat(12_500) }]);
    const { ms, result } = timeParse([{ title: "n", body: "eyJ-".repeat(50_000) }]);
    expect(ms / Math.max(small.ms, TIMER_FLOOR_MS)).toBeLessThan(MAX_GROWTH_FOR_4X_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.path).toBe("notes.0.body");
      expect(result.issues[0]?.message).toContain("at most");
    }
  });

  it("parseAgentPack parses 100 notes of eyJ- text with no issue, and cost grows linearly with note length", () => {
    const notesOf = (repeats: number) =>
      Array.from({ length: 100 }, () => ({ title: "n", body: "eyJ-".repeat(repeats) }));
    const small = timeParse(notesOf(1250));
    const large = timeParse(notesOf(5000));
    expect(small.result.ok).toBe(true);
    expect(large.result.ok).toBe(true);
    expect(large.ms / Math.max(small.ms, TIMER_FLOOR_MS)).toBeLessThan(MAX_GROWTH_FOR_4X_INPUT);
  });

  it("parseAgentPack parses 100 notes of near-JWT text, and cost grows linearly with note length", () => {
    const unit = "eyJ" + "a".repeat(10) + ".eyJ" + "a".repeat(8) + ".b ";
    const notesOf = (length: number) =>
      Array.from({ length: 100 }, () => ({ title: "n", body: unit.repeat(800).slice(0, length) }));
    const small = timeParse(notesOf(5000));
    const large = timeParse(notesOf(20_000));
    expect(small.result.ok).toBe(true);
    expect(large.result.ok).toBe(true);
    expect(large.ms / Math.max(small.ms, TIMER_FLOOR_MS)).toBeLessThan(MAX_GROWTH_FOR_4X_INPUT);
  });
});

describe("AC (security round 2): real JWTs are still detected", () => {
  it.each([
    ["bare", () => jwt()],
    ["in double quotes", () => `"${jwt()}"`],
    ["in single quotes", () => "'" + jwt() + "'"],
    ["after token:", () => `token:${jwt()}`],
    ["after token: and a space", () => `token: ${jwt()}`],
    ["after Bearer", () => `Authorization: Bearer ${jwt()}`],
    ["after a space", () => `here it is ${jwt()}`],
    ["after a newline", () => `line one\n${jwt()}`],
    ["after an equals sign", () => `JWT=${jwt()}`],
    ["after a slash", () => `/x/${jwt()}`],
  ])("findSecretShape flags a JWT that is %s", (_label, build) => {
    expect(findSecretShape(build())).toBe("token");
  });

  it("findSecretShape flags a JWT after a run of eyJ- noise", () => {
    expect(findSecretShape("eyJ- ".repeat(100) + jwt())).toBe("token");
  });

  it("parseAgentPack rejects a skill body holding a JWT, at the skill body path", () => {
    const pack = validPack();
    (pack.skills as Loose[])[0]!.body = `Use ${jwt()} to call it.`;
    const result = parseAgentPack(pack);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.path)).toEqual(["skills.0.body"]);
    expect(JSON.stringify(result)).not.toContain(jwt());
  });

  it("parseAgentPack rejects a note body holding a JWT, at the note body path", () => {
    const pack = validPack();
    (pack.notes as Loose[])[0]!.body = `token ${jwt()}`;
    const result = parseAgentPack(pack);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.path)).toEqual(["notes.0.body"]);
  });

  // Documented trade-off of the lookbehind: a JWT glued straight after "-", "_", a letter or a digit
  // is not at a token start, so this shape no longer matches it. Pinned so a change is noticed.
  it.each(["-", "_", "a", "7"])(
    "findSecretShape does not match a JWT glued directly after %s (documented limitation)",
    (glue) => {
      expect(findSecretShape(glue + jwt())).toBeNull();
    },
  );
});

describe("AC (security round 2): a duplicate secretRefs entry never echoes a secret-shaped value", () => {
  const shapes = {
    anthropicKey: ["sk", "ant", "q".repeat(32)].join("-"),
    githubToken: "gh" + "p_" + "a1".repeat(18),
    jwt: jwt(),
    postgresUrl: "post" + "gres://app_user:" + "pa55w0rd" + "@db.internal:5432/app",
  };

  for (const [label, value] of Object.entries(shapes)) {
    it(`the parse result never contains the ${label} when it is the duplicated ref`, () => {
      const pack = validPack();
      (pack.agents as Loose[])[0]!.secretRefs = [value, value];
      const result = parseAgentPack(pack);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(value);
    });

    it(`the parse result never contains the ${label} when it is the duplicated ref after secret:`, () => {
      const pack = validPack();
      const ref = "secret:" + value;
      (pack.agents as Loose[])[0]!.secretRefs = [ref, ref];
      const result = parseAgentPack(pack);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(value);
    });
  }

  it("the listed-twice message hides a secret-shaped ref and keeps its path", () => {
    const pack = validPack();
    const ref = "secret:" + shapes.anthropicKey;
    (pack.agents as Loose[])[0]!.secretRefs = [ref, ref];
    const result = parseAgentPack(pack);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((i) => i.message.includes("listed twice"));
      expect(issue?.path).toBe("agents.0.secretRefs.1");
      expect(issue?.message).toContain("looks like a secret");
    }
  });

  it("an ordinary duplicate ref is still reported with its name", () => {
    const pack = validPack();
    (pack.agents as Loose[])[0]!.secretRefs = ["secret:crm_api_key", "secret:crm_api_key"];
    const result = parseAgentPack(pack);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        {
          path: "agents.0.secretRefs.1",
          message: 'Reference "secret:crm_api_key" is listed twice.',
        },
      ]);
    }
  });
});

describe("AC (security round 2): a credential URL with an empty user name is found", () => {
  const pw = "pa" + "55";

  it.each([
    ["redis with an empty user", "redis://:" + pw + "@host"],
    ["rediss with an empty user", "rediss://:" + pw + "@h"],
    ["amqp with an empty user", "amqp://:" + pw + "@h"],
    ["redis in prose", "set REDIS_URL to redis://:" + pw + "@cache.internal:6379/0 now"],
    ["postgres u:p@h", "postgres://u:" + "p" + "@h"],
    ["https user:pass@example.com", "https://user:" + pw + "@example.com"],
    ["git+ssh u:p@host", "git+ssh://u:" + "p" + "@host"],
    ["a 30-character scheme", "a".repeat(30) + "://u:" + pw + "@h"],
    ["an uppercase scheme", "HTTPS://U:" + pw + "@H"],
  ])("findSecretShape flags a password in a URL: %s", (_label, text) => {
    expect(findSecretShape(text)).toBe("password in a URL");
  });

  it.each([
    "https://example.com/docs",
    "http://localhost:3000/path",
    "ftp://host/file",
    "see http://x:80/",
    "a://:b",
    "http://x:80",
    "The password is stored in the broker, never in the pack.",
    "Set your password: then press enter @ the desk",
    "mailto:a@b.c",
    "https://example.com/path/@user/page",
    "https://example.com/a:b@c",
    "redis://localhost:6379",
    "redis://host:6379/0?x=a@b",
  ])("findSecretShape returns null for ordinary text: %s", (text) => {
    expect(findSecretShape(text)).toBeNull();
  });
});

describe("every secret pattern stays linear on extra adversarial text", () => {
  const adversarial: Record<string, (n: number) => string> = {
    "eyJ- repeated": (n) => "eyJ-".repeat(n / 4),
    "eyJ_ repeated": (n) => "eyJ_".repeat(n / 4),
    "eyJ then long key chars": (n) => "eyJ" + "a".repeat(n),
    "eyJ.eyJ. repeated": (n) => "eyJaaaaaaaaaaa.eyJaaaaaaa".repeat(n / 25),
    ":// repeated": (n) => "://".repeat(n / 3),
    "a://: repeated": (n) => "a://:".repeat(n / 5),
    "a://:b repeated no at": (n) => "a://:b".repeat(n / 6),
    "scheme then many colons": (n) => "a://" + ":".repeat(n),
    "scheme then colon then slashes": (n) => "a://:" + "/".repeat(n),
    "sk-ant- repeated": (n) => "sk-ant-".repeat(n / 7),
    "github_pat_ repeated": (n) => "github_pat_".repeat(n / 11),
    "xoxb- repeated": (n) => "xoxb-".repeat(n / 5),
    "digits colon AA": (n) => ("1".repeat(9) + ":AA").repeat(n / 12),
    "AIza repeated": (n) => "AIza".repeat(n / 4),
    "sb_secret_ repeated": (n) => "sb_secret_".repeat(n / 10),
    "sbp_ repeated": (n) => "sbp_".repeat(n / 4),
    "ago_agt_ repeated": (n) => "ago_agt_".repeat(n / 8),
    "sk_live_ repeated": (n) => "sk_live_".repeat(n / 8),
    "BEGIN PRIVATE repeated": (n) => "-----BEGIN RSA ".repeat(n / 15),
    "single char": (n) => "a".repeat(n),
    spaces: (n) => " ".repeat(n),
    dashes: (n) => "-".repeat(n),
    underscores: (n) => "_".repeat(n),
  };
  const SMALL = 20_000;
  const LARGE = 80_000;

  it("findSecretShape grows linearly on every adversarial text", () => {
    for (const [name, build] of Object.entries(adversarial)) {
      const small = build(SMALL);
      const large = build(LARGE);
      const smallMs = timeIt(() => findSecretShape(small));
      const largeMs = timeIt(() => findSecretShape(large));
      expect(largeMs / Math.max(smallMs, TIMER_FLOOR_MS), name).toBeLessThan(
        MAX_GROWTH_FOR_4X_INPUT,
      );
    }
  });

  for (const [pattern, label] of SECRET_VALUE_PATTERNS) {
    it(`the ${label} pattern is linear on every adversarial text`, () => {
      for (const [name, build] of Object.entries(adversarial)) {
        const small = build(SMALL);
        const large = build(LARGE);
        const smallMs = timeIt(() => pattern.test(small));
        const largeMs = timeIt(() => pattern.test(large));
        expect(largeMs / Math.max(smallMs, TIMER_FLOOR_MS), name).toBeLessThan(
          MAX_GROWTH_FOR_4X_INPUT,
        );
      }
    });
  }
});
