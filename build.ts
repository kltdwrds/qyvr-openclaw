import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

for (const name of ["boot/agent-index", "boot/config", "boot/identity", "boot/prompt", "boot/main", "boot/process", "boot/probe", "boot/probe-fixture", "boot/mcp-bridge", "plugin/index", "plugin/transport", "plugin/buzz", "plugin/buzz-identity"]) {
  const source = await readFile(`/opt/plow/${name}.ts`, "utf8");
  const output = name.startsWith("plugin/") ? name.replace("plugin/", "plugin/dist/") : name;
  await mkdir(`/opt/plow/${output.substring(0, output.lastIndexOf("/"))}`, { recursive: true });
  await writeFile(`/opt/plow/${output}.js`, stripTypeScriptTypes(source.replaceAll(/(from "\.\/[^"\n]+)\.ts"/g, '$1.js"')));
}
// The vendored buzz-kit bundle is already JavaScript; the buzz channel imports it beside its compiled files.
await copyFile("/opt/plow/plugin/buzz-kit.mjs", "/opt/plow/plugin/dist/buzz-kit.mjs");
await writeFile("/opt/plow/probe", '#!/usr/bin/env node\nimport "./boot/probe.js";\n');
