import type { SandboxFile } from "./sandbox-runner.js";

const BLOCK = 512;
const NAME_BYTES = 100;

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0");
}

/** Writes a 512-byte header. `name` is cut to 100 BYTES (never characters), `magic` is the 8-byte magic+version. */
function createHeader(input: {
  readonly name: Buffer;
  readonly size: number;
  readonly type: "0" | "L";
  readonly magic: string;
}): Buffer {
  const header = Buffer.alloc(BLOCK);
  input.name.subarray(0, NAME_BYTES).copy(header, 0);
  header.write(octal(0o644, 8), 100, "latin1");
  header.write(octal(0, 8), 108, "latin1");
  header.write(octal(0, 8), 116, "latin1");
  header.write(octal(input.size, 12), 124, "latin1");
  header.write(octal(0, 12), 136, "latin1");
  header.fill(0x20, 148, 156); // the checksum field counts as spaces while summing
  header.write(input.type, 156, "latin1");
  header.write(input.magic, 257, "latin1");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${octal(sum, 7)}\0 `, 148, "latin1");
  return header;
}

function padded(data: Buffer): Buffer {
  return Buffer.concat([data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)]);
}

/**
 * A minimal archive of regular files (mode 0644), enough for busybox `tar -x`. Lengths are measured in UTF-8
 * bytes. A name over 100 bytes is carried in a GNU `L` (long name) entry in front of the file, so any path
 * that passed `validateSandboxRequest` (at most 200 characters) fits, multibyte or not, and this never throws.
 */
export function createTar(files: readonly SandboxFile[]): Buffer {
  const chunks: Buffer[] = [];
  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const body = Buffer.from(file.content, "utf8");
    if (name.length > NAME_BYTES) {
      const longName = Buffer.concat([name, Buffer.alloc(1)]);
      chunks.push(
        createHeader({
          name: Buffer.from("././@LongLink", "latin1"),
          size: longName.length,
          type: "L",
          magic: "ustar  \0",
        }),
        padded(longName),
      );
    }
    chunks.push(
      createHeader({ name, size: body.length, type: "0", magic: "ustar\x0000" }),
      padded(body),
    );
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}
