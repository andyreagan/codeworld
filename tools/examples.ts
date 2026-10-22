import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Every example codebase under examples/: its codeworld.json, its src/ files, and its samples. */
export interface ExampleFiles {
  name: string;
  meta: { title: string; description: string };
  files: Record<string, string>;
  samples: Record<string, string>;
}

function walk(dir: string, root: string, out: Record<string, string>): void {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, root, out);
    else out[relative(root, p)] = readFileSync(p, "utf8");
  }
}

export function readExamples(root: string): ExampleFiles[] {
  return readdirSync(root)
    .filter((n) => statSync(join(root, n, "codeworld.json"), { throwIfNoEntry: false }))
    .sort()
    .map((name) => {
      const dir = join(root, name);
      const files: Record<string, string> = {};
      walk(join(dir, "src"), join(dir, "src"), files);
      const samples: Record<string, string> = {};
      if (statSync(join(dir, "samples"), { throwIfNoEntry: false })) walk(join(dir, "samples"), dir, samples);
      return { name, meta: JSON.parse(readFileSync(join(dir, "codeworld.json"), "utf8")), files, samples };
    });
}
