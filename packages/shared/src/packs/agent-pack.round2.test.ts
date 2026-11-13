import { describe, expect, it, vi } from "vitest";

import { findSecretShape, parseAgentPack } from "./index.js";
import { SECRET_VALUE_PATTERNS } from "../redaction/redact.js";

// Pack-level ratio tests parse many notes several times, so give every test here room on a slow runner.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Round 2 tests for AGO-191: the secret scan must run in linear time on hostile text, still detect
 * credential URLs after the scheme bound, and never echo a secret value in an issue message.
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

function agent0(pack: Loose): Loose {
  return (pack.agents as Loose[])[0]!;
}

/** A 4x longer input should cost about 4x more in a linear scan and about 16x in a quadratic one. */
const MAX_GROWTH_FOR_4X_INPUT = 11;
/** Below this the timer is noise, so a growth ratio is measured against it, not against ~0 ms. */
const TIMER_FLOOR_MS = 2;

function timeIt(run: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/**
 * Time `parseAgentPack` on `count` notes that each hold `length` characters of hostile text.
 * Pack tests compare a short and a 4x longer note, not an absolute time: a loaded CI runner
 * changes absolute times but not the growth.
 */
function timeParseOfNotes(
  build: (n: number) => string,
  length: number,
  count: number,
): { ms: number; ok: boolean } {
  const body = build(length).slice(0, length);
  const pack = validPack();
  pack.notes = Array.from({ length: count }, () => ({ title: "n", body }));
  let ok = false;
  const ms = timeIt(() => {
    ok = parseAgentPack(pack).ok;
  });
  return { ms, ok };
}

// Hostile text builders. Each takes a target length.
const hostile: Record<string, (n: number) => string> = {
  "a. repeated": (n) => "a.".repeat(n / 2),
  "a+ repeated": (n) => "a+".repeat(n / 2),
  "a- repeated": (n) => "a-".repeat(n / 2),
  "scheme characters with no ://": (n) => "abc1+.-".repeat(Math.ceil(n / 7)).slice(0, n),
  "scheme-like text then :// and no credentials": (n) => "a.".repeat(n / 2) + "://",
  "x:// then a long run with no colon or at-sign": (n) => "x://" + "h".repeat(n),
  "user: then a long password with no at-sign": (n) => "user:" + "p".repeat(n),
  "a: repeated": (n) => "a:".repeat(n / 2),
  "a:// then b: repeated": (n) => "a://" + "b:".repeat(n / 2),
  "a://u: then a long password with no at-sign": (n) => "a://u:" + "p".repeat(n),
  "a:// repeated": (n) => "a://".repeat(n / 4),
  "a://u: repeated": (n) => "a://u:".repeat(n / 6),
  "mixed unicode": (n) => "é日本\u{1F600}a.-+:/".repeat(Math.ceil(n / 10)).slice(0, n),
  "digits only": (n) => "1".repeat(n),
  "ghp_ repeated": (n) => "ghp_".repeat(n / 4),
  "sk- repeated": (n) => "sk-".repeat(n / 3),
  "JWT-like head, no dot, dashes between": (n) => ("eyJ" + "a".repeat(10) + "-").repeat(n / 14),
  "JWT-like head and second part, bad tail": (n) =>
    ("eyJ" + "a".repeat(10) + ".eyJ" + "a".repeat(8) + ".b ").repeat(n / 26),
  "Telegram-like head, no tail": (n) =>
    ("1".repeat(9) + ":AA" + "a".repeat(30) + " ").repeat(n / 43),
  "AKIA repeated": (n) => "AKIA".repeat(n / 4),
  "PEM header repeated": (n) => "-----BEGIN ".repeat(n / 11),
};

const SMALL = 20_000;
const LARGE = 4 * SMALL;

describe("AC (security round 1): the secret scan is linear on hostile text", () => {
  for (const [label, build] of Object.entries(hostile)) {
    it(`findSecretShape finishes fast and grows linearly when the text is ${label}`, () => {
      const small = build(SMALL);
      const large = build(LARGE);
      const smallMs = timeIt(() => findSecretShape(small));
      const largeMs = timeIt(() => findSecretShape(large));
      expect(largeMs / Math.max(smallMs, TIMER_FLOOR_MS)).toBeLessThan(MAX_GROWTH_FOR_4X_INPUT);
    });
  }

  it("findSecretShape returns no label for hostile scheme text", () => {
    expect(findSecretShape("a.".repeat(10_000))).toBeNull();
    expect(findSecretShape("a+".repeat(10_000))).toBeNull();
    expect(findSecretShape("a-".repeat(10_000))).toBeNull();
    expect(findSecretShape("a://".repeat(5000))).toBeNull();
  });

  describe("each pattern of the scan on its own", () => {
    // The JWT and URL shapes live in agent-pack-schemas.ts and are private; they are reached through
    // findSecretShape above. The shared patterns are exported, so check them one by one.
    for (const [pattern, label] of SECRET_VALUE_PATTERNS) {
      it(`the ${label} pattern grows linearly on every hostile text`, () => {
        for (const [name, build] of Object.entries(hostile)) {
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

  it("parseAgentPack cost grows linearly with note length when every note is scheme-like text", () => {
    for (const label of [
      "a. repeated",
      "a+ repeated",
      "a- repeated",
      "a:// then b: repeated",
      "a://u: then a long password with no at-sign",
      "a:// repeated",
      "mixed unicode",
    ]) {
      const small = timeParseOfNotes(hostile[label]!, 5_000, 50);
      const large = timeParseOfNotes(hostile[label]!, 20_000, 50);
      expect(small.ok, label).toBe(true);
      expect(large.ok, label).toBe(true);
      expect(large.ms / Math.max(small.ms, TIMER_FLOOR_MS), label).toBeLessThan(
        MAX_GROWTH_FOR_4X_INPUT,
      );
    }
  });

  it("parseAgentPack cost grows linearly with note length when 20 notes look like the start of a JWT", () => {
    const build = hostile["JWT-like head, no dot, dashes between"]!;
    const small = timeParseOfNotes(build, 5_000, 20);
    const large = timeParseOfNotes(build, 20_000, 20);
    expect(small.ok).toBe(true);
    expect(large.ok).toBe(true);
    expect(large.ms / Math.max(small.ms, TIMER_FLOOR_MS)).toBeLessThan(MAX_GROWTH_FOR_4X_INPUT);
  });
});

describe("AC (security round 1): credentials in URLs are still found, ordinary text is not flagged", () => {
  const withCredentials = (scheme: string) =>
    scheme + "://" + "us" + "er:" + "pa55" + "@host.example.com/x";

  it.each([
    ["postgres", "postgres"],
    ["https", "https"],
    ["a scheme with a plus and a dash", "git+ssh"],
    ["a scheme with a dot", "svc.v2"],
    ["an uppercase scheme", "HTTPS"],
    ["a 31-character scheme (the longest the bound covers)", "a".repeat(31)],
  ])("findSecretShape flags a password in a URL when the URL has %s", (_label, scheme) => {
    expect(findSecretShape(withCredentials(scheme))).toBe("password in a URL");
  });

  it("findSecretShape flags the shortest form postgres://u:p@h", () => {
    expect(findSecretShape("postgres://" + "u:p" + "@h")).toBe("password in a URL");
  });

  it("findSecretShape flags a credential URL when it sits inside prose", () => {
    expect(findSecretShape("Connect with " + withCredentials("mysql") + " then retry.")).toBe(
      "password in a URL",
    );
  });

  it("findSecretShape flags a credential URL after a long scheme-like run broken by a dash", () => {
    expect(findSecretShape("a".repeat(60) + "-" + withCredentials("ssh"))).toBe(
      "password in a URL",
    );
  });

  it.each([
    "See https://example.com/docs for details.",
    "http://localhost:3000/api/items?id=4",
    "https://example.com:8443/path",
    "ftp://files.example.com/pub/readme.txt",
    "Email me at someone@example.com about it.",
    "ratio is 10:30 at the office, see mailto:someone@example.com",
    "git+ssh://git@github.com/org/repo.git",
    "The password is stored in the broker, never in the pack.",
  ])("findSecretShape returns null for ordinary text: %s", (text) => {
    expect(findSecretShape(text)).toBeNull();
  });
});

describe("AC (security round 1): no secret value is echoed in any issue", () => {
  const secrets = {
    anthropicKey: ["sk", "ant", "q".repeat(32)].join("-"),
    jwt: ["eyJ" + "h".repeat(12), "eyJ" + "p".repeat(10), "s".repeat(14)].join("."),
    postgresUrl: "post" + "gres://app_user:" + "pa55w0rd" + "@db.internal:5432/app",
    github: "gh" + "p_" + "a1".repeat(18),
  };

  function everywhere(secret: string): [string, (pack: Loose) => void][] {
    return [
      ["agent prompt", (p) => (agent0(p).prompt = `Use ${secret} when asked.`)],
      ["agent role", (p) => (agent0(p).role = secret)],
      ["agent model", (p) => (agent0(p).model = secret)],
      ["agent department", (p) => (agent0(p).department = secret)],
      ["agent name", (p) => (agent0(p).name = secret)],
      [
        "duplicate agent name",
        (p) => {
          const second = { ...agent0(p), name: secret };
          agent0(p).name = secret;
          (p.agents as Loose[]).push(second);
        },
      ],
      ["skill body", (p) => ((p.skills as Loose[])[0]!.body = `key: ${secret}`)],
      ["skill name", (p) => ((p.skills as Loose[])[0]!.name = secret)],
      [
        "duplicate skill name",
        (p) =>
          (p.skills as Loose[]).push(
            { name: "Outreach", version: 1, body: "x" },
            {
              name: secret,
              version: 1,
              body: "x",
            },
            { name: secret, version: 1, body: "y" },
          ),
      ],
      ["skill name listed by an agent but not in the pack", (p) => (agent0(p).skills = [secret])],
      [
        "skill name listed twice by an agent",
        (p) => {
          (p.skills as Loose[]).push({ name: secret, version: 1, body: "x" });
          agent0(p).skills = [secret, secret];
        },
      ],
      ["note title", (p) => ((p.notes as Loose[])[0]!.title = secret)],
      ["note body", (p) => ((p.notes as Loose[])[0]!.body = `see ${secret}`)],
      ["metadata name", (p) => ((p.metadata as Loose).name = secret)],
      ["metadata appVersion", (p) => ((p.metadata as Loose).appVersion = secret)],
      ["metadata exportedAt", (p) => ((p.metadata as Loose).exportedAt = secret)],
      ["$schema", (p) => (p.$schema = secret)],
      ["capability name", (p) => (agent0(p).capabilities = [{ name: secret, scope: "workspace" }])],
      [
        "capability name listed twice",
        (p) =>
          (agent0(p).capabilities = [
            { name: secret, scope: "workspace" },
            { name: secret, scope: "agent" },
          ]),
      ],
      [
        "capability scope",
        (p) => (agent0(p).capabilities = [{ name: "vault.read", scope: secret }]),
      ],
      ["secretRefs entry", (p) => (agent0(p).secretRefs = [secret])],
      [
        "secretRefs entry with the secret after the prefix",
        (p) => (agent0(p).secretRefs = ["secret:" + secret]),
      ],
      [
        "secretRefs listed twice",
        (p) => (agent0(p).secretRefs = ["secret:" + secret, "secret:" + secret]),
      ],
      ["thinkingEffort", (p) => (agent0(p).thinkingEffort = secret)],
      ["autonomyMode", (p) => (agent0(p).autonomyMode = secret)],
      ["dailyBudgetCents as text", (p) => (agent0(p).dailyBudgetCents = secret)],
      ["packVersion as text", (p) => (p.packVersion = secret)],
      ["a string where the pack should be an object", () => undefined],
    ];
  }

  for (const [secretLabel, secret] of Object.entries(secrets)) {
    for (const [place, mutate] of everywhere(secret)) {
      it(`the parse result does not contain the ${secretLabel} when it is placed in: ${place}`, () => {
        const pack = validPack();
        mutate(pack);
        const result = parseAgentPack(
          place === "a string where the pack should be an object" ? secret : pack,
        );
        expect(JSON.stringify(result)).not.toContain(secret);
      });
    }
  }

  it("the parse result does not contain the secret when several places hold it at once", () => {
    const secret = secrets.anthropicKey;
    const pack = validPack();
    for (const [, mutate] of everywhere(secret).slice(0, 8)) mutate(pack);
    const result = parseAgentPack(pack);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("an issue for a secret-shaped name says it looks like a secret and still names the path", () => {
    const pack = validPack();
    (pack.skills as Loose[]).push({ name: secrets.github, version: 1, body: "x" });
    (pack.skills as Loose[]).push({ name: secrets.github, version: 1, body: "y" });
    const result = parseAgentPack(pack);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((i) => i.message.includes("used twice"));
      expect(issue?.path).toBe("skills.2.name");
      expect(issue?.message).toContain("looks like a secret");
    }
  });

  it("an issue for an ordinary duplicate name still quotes the name", () => {
    const pack = validPack();
    (pack.skills as Loose[]).push({ name: "Outreach", version: 1, body: "y" });
    const result = parseAgentPack(pack);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.message)).toContain('Skill name "Outreach" is used twice.');
    }
  });

  it("an issue for a secret-shaped value points at the value's path without repeating it", () => {
    const pack = validPack();
    (pack.notes as Loose[])[0]!.body = `token ${secrets.anthropicKey}`;
    const result = parseAgentPack(pack);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        {
          path: "notes.0.body",
          message:
            "Looks like a Anthropic API key. A pack never holds secret values; use a secret:<name> reference.",
        },
      ]);
    }
  });
});
