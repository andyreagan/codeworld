import { parse, type Comment, type Node } from "acorn";
import { simple } from "acorn-walk";
import { CODEMAP_FORMAT, type CallEdge, type CodeGraph, type FnNode, type ModuleNode, type Trigger } from "./types";

/**
 * Static analysis of an ES-module JavaScript codebase into a CodeGraph, and
 * the matching instrumentation that lets the world watch it run.
 *
 * What counts as a machine: every top-level function, whether a `function`
 * declaration, a function or arrow bound to a top-level `const`/`let`/`var`,
 * a `module.exports.x = function`, or a method of a top-level class
 * (`Class.method`, and `Class.constructor`).
 *
 * What counts as a belt: naming one from another's body (calling it, or
 * handing it over as a callback), by local name, ES or CommonJS import
 * (named, default or namespace: `ns.fn()`), `this.method()` inside a class,
 * `Class.staticMethod()` or `new Class()`.
 *
 * - doc-comment tags mark the edges of the system:
 *     file comment   `@store`                  module is a data store
 *     function       `@route POST /orders`     an HTTP-ish entry point
 *                    `@example {"sku": "A1"}`  sample JSON body for it
 *                    `@inbox *.csv`            a file-drop entry point
 *                    `@sample samples/x.csv`   a sample file for it
 *                    `@cron 5s`                a timer entry point
 *
 * Only the hoisted `function` declarations can be traced when the code
 * runs (see instrumentJs); the rest are mapped, and simulated.
 */

/** A function the analyzer found: a future machine. */
interface Def {
  /** `name`, or `Class.method`. */
  name: string;
  params: any[];
  body: Node;
  /** Where its doc comment ends (the statement's start), and where it ends. */
  start: number;
  end: number;
  exported: boolean;
  /** A `function` declaration: a mutable, hoisted binding the tracer can rebind. */
  hoisted: boolean;
  cls?: string;
}

interface Parsed {
  path: string;
  source: string;
  ast: Node & { body: Node[] };
  comments: Comment[];
  defs: Def[];
  classes: Set<string>;
  /** What `export default` / `module.exports =` names. */
  defaultName?: string;
  /** local name -> [module or ext:pkg, imported name, or "*" for a namespace]. */
  bindings: Map<string, [string, string]>;
  imports: string[];
  /** A classic script: its top-level names are globals every other script sees. */
  script: boolean;
}

/** `a.b.c` for a member chain of plain names, else null. */
function dotted(n: any): string | null {
  if (n.type === "Identifier") return n.name;
  if (n.type !== "MemberExpression" || n.computed || n.property.type !== "Identifier") return null;
  const o = dotted(n.object);
  return o === null ? null : `${o}.${n.property.name}`;
}

/** Line starts of the last file looked at (one analysis reads one file at a time). */
let linesOf: { src: string; starts: number[] } = { src: "", starts: [0] };

/** 1-based line of offset `pos`, by binary search over the file's line starts. */
function lineOf(src: string, pos: number): number {
  if (linesOf.src !== src) {
    const starts = [0];
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
    linesOf = { src, starts };
  }
  const starts = linesOf.starts;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** `./x` from `a/b.js` -> `a/x.js`; bare specifiers -> `ext:name`. */
export function resolveSpec(from: string, spec: string): string {
  if (!spec.startsWith(".")) return `ext:${spec}`;
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  const p = parts.join("/");
  return /\.(m|c)?js$/.test(p) ? p : `${p}.js`;
}

/** The comments ending just before `pos` (no blank line between, nor between each other), as plain text. */
function docBefore(src: string, comments: Comment[], pos: number): string {
  const lines: string[] = [];
  let end = pos;
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!;
    if (c.end > end) continue;
    const gap = src.slice(c.end, end);
    if (gap.trim() !== "" || (gap.match(/\n/g)?.length ?? 0) > 1) break;
    lines.unshift(c.value);
    end = c.start;
  }
  return lines
    .join("\n")
    .split("\n")
    .map((l) => l.replace(/^\s*\*?\s?/, "").trimEnd())
    .join("\n")
    .trim();
}

