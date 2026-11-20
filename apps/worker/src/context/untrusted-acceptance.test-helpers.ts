import { expect } from "vitest";

/** Shared by the AGO-23 acceptance tests: a strict parser for a built prompt. */

export interface ParsedBlock {
  readonly label: string;
  readonly body: string;
}

export interface ParsedPrompt {
  readonly id: string;
  readonly blocks: readonly ParsedBlock[];
  /** The user message with every well-formed block removed. */
  readonly outside: string;
  /** How many times the id appears in the user message (must be exactly twice per block). */
  readonly idOccurrences: number;
}

/** The id the system rule announces. Independent of the code under test: read from the text only. */
export function announcedBoundaryId(system: string): string {
  const id = /carries the id ([0-9a-f]+)\./.exec(system)?.[1];
  expect(id, "the system rule announces the boundary id").toBeDefined();
  return id ?? "";
}

/** Parse the user message the way a careful model would: a block is found and ended only by the announced id. */
export function parsePrompt(system: string, user: string): ParsedPrompt {
  const id = announcedBoundaryId(system);
  const open = `<untrusted_data id="${id}" source="`;
  const close = `\n</untrusted_data id="${id}">`;
  const blocks: ParsedBlock[] = [];
  let outside = "";
  let cursor = 0;
  for (;;) {
    const start = user.indexOf(open, cursor);
    if (start === -1) break;
    outside += user.slice(cursor, start);
    const labelEnd = user.indexOf('">\n', start + open.length);
    expect(labelEnd, "an opening tag is complete").toBeGreaterThan(-1);
    const end = user.indexOf(close, labelEnd);
    expect(end, "every block is closed by its own id").toBeGreaterThan(-1);
    blocks.push({
      label: user.slice(start + open.length, labelEnd),
      body: user.slice(labelEnd + 3, end),
    });
    cursor = end + close.length;
  }
  outside += user.slice(cursor);
  return { id, blocks, outside, idOccurrences: user.split(id).length - 1 };
}
