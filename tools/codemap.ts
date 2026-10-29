// Codebase -> code map. Analyze a directory and write the code map the
// world is drawn from (src/analyze/types.ts CodeGraph):
//
//   npm run codemap -- <dir> [-o out.codemap.json] [--title "..."] [--no-source]
//                            [--lang js|mainframe] [--from NAME[,NAME...]] [--lineage N] [--depth N]
//
// JavaScript, or a mainframe source library (COBOL, copybooks, JCL and
// PROCs, assembler, Easytrieve, Fortran, IDEAL): whichever the directory
// mostly holds, unless --lang says. A mainframe is far too big for one
// world, so --from cuts out what some jobs, programs or datasets reach
// (names or globs: --from 'PBNIGHT,PB*'); --depth N stops N hops from
// one program (or job, or dataset) into the next, since shared utilities
// otherwise pull in half the shop; --lineage N also follows the data:
// N rounds of "and the jobs that read what these wrote".
// Without -o, a mainframe run only prints its inventory.
//
// Open the result in the world with "Open map…", by dropping it on the
// page, or with ?map=<url>. Nothing is executed: flows are simulated.
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { analyzeJs } from "../src/analyze/js";
import { analyzeMainframe, slice, sniff, type MfKind } from "../src/analyze/mainframe";
import type { CodeGraph } from "../src/analyze/types";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "vendor", "__pycache__"]);
const MAX_JS = 400_000; // bundles and minified files are skipped
const MAX_MF = 20_000_000; // a 200k-line COBOL program is big but real

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
const lang = flag("--lang");
const from = flag("--from")?.split(",").map((s) => s.trim()).filter(Boolean);
const lineage = Number(flag("--lineage") ?? 0);
const depth = Number(flag("--depth") ?? Infinity);
const dir = args.find((a) => !a.startsWith("--"));
if (!dir) {
  console.error("usage: npm run codemap -- <dir> [-o out.codemap.json] [--title ...] [--no-source] [--lang js|mainframe] [--from NAMES] [--depth N] [--lineage N]");
  process.exit(2);
}
const root = resolve(dir);
const name = basename(root);
const rel = (p: string) => relative(root, p).split(sep).join("/");

/**
 * A file's text. Mainframe members sometimes arrive as fixed 80-byte
 * records with no newlines (a binary transfer of a card-image library):
 * those are cut back into lines. EBCDIC and binaries are refused.
 */
function textOf(bytes: Buffer): string | { reason: string } {
  const head = bytes.subarray(0, 4096);
  if (head.includes(0)) return { reason: "binary" };
  let high = 0;
  for (const b of head) if (b >= 0x80) high++;
  // EBCDIC: letters are 0xC1-0xE9 and the space is 0x40, so most bytes are high
  if (head.length && high / head.length > 0.3) return { reason: "looks like EBCDIC: transfer it as text (ASCII) first" };
  let t = bytes.toString("latin1");
  if (!t.includes("\n") && t.length % 80 === 0 && t.length > 80) t = t.match(/.{80}/g)!.join("\n");
  return t;
}

function headOf(p: string, n = 6000): Buffer {
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(n);
    return buf.subarray(0, readSync(fd, buf, 0, n, 0));
  } finally {
    closeSync(fd);
  }
}

const js: Record<string, string> = {};
const mf = new Map<string, MfKind>();
const skipped: { path: string; reason: string }[] = [];
let unrecognized = 0;
const walk = (d: string) => {
  let entries: string[];
  try {
    entries = readdirSync(d);
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(d, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue; // a broken or looping symlink, or no permission
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(e) && !e.startsWith(".")) walk(p);
      continue;
    }
    if (/\.(m|c)?js$/.test(e) && lang !== "mainframe") {
      if (/\.min\.js$/.test(e)) continue;
      if (st.size > MAX_JS) skipped.push({ path: rel(p), reason: `too big (${st.size} bytes)` });
      else js[rel(p)] = readFileSync(p, "utf8");
      continue;
    }
    if (lang === "js" || st.size === 0) continue;
    if (st.size > MAX_MF) {
      skipped.push({ path: rel(p), reason: `too big (${st.size} bytes)` });
      continue;
    }
    const head = textOf(headOf(p));
    if (typeof head !== "string") {
      skipped.push({ path: rel(p), reason: head.reason });
      continue;
    }
    const kind = sniff(rel(p), head);
    if (kind) mf.set(rel(p), kind);
    else unrecognized++;
  }
};
const t0 = Date.now();
walk(root);

