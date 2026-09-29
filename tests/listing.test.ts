import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";

// An install's first boot registers AGENT_NAME and AGENT_BLURB with the Agent Index, and an install under the
// listing owner's account overwrites the listing with them (2026-09-29: a fresh Natasha renamed the listing). Only
// Nick's images may carry them; the bench takes its name from the Plow agent name it is deployed with.
const file = (path: string) => new URL(`../${path}`, import.meta.url);
const env = (path: string, key: string) => readFileSync(file(path), "utf8").match(new RegExp(`\\b${key}=("[^"]*"|\\S*)`))?.[1];
const here = existsSync(file("bench/Dockerfile"));

test("Nick's image carries the listing's name and blurb", { skip: !here && "Dockerfiles are not in the image" }, () => {
  assert.equal(env("Dockerfile", "AGENT_NAME"), '"Nick Fury"');
  assert.equal(env("Dockerfile", "AGENT_BLURB"), `"Tell me what you're building. I'll assemble your team in one group text."`);
  assert.equal(env("index/Dockerfile", "AGENT_NAME"), undefined, "the Index image inherits Nick's");
});

test("the bench cannot rename or re-describe the listing", { skip: !here && "Dockerfiles are not in the image" }, () => {
  assert.equal(env("bench/Dockerfile", "AGENT_NAME"), "");
  assert.equal(env("bench/Dockerfile", "AGENT_BLURB"), "");
});
