import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadPrompt } from "../boot/sections.ts";

test("the prompt is AGENTS.md then each section in name order", async () => {
  const dir = await mkdtemp(`${tmpdir()}/prompt-`);
  await mkdir(`${dir}/sections`);
  await writeFile(`${dir}/AGENTS.md`, "# Base\n");
  await writeFile(`${dir}/sections/member.md`, "## Member\n");
  await writeFile(`${dir}/sections/bench.md`, "## Bench\n");
  await writeFile(`${dir}/sections/notes.txt`, "ignored");
  assert.equal(await loadPrompt(dir), "# Base\n\n## Bench\n\n## Member\n");
});

test("no sections directory is just AGENTS.md", async () => {
  const dir = await mkdtemp(`${tmpdir()}/prompt-`);
  await writeFile(`${dir}/AGENTS.md`, "# Base\n");
  assert.equal(await loadPrompt(dir), "# Base\n");
});

test("the release prompt keeps the homeroom, now as a section", async () => {
  const base = await readFile(new URL("../prompt/AGENTS.md", import.meta.url), "utf8");
  assert.ok(!base.includes("## The qyvr homeroom"));
  assert.match(await loadPrompt(new URL("../prompt", import.meta.url).pathname), /## The qyvr homeroom[\s\S]*head-of-talent skill\.\n$/);
});
