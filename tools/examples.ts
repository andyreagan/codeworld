import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { analyzeJs } from "../src/analyze/js";
import { analyzeMainframeFiles } from "../src/analyze/mainframe";
import type { CodeGraph } from "../src/analyze/types";

/** Every example codebase under examples/: its codeworld.json, its src/ files, and its samples. */
export interface ExampleFiles {
  name: string;
  /** `language: "mainframe"` for a static example (COBOL, JCL...: nothing runs in the page). */
  meta: { title: string; description: string; language?: string };
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

/** An example's code map, from the analyzer for its language. */
export function graphOf(ex: ExampleFiles): CodeGraph {
  const meta = { name: ex.name, title: ex.meta.title, description: ex.meta.description };
  return ex.meta.language === "mainframe" ? analyzeMainframeFiles(ex.files, meta).graph : analyzeJs(ex.files, meta);
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
