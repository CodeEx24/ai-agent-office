"use client";

import { useState } from "react";

/** Characters shown before the "Show more" control appears. */
export const EXPANDABLE_TEXT_LIMIT = 280;

/**
 * Untrusted agent or tool text (AGO-153). It is rendered as a React text node only: no HTML, no Markdown, no links.
 * A long text is cut at `limit` characters with an expand control, so one huge message cannot take over the page.
 */
export function ExpandableText({
  text,
  limit = EXPANDABLE_TEXT_LIMIT,
}: {
  readonly text: string;
  readonly limit?: number;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isLong = text.length > limit;
  const shown = isLong && !isExpanded ? `${text.slice(0, limit)}…` : text;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
      <p className="text-sm wrap-anywhere whitespace-pre-wrap">{shown}</p>
      {isLong ? (
        <button
          type="button"
          className="min-h-6 w-fit py-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
          aria-expanded={isExpanded}
          onClick={() => {
            setIsExpanded((value) => !value);
          }}
        >
          {isExpanded ? "Show less" : `Show more (${String(text.length - limit)} more characters)`}
        </button>
      ) : null}
    </div>
  );
}
