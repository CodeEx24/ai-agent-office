// Copies the GLBs owned by @ago/assets into apps/web/public/models (gitignored), so the one
// canonical binary lives in packages/assets and Next can still serve it as a static file.
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, "../../../packages/assets/models");
const target = path.resolve(here, "../public/models");

mkdirSync(target, { recursive: true });
for (const file of readdirSync(source).filter((name) => name.endsWith(".glb"))) {
  cpSync(path.join(source, file), path.join(target, file));
}
