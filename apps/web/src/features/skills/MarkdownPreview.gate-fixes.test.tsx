import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MarkdownPreview, safeMarkdownUrl } from "./MarkdownPreview";

// AGO-128 QA (gate fix round 2): independent probes of the link allow-list. CI-safe: no stack, no browser.
// A link is "contained" when it either does not exist (plain text) or resolves to this origin / an allowed scheme.

const ORIGIN = "http://app.example";

function anchorsOf(markdown: string): { text: string; resolved: URL }[] {
  const { container } = render(<MarkdownPreview text={markdown} />);
  return [...container.querySelectorAll("a")].map((a) => ({
    text: a.textContent,
    resolved: new URL(a.getAttribute("href") ?? "", ORIGIN),
  }));
}

describe("AGO-128 gate fix: no link can leave the site through a path-looking target", () => {
  const BAD_TARGETS = [
    ["slash-backslash", "</\\evil.com>"],
    ["protocol-relative", "<//evil.com>"],
    ["double backslash", "<\\\\evil.com>"],
    ["encoded backslash", "</%5Cevil.com>"],
    ["lower-case encoded backslash", "</%5cevil.com>"],
    ["javascript scheme", "<javascript:alert(1)>"],
    ["mixed-case javascript scheme", "<JaVaScRiPt:alert(1)>"],
    ["data scheme", "<data:text/html,<b>x</b>>"],
    ["entity-encoded backslash", "</&#92;evil.com>"],
    ["entity-encoded second slash", "</&#47;evil.com>"],
    ["tab inside the scheme", "<java&#9;script:alert(1)>"],
  ] as const;

  it.each(BAD_TARGETS)("%s renders as plain text, not a link", (_name, target) => {
    const { container } = render(<MarkdownPreview text={`[bad](${target})`} />);
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.innerHTML).not.toMatch(/href=/i);
    expect(container.textContent).toContain("bad");
  });

  it("an entity-encoded newline stays a percent-encoded path segment on this origin", () => {
    const links = anchorsOf("[nl](</&#10;/evil.com>)");
    for (const { resolved } of links) expect(resolved.origin).toBe(ORIGIN);
  });

  it("covers reference-style links and autolinks the same way", () => {
    const text = "[ref][r]\n\n[r]: //evil.com\n\n<https://ok.example/a>\n\n<//evil.com>";
    const links = anchorsOf(text);
    expect(links.map((l) => l.resolved.href)).toEqual(["https://ok.example/a"]);
  });

  it("keeps the good links working, and every surviving link stays on this origin or an allowed scheme", () => {
    const links = anchorsOf(
      "[ok](https://ok.example) [app](/app/skills) [mail](mailto:a@b.example) [top](#top) [bad](<//evil.com>) [bad2](</\\evil.com>)",
    );
    expect(links.map((l) => l.text)).toEqual(["ok", "app", "mail", "top"]);
    for (const { resolved } of links) {
      const allowed =
        resolved.origin === ORIGIN ||
        resolved.origin === "https://ok.example" ||
        resolved.protocol === "mailto:";
      expect(allowed, resolved.href).toBe(true);
    }
  });

  it("is idempotent and total: safeMarkdownUrl never returns a target that resolves off-origin for a path", () => {
    for (const candidate of ["/a", "/a/b?x=1#y", "/%255Cstill-a-path", "/app/skills"]) {
      const out = safeMarkdownUrl(candidate);
      expect(out).toBe(candidate);
      expect(new URL(out, ORIGIN).origin).toBe(ORIGIN);
    }
    for (const candidate of [
      "/\\x",
      "//x",
      "\\\\x",
      "\\x",
      "/%5Cx",
      "/\t/x",
      "/\n/x",
      "\u0000/x",
    ]) {
      expect(safeMarkdownUrl(candidate), JSON.stringify(candidate)).toBe("");
    }
  });
});
