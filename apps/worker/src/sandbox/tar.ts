import type { SandboxFile } from "./sandbox-runner.js";

const BLOCK = 512;

function writeField(header: Buffer, offset: number, length: number, value: string): void {
  header.write(value.slice(0, length), offset, "utf8");
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0");
}

/**
 * A minimal ustar archive of regular files (mode 0644), enough for busybox `tar -x`. Paths must already be
 * validated by `validateSandboxRequest`; a name over 100 bytes is split into the ustar prefix here.
 */
export function createTar(files: readonly SandboxFile[]): Buffer {
  const chunks: Buffer[] = [];
  for (const file of files) {
    const body = Buffer.from(file.content, "utf8");
    const header = Buffer.alloc(BLOCK);
    let name = file.path;
    let prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const cut = name.lastIndexOf("/", 155);
      if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) {
        throw new Error("input file path is too long for the archive");
      }
      prefix = name.slice(0, cut);
      name = name.slice(cut + 1);
    }
    writeField(header, 0, 100, name);
    writeField(header, 100, 8, octal(0o644, 8));
    writeField(header, 108, 8, octal(0, 8));
    writeField(header, 116, 8, octal(0, 8));
    writeField(header, 124, 12, octal(body.length, 12));
    writeField(header, 136, 12, octal(0, 12));
    header.fill(0x20, 148, 156); // the checksum field counts as spaces while summing
    header.write("0", 156, "utf8"); // regular file
    header.write("ustar\0", 257, "utf8");
    header.write("00", 263, "utf8");
    writeField(header, 345, 155, prefix);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${octal(sum, 7)}\0 `, 148, "utf8");
    chunks.push(header, body, Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}
