import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MarkdownPreview, safeMarkdownUrl } from "./MarkdownPreview";

function html(text: string): string {
  const { container } = render(<MarkdownPreview text={text} />);
  return container.innerHTML;
}

describe("MarkdownPreview (AC3: skill text shows a preview)", () => {
  it("renders headings, emphasis, lists and code", () => {
    render(<MarkdownPreview text={"# Title\n\nSome **bold** text\n\n- one\n- two\n\n`code`"} />);
    expect(screen.getByRole("heading", { level: 1, name: "Title" })).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("code").tagName).toBe("CODE");
  });

  it("says so when there is nothing to preview", () => {
    render(<MarkdownPreview text={"   \n"} />);
    expect(screen.getByText("Nothing to preview yet.")).toBeInTheDocument();
  });
});

describe("MarkdownPreview treats the text as untrusted", () => {
  it.each([
    ["a script tag", "<script>window.__pwned = 1</script>hello"],
    ["an inline event handler", '<img src=x onerror="window.__pwned=1">'],
    ["an iframe", '<iframe src="https://evil.example"></iframe>'],
    ["an svg onload", '<svg onload="window.__pwned=1"></svg>'],
    ["a style tag", "<style>body{display:none}</style>"],
  ])("drops raw HTML: %s", (_name, payload) => {
    const out = html(payload);
    expect(out).not.toMatch(/<(script|iframe|svg|style|img)\b/i);
    expect(out).not.toMatch(/onerror|onload/i);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("drops markdown images, so no remote request can be triggered by the text", () => {
    expect(html("![x](https://evil.example/pixel.png)")).not.toContain("<img");
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    " javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "//evil.example/x",
  ])("blanks the link target %j and falls back to plain text", (target) => {
    const out = html(`[click me](<${target}>)`);
    expect(out).not.toMatch(/href=/i);
    expect(out).toContain("click me");
  });

  it("keeps safe links and hardens external ones", () => {
    render(
      <MarkdownPreview text="[docs](https://example.com/a) [mail](mailto:a@example.com) [top](#top)" />,
    );
    const docs = screen.getByRole("link", { name: "docs" });
    expect(docs).toHaveAttribute("href", "https://example.com/a");
    expect(docs).toHaveAttribute("rel", "noopener noreferrer");
    expect(docs).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "mail" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    expect(screen.getByRole("link", { name: "top" })).not.toHaveAttribute("target");
  });
});

describe("safeMarkdownUrl", () => {
  it.each([
    "https://a.example/x",
    "http://a.example",
    "mailto:a@b.example",
    "#anchor",
    "/app/skills",
  ])("allows %s", (url) => {
    expect(safeMarkdownUrl(url)).toBe(url);
  });

  it.each(["javascript:x", "data:text/plain,hi", "//x.example", "ftp://x.example", "", "a b"])(
    "blocks %j",
    (url) => {
      expect(safeMarkdownUrl(url)).toBe("");
    },
  );
});
