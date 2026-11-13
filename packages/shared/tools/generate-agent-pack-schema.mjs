// Writes (or, with --check, verifies) the committed agent pack JSON Schema (AGO-191).
// Run through `pnpm --filter @ago/shared pack:schema`, which builds first so `dist` is current.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const moduleUrl = pathToFileURL(resolve(root, "dist/packs/agent-pack-json-schema.js")).href;
const { AGENT_PACK_JSON_SCHEMA_PATH, renderAgentPackJsonSchema } = await import(moduleUrl);

const target = resolve(root, AGENT_PACK_JSON_SCHEMA_PATH);
const next = renderAgentPackJsonSchema();

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    // A missing file is stale.
  }
  if (current.replace(/\r\n/g, "\n") !== next) {
    console.error(
      `${AGENT_PACK_JSON_SCHEMA_PATH} is stale. Run: pnpm --filter @ago/shared pack:schema`,
    );
    process.exit(1);
  }
  console.log(`${AGENT_PACK_JSON_SCHEMA_PATH} is up to date.`);
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, next, "utf8");
  console.log(`Wrote ${AGENT_PACK_JSON_SCHEMA_PATH}`);
}
