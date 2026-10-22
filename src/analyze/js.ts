import { parse, type Comment, type Node } from "acorn";
import { simple } from "acorn-walk";
import type { CallEdge, CodeGraph, FnNode, ModuleNode, Trigger } from "./types";

/**
 * Static analysis of an ES-module JavaScript codebase into a CodeGraph, and
 * the matching instrumentation that lets the world watch it run.
 *
 * What counts:
 * - every top-level `function` declaration (exported or not) is a machine;
 * - a call to one, by local name, named import or namespace import
 *   (`ns.fn()`), anywhere in another's body, is a belt; so is naming one
 *   (handing it over as a callback);
 * - doc-comment tags mark the edges of the system:
 *     file comment   `@store`                  module is a data store
 *     function       `@route POST /orders`     an HTTP-ish entry point
 *                    `@example {"sku": "A1"}`  sample JSON body for it
 *                    `@inbox *.csv`            a file-drop entry point
 *                    `@sample samples/x.csv`   a sample file for it
 *                    `@cron 5s`                a timer entry point
 *
 * Arrow functions bound to consts, classes and methods aren't machines yet.
 */

interface FnDecl extends Node {
  type: "FunctionDeclaration";
  id: { name: string };
  params: Node[];
  body: Node;
}

interface Parsed {
  path: string;
  source: string;
  ast: Node & { body: Node[] };
  comments: Comment[];
  decls: { decl: FnDecl; exported: boolean; start: number }[];
  /** local name -> [module or ext:pkg, imported name, or "*" for a namespace]. */
  bindings: Map<string, [string, string]>;
  imports: string[];
}