let graph: CodeGraph;
const useMf = lang === "mainframe" || (lang !== "js" && mf.size > Object.keys(js).length);
if (useMf) {
  const read = (p: string) => {
    const t = textOf(readFileSync(join(root, p)));
    return typeof t === "string" ? t : "";
  };
  const built = analyzeMainframe(mf, read, { name, title: title ?? name, description: `Code map of ${root}` }, { source: false });
  const r = built.report;
  const n = (x: number) => x.toLocaleString("en-US");
  console.log(`${root}: read in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  members:   ${Object.entries(r.members).map(([k, v]) => `${n(v)} ${k}`).join(", ")}${unrecognized ? `; ${n(unrecognized)} files not recognised` : ""}`);
  console.log(`  programs:  ${n(r.programs)} (${n(r.paragraphs)} paragraphs), ${n(r.loc)} lines of code`);
  console.log(`  jobs:      ${n(r.jobs)} (${n(r.steps)} steps)`);
  console.log(`  data:      ${n(r.datasets)} datasets, ${n(r.tables)} DB2 tables`);
  console.log(`  map:       ${n(built.graph.modules.length)} modules, ${n(built.graph.fns.length)} functions, ${n(built.graph.calls.length)} belts`);
  const list = (label: string, xs: string[]) => xs.length && console.log(`  ${label} (${n(xs.length)}): ${xs.slice(0, 12).join(", ")}${xs.length > 12 ? ", …" : ""}`);
  list("not in source", r.notFound.map(([p, c]) => `${p}×${c}`));
  list("missing copybooks", r.missingCopybooks);
  list("missing PROCs/INCLUDEs", r.missingProcs);
  list("defined twice, first kept", r.duplicates);
  if (r.unresolvedCalls) console.log(`  CALL <identifier> not worked out: ${n(r.unresolvedCalls)}`);
  graph = from ? slice(built, from, lineage, depth) : built.graph;
  if (from) console.log(`  slice --from ${from.join(",")}${lineage ? ` --lineage ${lineage}` : ""}${depth < Infinity ? ` --depth ${depth}` : ""}: ${n(graph.modules.length)} modules, ${n(graph.fns.length)} functions, ${n(graph.calls.length)} belts`);
  if (from && !graph.modules.length) console.log("  (nothing matched: names are job names, program names, dataset names, or module paths; globs like 'PB*' work)");
  if (graph.modules.length > 1500) console.log(`  that's a lot for one world: try ${from ? "--depth" : "--from"} to cut it down`);
  if (!noSource) for (const m of graph.modules) if (mf.has(m.id)) m.source = read(m.id);
  if (!out) {
    console.log("(no -o: inventory only)");
    process.exit(0);
  }
} else {
  graph = analyzeJs(js, { name, title: title ?? name, description: `Code map of ${root}` }, { lenient: true, source: !noSource });
}
graph.skipped.push(...skipped);
const file = out ?? `${name}.codemap.json`;
writeFileSync(file, JSON.stringify(graph));
console.log(
  `${file}: ${graph.modules.length} modules, ${graph.fns.length} functions, ${graph.calls.length} calls, ` +
    `${graph.externals.length} external, ${graph.skipped.length} files skipped`
);
for (const s of graph.skipped.slice(0, 10)) console.log(`  skipped ${s.path}: ${s.reason}`);