/** Where the file's opening run of comments ends. */
function firstGapEnd(src: string, comments: Comment[]): number {
  let end = comments[0]!.end;
  for (const c of comments.slice(1)) {
    const gap = src.slice(end, c.start);
    if (gap.trim() !== "" || (gap.match(/\n/g)?.length ?? 0) > 1) break;
    end = c.end;
  }
  return end;
}

const tagRe = /^@(\w+)\s*(.*)$/;

function tags(doc: string): { text: string; tags: [string, string][] } {
  const text: string[] = [];
  const out: [string, string][] = [];
  for (const l of doc.split("\n")) {
    const m = tagRe.exec(l.trim());
    if (m) out.push([m[1]!, m[2]!.trim()]);
    else if (out.length === 0) text.push(l);
  }
  const para = text.join("\n").split(/\n\s*\n/)[0] ?? "";
  return { text: para.replace(/\s+/g, " ").trim(), tags: out };
}

const seconds = (s: string): number => {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(s);
  if (!m) throw new Error(`bad @cron interval: ${s}`);
  const v = Number(m[1]);
  return m[2] === "ms" ? v / 1000 : m[2] === "m" ? v * 60 : v;
};

function triggersOf(t: [string, string][], where: string): Trigger[] {
  const out: Trigger[] = [];
  for (const [k, v] of t) {
    if (k === "route") {
      const [method, path] = v.split(/\s+/);
      if (!method || !path) throw new Error(`${where}: @route wants "METHOD /path"`);
      out.push({ kind: "route", method: method.toUpperCase(), path });
    } else if (k === "example") {
      const last = out.findLast((x) => x.kind === "route");
      if (!last || last.kind !== "route") throw new Error(`${where}: @example before any @route`);
      last.example = JSON.parse(v);
    } else if (k === "inbox") out.push({ kind: "inbox", glob: v });
    else if (k === "sample") {
      const last = out.findLast((x) => x.kind === "inbox");
      if (!last || last.kind !== "inbox") throw new Error(`${where}: @sample before any @inbox`);
      last.sample = v;
    } else if (k === "cron") out.push({ kind: "cron", every: seconds(v) });
  }
  return out;
}

const fnLike = (n: any): boolean => n?.type === "FunctionExpression" || n?.type === "ArrowFunctionExpression";

/** `module.exports.x` / `exports.x` -> "x"; `module.exports` -> ""; else null. */
function cjsExport(n: any): string | null {
  if (n?.type !== "MemberExpression" || n.computed) return null;
  if (n.object.type === "Identifier" && n.object.name === "module" && n.property.name === "exports") return "";
  if (n.object.type === "Identifier" && n.object.name === "exports") return n.property.name;
  if (cjsExport(n.object) === "") return n.property.name;
  return null;
}

