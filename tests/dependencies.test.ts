import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(new URL("../plugin/package.json", import.meta.url));

test("the image's channel dependencies match the shared lock", async () => {
  const manifest = JSON.parse(await readFile(new URL("../plugin/package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.deepEqual(lock.packages.plugin?.dependencies, manifest.dependencies);
  for (const name of Object.keys(manifest.dependencies)) {
    const installed = require(`${name}/package.json`);
    assert.equal(installed.version, lock.packages[`node_modules/${name}`].version, name);
  }
});
