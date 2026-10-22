// Codebase -> code map. Analyze a directory of JavaScript and write the code
// map the world is drawn from (src/analyze/types.ts CodeGraph):
//
//   npm run codemap -- <dir> [-o out.codemap.json] [--title "..."] [--no-source]
//
// Open the result in the world with "Open code map…", by dropping it on the
// page, or with ?map=<url>. Nothing is executed: flows are simulated.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { analyzeJs } from "../src/analyze/js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "vendor", "__pycache__"]);
const MAX_FILE = 400_000; // bundles and minified files are skipped

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const noSource = args.includes("--no-source");
const out = flag("-o");
const title = flag("--title");
const dir = args.find((a) => !a.startsWith("--"));
if (!dir) {
  console.error("usage: npm run codemap -- <dir> [-o out.codemap.json] [--title ...] [--no-source]");
  process.exit(2);
}
const root = resolve(dir);
const files: Record<string, string> = {};
const skipped: { path: string; reason: string }[] = [];
const walk = (d: string) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue; // a broken or looping symlink, or no permission
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(e) && !e.startsWith(".")) walk(p);
    } else if (/\.(m|c)?js$/.test(e) && !/\.min\.js$/.test(e)) {
      const rel = relative(root, p).split(sep).join("/");
      if (st.size > MAX_FILE) skipped.push({ path: rel, reason: `too big (${st.size} bytes)` });
      else files[rel] = readFileSync(p, "utf8");
    }
  }
};
walk(root);
const name = basename(root);
const graph = analyzeJs(files, { name, title: title ?? name, description: `Code map of ${root}` }, { lenient: true, source: !noSource });
graph.skipped.push(...skipped);
const file = out ?? `${name}.codemap.json`;
writeFileSync(file, JSON.stringify(graph));
console.log(
  `${file}: ${graph.modules.length} modules, ${graph.fns.length} functions, ${graph.calls.length} calls, ` +
    `${graph.externals.length} external packages, ${graph.skipped.length} files skipped`
);
for (const s of graph.skipped.slice(0, 10)) console.log(`  skipped ${s.path}: ${s.reason}`);
