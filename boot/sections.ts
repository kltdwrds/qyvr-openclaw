import { readdir, readFile } from "node:fs/promises";

/** The base prompt plus the sections an image variant adds as files (prompt/sections/*.md), in name order. */
export async function loadPrompt(dir: string): Promise<string> {
  const base = await readFile(`${dir}/AGENTS.md`, "utf8");
  const names = (await readdir(`${dir}/sections`).catch(() => [] as string[])).filter(name => name.endsWith(".md")).sort();
  const sections = await Promise.all(names.map(name => readFile(`${dir}/sections/${name}`, "utf8")));
  return [base, ...sections].map(text => text.trim()).join("\n\n") + "\n";
}