function parseModule(path: string, source: string, sourceType: "module" | "script" = "module"): Parsed {
  const comments: Comment[] = [];
  const ast = parse(source, {
    ecmaVersion: "latest", sourceType, allowHashBang: true, allowReturnOutsideFunction: sourceType === "script", onComment: comments, locations: false
  }) as Parsed["ast"];
  const p: Parsed = { path, source, ast, comments, defs: [], classes: new Set(), bindings: new Map(), imports: [], script: sourceType === "script" };
  const imports = new Set<string>();
  const declare = (d: any, exported: boolean, start: number): void => {
    if (d.type === "FunctionDeclaration" && d.id)
      p.defs.push({ name: d.id.name, params: d.params, body: d.body, start, end: d.end, exported, hoisted: true });
    else if (d.type === "ClassDeclaration" && d.id) {
      p.classes.add(d.id.name);
      for (const m of d.body.body) {
        const value = m.type === "MethodDefinition" ? m.value : m.type === "PropertyDefinition" && fnLike(m.value) ? m.value : null;
        if (!value || m.computed || m.key.type !== "Identifier") continue;
        p.defs.push({ name: `${d.id.name}.${m.key.name}`, params: value.params, body: value.body, start: m.start, end: m.end, exported, hoisted: false, cls: d.id.name });
      }
    } else if (d.type === "VariableDeclaration")
      for (const v of d.declarations) {
        if (v.id.type === "Identifier" && fnLike(v.init))
          p.defs.push({ name: v.id.name, params: v.init.params, body: v.init.body, start: d.declarations.length === 1 ? start : v.start, end: v.end, exported, hoisted: false });
        else if (v.init?.type === "CallExpression" && v.init.callee.name === "require" && typeof v.init.arguments[0]?.value === "string") {
          const mod = resolveSpec(path, v.init.arguments[0].value);
          imports.add(mod);
          if (v.id.type === "Identifier") p.bindings.set(v.id.name, [mod, "*"]);
          else if (v.id.type === "ObjectPattern")
            for (const pr of v.id.properties)
              if (pr.type === "Property" && pr.key.type === "Identifier" && pr.value.type === "Identifier") p.bindings.set(pr.value.name, [mod, pr.key.name]);
        }
      }
  };
  const exportedNames = new Set<string>();
  for (const st of ast.body as any[]) {
    if (st.type === "ExportNamedDeclaration") {
      if (st.declaration) declare(st.declaration, true, st.start);
      for (const sp of st.specifiers ?? []) exportedNames.add(sp.local.name);
    } else if (st.type === "ExportDefaultDeclaration") {
      if (st.declaration.id) {
        declare(st.declaration, true, st.start);
        p.defaultName = st.declaration.id.name;
      } else if (st.declaration.type === "Identifier") p.defaultName = st.declaration.name;
    } else if (st.type === "ImportDeclaration") {
      const mod = resolveSpec(path, st.source.value);
      imports.add(mod);
      for (const s of st.specifiers) {
        if (s.type === "ImportNamespaceSpecifier") p.bindings.set(s.local.name, [mod, "*"]);
        else if (s.type === "ImportDefaultSpecifier") p.bindings.set(s.local.name, [mod, "default"]);
        else p.bindings.set(s.local.name, [mod, s.imported.name ?? s.imported.value]);
      }
    } else if (st.type === "ExpressionStatement" && st.expression.type === "AssignmentExpression") {
      // CommonJS: module.exports.x = function () {}, module.exports = x, module.exports = { a, b }
      const { left, right } = st.expression;
      const name = cjsExport(left);
      if (name === null) {
        // a namespace member: hedotools.shifter = function () {}
        const ns = dotted(left);
        if (ns?.includes(".") && fnLike(right)) p.defs.push({ name: ns, params: right.params, body: right.body, start: st.start, end: st.end, exported: true, hoisted: false });
        continue;
      }
      if (name && fnLike(right)) p.defs.push({ name, params: right.params, body: right.body, start: st.start, end: st.end, exported: true, hoisted: false });
      else if (name && right.type === "Identifier") exportedNames.add(right.name);
      else if (name === "" && right.type === "Identifier") p.defaultName = right.name;
      else if (name === "" && right.type === "ObjectExpression")
        for (const pr of right.properties) if (pr.value?.type === "Identifier") exportedNames.add(pr.value.name);
    } else declare(st, false, st.start);
  }
  for (const d of p.defs) if (exportedNames.has(d.name)) d.exported = true;
  if (p.defaultName) for (const d of p.defs) if (d.name === p.defaultName) d.exported = true;
  p.imports = [...imports];
  return p;
}

const BRANCHY = new Set([
  "IfStatement", "ConditionalExpression", "ForStatement", "ForInStatement", "ForOfStatement",
  "WhileStatement", "DoWhileStatement", "CatchClause"
]);

