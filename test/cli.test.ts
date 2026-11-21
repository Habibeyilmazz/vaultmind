import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { tempVault } from "./helpers.ts";

const run = promisify(execFile);

test("search --json carries no highlight control characters in snippets", async () => {
  const dir = tempVault();
  const { stdout } = await run(process.execPath, [join(import.meta.dirname, "../src/cli.ts"), "search", "starter", "--vault", dir, "--db", join(dir, "i.db"), "--no-embed", "--json"]);
  const result = JSON.parse(stdout);
  assert.ok(result.hits.length > 0);
  for (const hit of result.hits) assert.doesNotMatch(hit.snippet, /[\u0001\u0002]/);
});
