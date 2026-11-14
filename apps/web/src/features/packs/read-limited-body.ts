/**
 * Reads a request body as text with a hard byte limit (AGO-193). A pack upload is untrusted, so the size is
 * enforced on the bytes as they arrive: a declared `Content-Length` over the limit is refused without reading
 * anything, and a body with no or a false length is cut off the moment it passes the limit, so memory use
 * never exceeds the limit plus one chunk. Nothing is parsed here.
 */

export type LimitedBody =
  { ok: true; text: string } | { ok: false; reason: "too_large" | "unreadable" };

export async function readLimitedBody(
  request: { headers: Headers; body: ReadableStream<Uint8Array> | null },
  maxBytes: number,
): Promise<LimitedBody> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) return { ok: false, reason: "too_large" };
  }
  if (request.body === null) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder("utf-8").decode(bytes) };
}