/** Analyze a codebase given as `{ relative/path.js: source }`. */
export function analyzeJs(
  files: Record<string, string>,
  meta: { name: string; title: string; description: string },
  /** Real-world code: skip files that don't parse, treat unresolvable imports as external, keep no source. */
  opts: { lenient?: boolean; source?: boolean } = {}
): CodeGraph {
  const skipped: CodeGraph["skipped"] = [];
  const parsed: Parsed[] = [];
  for (const [p, s] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/\.(m|c)?js$/.test(p)) continue;
    try {
      parsed.push(parseModule(p, s, opts.lenient && !/\b(import|export)\b/.test(s) ? "script" : "module"));
    } catch (e) {
      if (!opts.lenient) throw e;
      try {
        parsed.push(parseModule(p, s, "script")); // CommonJS, or an old-style script
      } catch {
        skipped.push({ path: p, reason: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  const known = new Set(parsed.map((p) => p.path));
  // `./dir` may mean `./dir/index.js`
  const resolve = (imp: string) => (known.has(imp) || imp.startsWith("ext:") ? imp : known.has(imp.replace(/\.js$/, "/index.js")) ? imp.replace(/\.js$/, "/index.js") : null);
  const modules: ModuleNode[] = [];
  const fns: FnNode[] = [];
  const edges = new Map<string, CallEdge>();
  const externals = new Set<string>();
  const pending: { from: string; mod: string; name: string; at: number }[] = [];
  // classic scripts share one global scope: their top-level functions, by (dotted) name
  const globals = new Map<string, string>();
  for (const p of parsed) if (p.script) for (const d of p.defs) if (!d.cls && !globals.has(d.name)) globals.set(d.name, p.path);

  for (const p of parsed) {
    // the file comment: the comment block the file opens with
    const c0 = p.comments[0];
    const fileDoc = c0 && p.source.slice(0, c0.start).trim() === "" ? docBefore(p.source, p.comments, firstGapEnd(p.source, p.comments)) : "";
    const mt = tags(fileDoc);
    for (const [local, [mod, name]] of p.bindings) {
      const r = resolve(mod);
      if (r) p.bindings.set(local, [r, name]);
      else if (opts.lenient) p.bindings.set(local, [`ext:${mod}`, name]);
    }
    p.imports = p.imports.map((imp) => {
      const r = resolve(imp);
      if (r) return r;
      if (!opts.lenient) throw new Error(`${p.path}: imports ${imp}, which isn't in the codebase`);
      return `ext:${imp}`;
    });
    for (const imp of p.imports) if (imp.startsWith("ext:")) externals.add(imp);
    const local = new Set(p.defs.filter((d) => !d.cls).map((d) => d.name));
    const mod: ModuleNode = {
      id: p.path,
      dir: p.path.includes("/") ? p.path.slice(0, p.path.lastIndexOf("/")) : "",
      doc: mt.text,
      loc: p.source.split("\n").filter((l) => l.trim()).length,
      store: mt.tags.some(([k]) => k === "store"),
      fns: [],
      imports: p.imports,
      source: opts.source === false ? "" : p.source
    };
    modules.push(mod);
    const seen = new Set<string>();
    for (const def of p.defs) {
      const { exported, start } = def;
      const id = `${p.path}#${def.name}`;
      if (seen.has(id)) continue; // redeclared (sloppy scripts): the first one stands for it
      seen.add(id);
      const dt = tags(docBefore(p.source, p.comments, start));
      let complexity = 1;
      const calls: [string, string, number][] = [];
      simple(def.body, {
        // a function named (called, or handed over as a callback: `.map(capitalize)`)
        Identifier(n: any) {
          if (local.has(n.name)) calls.push([p.path, n.name, n.start]);
          else {
            const b = p.bindings.get(n.name);
            // a CommonJS module required whole and called is its default export
            if (b) calls.push([b[0], b[1] === "*" ? "default" : b[1], n.start]);
            else if (globals.has(n.name)) calls.push([globals.get(n.name)!, n.name, n.start]);
          }
        },
        MemberExpression(n: any) {
          if (n.computed || n.property.type !== "Identifier") return;
          const prop = n.property.name;
          if (n.object.type === "ThisExpression" && def.cls) calls.push([p.path, `${def.cls}.${prop}`, n.start]);
          const chain = dotted(n);
          if (chain && globals.has(chain)) calls.push([globals.get(chain)!, chain, n.start]);
          if (n.object.type !== "Identifier") return;
          if (p.classes.has(n.object.name)) return void calls.push([p.path, `${n.object.name}.${prop}`, n.start]);
          const b = p.bindings.get(n.object.name);
          if (b) calls.push([b[0], b[1] === "*" ? prop : `${b[1]}.${prop}`, n.start]);
        },
        NewExpression(n: any) {
          if (n.callee.type !== "Identifier") return;
          if (p.classes.has(n.callee.name)) return void calls.push([p.path, `${n.callee.name}.constructor`, n.start]);
          const b = p.bindings.get(n.callee.name);
          if (b) calls.push([b[0], `${b[1] === "*" ? "default" : b[1]}.constructor`, n.start]);
        },
        LogicalExpression() {
          complexity++;
        },
        SwitchCase(n: any) {
          if (n.test) complexity++;
        }
      });
      simple(def.body, Object.fromEntries([...BRANCHY].map((t) => [t, () => complexity++])));
      for (const [m, name, at] of calls) if (!m.startsWith("ext:")) pending.push({ from: id, mod: m, name, at: lineOf(p.source, at) });
      const line = lineOf(p.source, start);
      const endLine = lineOf(p.source, def.end);
      fns.push({
        id,
        module: p.path,
        name: def.name,
        exported,
        params: def.params.map((x: any) => (x.type === "Identifier" ? x.name : x.type === "AssignmentPattern" ? x.left.name : "…")),
        loc: endLine - line + 1,
        complexity,
        doc: dt.text,
        line,
        endLine,
        triggers: triggersOf(dt.tags, id)
      });
      mod.fns.push(id);
    }
  }

  const fnIds = new Set(fns.map((f) => f.id));
  const defaults = new Map(parsed.map((p) => [p.path, p.defaultName]));
  for (const { from, mod, name: raw, at } of pending) {
    // `default` (or `default.x`) is whatever the module exports as default
    const dflt = defaults.get(mod);
    const name = raw === "default" || raw.startsWith("default.") ? (dflt ? dflt + raw.slice(7) : raw) : raw;
    const to = `${mod}#${name}`;
    if (to === from) continue; // recursion
    if (!fnIds.has(to)) continue; // a const, a class, or something the analyzer doesn't model
    const k = `${from}->${to}`;
    const e = edges.get(k);
    if (e) {
      e.count++;
      e.line = Math.min(e.line, at);
    } else edges.set(k, { from, to, count: 1, line: at });
  }
  return {
    format: CODEMAP_FORMAT, ...meta, language: "javascript", modules, fns, calls: [...edges.values()],
    externals: [...externals].map((e) => e.slice(4)), skipped
  };
}

/**
 * Instrument one module: rebind each top-level function to a traced wrapper
 * (`globalThis.__cw.wrap`). Function declarations are hoisted, mutable
 * bindings, and ES imports are live bindings, so every caller (in this
 * module or any other) ends up calling the wrapper. It goes on line 1 so
 * line numbers don't move.
 */
export function instrumentJs(path: string, source: string): string {
  const defs = parseModule(path, source).defs.filter((d) => d.hoisted);
  if (!defs.length) return source;
  const wraps = defs.map((d) => `${d.name} = globalThis.__cw.wrap(${JSON.stringify(`${path}#${d.name}`)}, ${d.name});`).join(" ");
  return `${wraps} ${source}`;
}
