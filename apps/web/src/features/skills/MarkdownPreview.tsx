import Markdown, { type Components } from "react-markdown";

/**
 * Renders skill text as Markdown. The text is untrusted data (CLAUDE.md: pack and skill text), so:
 *  - raw HTML in the text is dropped (`skipHtml`, and react-markdown never enables `rehype-raw`);
 *  - `img`, `script`, `iframe`, `style` and friends are removed even if produced some other way;
 *  - a link survives only if it is http(s), mailto, a `#anchor` or a site-relative path, so
 *    `javascript:`, `data:` and `vbscript:` URLs are blanked and the link falls back to plain text;
 *  - external links open with `rel="noopener noreferrer"`.
 * Nothing here uses `dangerouslySetInnerHTML`, so it also works under the strict script CSP (AGO-66).
 */

const SAFE_URL = /^(?:https?:\/\/|mailto:|#|\/(?!\/))/i;

/** Allow-list for link targets. Anything else becomes an empty string. */
export function safeMarkdownUrl(url: string): string {
  const trimmed = url.trim();
  // Control characters or spaces inside the URL are a classic way to hide `java\tscript:`.
  // eslint-disable-next-line no-control-regex
  const hasHiddenChars = /[\u0000- \u007f-\u009f]/.test(trimmed);
  return SAFE_URL.test(trimmed) && !hasHiddenChars ? trimmed : "";
}

const DISALLOWED_ELEMENTS = [
  "img",
  "script",
  "iframe",
  "style",
  "object",
  "embed",
  "form",
  "input",
];

const components: Components = {
  a({ href, children }) {
    if (!href) return <span>{children}</span>;
    const isExternal = /^(?:https?:|mailto:)/i.test(href);
    return (
      <a
        href={href}
        rel="noopener noreferrer"
        {...(isExternal ? { target: "_blank" } : {})}
        className="text-primary underline underline-offset-4"
      >
        {children}
      </a>
    );
  },
  h1: ({ children }) => <h1 className="mt-4 mb-2 text-xl font-bold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-4 mb-2 text-lg font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc pl-6">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal pl-6">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-muted p-3 text-sm">{children}</pre>
  ),
  code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 text-sm">{children}</code>,
};

/** Safe Markdown rendering of untrusted skill text. Works on the server and in the browser. */
export function MarkdownPreview({ text }: { text: string }) {
  return (
    <div data-testid="markdown-preview" className="min-w-0 text-sm break-words">
      {text.trim() ? (
        <Markdown
          skipHtml
          disallowedElements={DISALLOWED_ELEMENTS}
          urlTransform={safeMarkdownUrl}
          components={components}
        >
          {text}
        </Markdown>
      ) : (
        <p className="text-muted-foreground">Nothing to preview yet.</p>
      )}
    </div>
  );
}