const lineOf = (src: string, pos: number): number => {
  let n = 1;
  for (let i = 0; i < pos; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
};

/** `./x` from `a/b.js` -> `a/x.js`; bare specifiers -> `ext:name`. */
export function resolveSpec(from: string, spec: string): string {
  if (!spec.startsWith(".")) return `ext:${spec}`;
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  const p = parts.join("/");
  return p.endsWith(".js") ? p : `${p}.js`;
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

function parseModule(path: string, source: string): Parsed {
  const comments: Comment[] = [];
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", onComment: comments, locations: false }) as Parsed["ast"];
  const decls: Parsed["decls"] = [];
  const bindings = new Map<string, [string, string]>();
  const imports = new Set<string>();
  for (const st of ast.body as any[]) {
    if (st.type === "FunctionDeclaration") decls.push({ decl: st, exported: false, start: st.start });
    else if (st.type === "ExportNamedDeclaration" && st.declaration?.type === "FunctionDeclaration")
      decls.push({ decl: st.declaration, exported: true, start: st.start });
    else if (st.type === "ExportDefaultDeclaration" && st.declaration?.type === "FunctionDeclaration" && st.declaration.id)
      decls.push({ decl: st.declaration, exported: true, start: st.start });
    else if (st.type === "ImportDeclaration") {
      const mod = resolveSpec(path, st.source.value);
      imports.add(mod);
      for (const s of st.specifiers) {
        if (s.type === "ImportNamespaceSpecifier") bindings.set(s.local.name, [mod, "*"]);
        else if (s.type === "ImportDefaultSpecifier") bindings.set(s.local.name, [mod, "default"]);
        else bindings.set(s.local.name, [mod, s.imported.name ?? s.imported.value]);
      }
    }
  }
  return { path, source, ast, comments, decls, bindings, imports: [...imports] };
}

const BRANCHY = new Set([
  "IfStatement", "ConditionalExpression", "ForStatement", "ForInStatement", "ForOfStatement",
  "WhileStatement", "DoWhileStatement", "CatchClause"
]);

/** Analyze a codebase given as `{ relative/path.js: source }`. */
export function analyzeJs(
  files: Record<string, string>,
  meta: { name: string; title: string; description: string }
): CodeGraph {
  const parsed = Object.entries(files)
    .filter(([p]) => p.endsWith(".js"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, s]) => parseModule(p, s));
  const known = new Set(parsed.map((p) => p.path));
  const modules: ModuleNode[] = [];
  const fns: FnNode[] = [];
  const edges = new Map<string, CallEdge>();
  const externals = new Set<string>();
  const pending: { from: string; mod: string; name: string }[] = [];

  for (const p of parsed) {
    // the file comment: the comment block the file opens with
    const c0 = p.comments[0];
    const fileDoc = c0 && p.source.slice(0, c0.start).trim() === "" ? docBefore(p.source, p.comments, firstGapEnd(p.source, p.comments)) : "";
    const mt = tags(fileDoc);
    for (const imp of p.imports) {
      if (imp.startsWith("ext:")) externals.add(imp);
      else if (!known.has(imp)) throw new Error(`${p.path}: imports ${imp}, which isn't in the codebase`);
    }
    const local = new Set(p.decls.map((d) => d.decl.id.name));
    const mod: ModuleNode = {
      id: p.path,
      dir: p.path.includes("/") ? p.path.slice(0, p.path.lastIndexOf("/")) : "",
      doc: mt.text,
      loc: p.source.split("\n").filter((l) => l.trim()).length,
      store: mt.tags.some(([k]) => k === "store"),
      fns: [],
      imports: p.imports,
      source: p.source
    };
    modules.push(mod);
    for (const { decl, exported, start } of p.decls) {
      const id = `${p.path}#${decl.id.name}`;
      const dt = tags(docBefore(p.source, p.comments, start));
      let complexity = 1;
      const calls: [string, string][] = [];
      simple(decl.body, {
        // a function named (called, or handed over as a callback: `.map(capitalize)`)
        Identifier(n: any) {
          if (local.has(n.name)) calls.push([p.path, n.name]);
          else {
            const b = p.bindings.get(n.name);
            if (b && b[1] !== "*") calls.push([b[0], b[1]]);
          }
        },
        MemberExpression(n: any) {
          if (n.object.type !== "Identifier" || n.computed) return;
          const b = p.bindings.get(n.object.name);
          if (b && b[1] === "*") calls.push([b[0], n.property.name]);
        },
        LogicalExpression() {
          complexity++;
        },
        SwitchCase(n: any) {
          if (n.test) complexity++;
        }
      });
      simple(decl.body, Object.fromEntries([...BRANCHY].map((t) => [t, () => complexity++])));
      for (const [m, name] of calls) if (!m.startsWith("ext:")) pending.push({ from: id, mod: m, name });
      const line = lineOf(p.source, start);
      const endLine = lineOf(p.source, decl.end);
      fns.push({
        id,
        module: p.path,
        name: decl.id.name,
        exported,
        params: decl.params.map((x: any) => (x.type === "Identifier" ? x.name : x.type === "AssignmentPattern" ? x.left.name : "…")),
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
  for (const { from, mod, name } of pending) {
    const to = `${mod}#${name}`;
    if (!fnIds.has(to)) continue; // a const, a class, or something the analyzer doesn't model
    const k = `${from}->${to}`;
    const e = edges.get(k);
    if (e) e.count++;
    else edges.set(k, { from, to, count: 1 });
  }
  return { ...meta, language: "javascript", modules, fns, calls: [...edges.values()], externals: [...externals].map((e) => e.slice(4)) };
}

/**
 * Instrument one module: rebind each top-level function to a traced wrapper
 * (`globalThis.__cw.wrap`). Function declarations are hoisted, mutable
 * bindings, and ES imports are live bindings, so every caller (in this
 * module or any other) ends up calling the wrapper. It goes on line 1 so
 * line numbers don't move.
 */
export function instrumentJs(path: string, source: string): string {
  const p = parseModule(path, source);
  if (!p.decls.length) return source;
  const wraps = p.decls
    .map(({ decl }) => `${decl.id.name} = globalThis.__cw.wrap(${JSON.stringify(`${path}#${decl.id.name}`)}, ${decl.id.name});`)
    .join(" ");
  return `${wraps} ${source}`;
}
