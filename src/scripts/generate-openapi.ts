import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildV1Document } from "../openapi/v1.js";

/**
 * Writes the committed contract snapshot (docs/api/openapi-v1.json) so API changes show up in PR diffs.
 * `--check` fails when the snapshot is stale (run in CI). Needs no environment variables.
 */
const OUTPUT = path.resolve(import.meta.dirname, "../../docs/api/openapi-v1.json");

const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
const next = `${JSON.stringify(buildV1Document(), null, 2)}\n`;

if (values.check) {
  const current = await readFile(OUTPUT, "utf8").catch(() => "");
  if (current !== next) {
    console.error(`${path.relative(process.cwd(), OUTPUT)} is stale. Run: npm run openapi`);
    process.exitCode = 1;
  } else {
    console.log("OpenAPI snapshot is up to date");
  }
} else {
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, next);
  console.log(`Wrote ${path.relative(process.cwd(), OUTPUT)}`);
}
