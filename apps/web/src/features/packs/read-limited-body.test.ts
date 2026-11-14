import { describe, expect, it } from "vitest";

import { readLimitedBody } from "./read-limited-body";

function streamOf(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
    cancel() {
      onCancel?.();
    },
  });
}

const encode = (text: string) => new TextEncoder().encode(text);

describe("readLimitedBody", () => {
  it("returns the text of a body within the limit, across chunks and multibyte characters", async () => {
    const bytes = encode("héllo €");
    const result = await readLimitedBody(
      { headers: new Headers(), body: streamOf([bytes.slice(0, 2), bytes.slice(2)]) },
      100,
    );
    expect(result).toEqual({ ok: true, text: "héllo €" });
  });

  it("returns an empty text for no body", async () => {
    expect(await readLimitedBody({ headers: new Headers(), body: null }, 10)).toEqual({
      ok: true,
      text: "",
    });
  });

  it("refuses a declared length over the limit without reading the body", async () => {
    let pulled = false;
    // highWaterMark 0: a stream otherwise pulls one chunk as soon as it is built.
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const result = await readLimitedBody(
      { headers: new Headers({ "content-length": "11" }), body },
      10,
    );
    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(pulled).toBe(false);
  });

  it("cuts off a body that passes the limit despite a missing or false length", async () => {
    let cancelled = false;
    const result = await readLimitedBody(
      {
        headers: new Headers({ "content-length": "3" }),
        body: streamOf([encode("aaaaa"), encode("bbbbb"), encode("ccccc")], () => {
          cancelled = true;
        }),
      },
      8,
    );
    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(cancelled).toBe(true);
  });

  it("accepts a body of exactly the limit", async () => {
    expect(
      await readLimitedBody({ headers: new Headers(), body: streamOf([encode("12345678")]) }, 8),
    ).toEqual({ ok: true, text: "12345678" });
  });

  it("reports an unreadable body without throwing", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("socket closed"));
      },
    });
    expect(await readLimitedBody({ headers: new Headers(), body }, 8)).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });
});
