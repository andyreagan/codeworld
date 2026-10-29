import { parseCobol, SYSTEM_CALL, type CobolProgram, type Op } from "./cobol";
import { jclKind, parseJcl, type Job } from "./jcl";
import { CODEMAP_FORMAT, type CallEdge, type CodeGraph, type FnNode, type ModuleNode, type Trigger } from "./types";

/**
 * A mainframe source library -> a code map. Members are sorted by
 * language (extension, library name, then content), each parsed on its
 * own, then linked by name the way the system links them at run time:
 *
 * - a COBOL program is a module, its paragraphs the functions;
 * - a job is a module whose functions are the job (an entry point: a dock
 *   you submit it from) and its steps, in order;
 * - a step calls the program it runs, and reads or writes datasets;
 *   when the program's own source says which file the DD is (SELECT ...
 *   ASSIGN TO dd), the belt runs from that file's machine instead, so a run
 *   goes job -> step -> program -> paragraph -> file -> dataset;
 * - datasets, DB2 tables and CICS files are stores (tank farms), with a
 *   READ and a WRITE machine;
 * - programs called but not in the source (vendor code, missing libraries)
 *   get a placeholder pad under `ext/`.
 *
 * Assembler, Easytrieve Plus and Fortran get a lighter read (entry points,
 * calls, files); IDEAL and anything else recognisable is a single machine.
 *
 * A whole shop is far too big for one world, so `slice` cuts out what a
 * set of jobs or programs reaches.
 */

export type MfKind = "cobol" | "copybook" | "jcl" | "asm" | "ezt" | "fortran" | "ideal";

const EXT: Record<string, MfKind> = {
  cbl: "cobol", cob: "cobol", cobol: "cobol", ccp: "cobol", sqb: "cobol", pco: "cobol", cbx: "cobol",
  cpy: "copybook", copy: "copybook", cpb: "copybook", dclgen: "copybook",
  jcl: "jcl", job: "jcl", jcls: "jcl", proc: "jcl", prc: "jcl", cntl: "jcl", inc: "jcl",
  asm: "asm", mac: "asm", mlc: "asm", hlasm: "asm", assemble: "asm",
  ezt: "ezt", ezp: "ezt", easy: "ezt", eztrieve: "ezt",
  f: "fortran", for: "fortran", f77: "fortran", ftn: "fortran", fortran: "fortran",
  idl: "ideal", ideal: "ideal"
};
const LIB: [RegExp, MfKind][] = [
  [/COPY|CPY|COPYLIB|DCLGEN/, "copybook"],
  [/COBOL|CBL|COB\b|SRCLIB/, "cobol"],
  [/JCL|CNTL|PROCLIB|PROC|JOBS?\b/, "jcl"],
  [/ASM|MACLIB|ASSEM|MACRO/, "asm"],
  [/EZT|EASY/, "ezt"],
  [/FORT/, "fortran"],
  [/IDEAL/, "ideal"]
];

/** What a member is, from its name and its first few KB; null if it's none of ours. */
export function sniff(path: string, head: string): MfKind | null {
  const base = path.split("/").pop()!;
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  const lib = path.toUpperCase().split("/").slice(0, -1).reverse().map((d) => LIB.find(([re]) => re.test(d))?.[1]).find(Boolean);
  const hint = EXT[ext] ?? lib;
  const code = head.split(/\r?\n/).filter((l) => l.trim() && !/^\/\/\*|^\s*\*/.test(l) && !/^.{6}\*/.test(l));
  if (code[0]?.startsWith("//")) return "jcl";
  if (/\b(IDENTIFICATION|ID)\s+DIVISION\b|\bPROGRAM-ID\b/i.test(head)) return "cobol";
  if (hint === "cobol" || hint === "copybook") return /^.{6}[ *]\s*(0[1-9]|[1-4]\d|66|77|88)\s+[A-Z0-9-]+/im.test(head) || hint === "copybook" ? "copybook" : null;
  if (/^[A-Z@#$][A-Z0-9@#$]{0,7}\s+(CSECT|RSECT|START|DSECT)\b|^\s+(MACRO|AMODE|RMODE)\b/im.test(head)) return "asm";
  if (hint === "ezt" || (/^\s*FILE\s+[A-Z]/im.test(head) && /^\s*JOB\s+INPUT\b/im.test(head))) return "ezt";
  if (hint === "fortran" || hint === "ideal" || hint === "asm") return hint;
  return null;
}

/** The member name a file holds: its basename, extension dropped, upper case. */
export const memberOf = (path: string): string => path.split("/").pop()!.replace(/\.[^.]*$/, "").toUpperCase();

/** One unit of a non-COBOL program: an entry point or a callable piece of it. */
interface Unit {
  name: string;
  line: number;
  endLine: number;
  loc: number;
  complexity: number;
  calls: { to: string; line: number }[];
  progs: { name: string; line: number }[];
  files: { file: string; op: Op; line: number }[];
}

interface Lite {
  kind: "asm" | "ezt" | "fortran" | "ideal";
  /** Names other programs can call it by (its member name first). */
  names: string[];
  units: Unit[];
  files: { name: string; dd: string; mode: Op | "both" | null }[];
  doc: string;
  loc: number;
}

const unit = (name: string, line: number): Unit => ({ name, line, endLine: line, loc: 0, complexity: 1, calls: [], progs: [], files: [] });

/** Assembler: CSECT names, LINK / XCTL / LOAD / CALL targets, DCBs (files, by DDNAME). */
function parseAsm(text: string, member: string): Lite {
  // join continuations (a non-blank column 72 continues on the next line, from column 16)
  const stmts: { label: string; op: string; ops: string; line: number }[] = [];
  const lines = text.split(/\r?\n/);
  let doc = "";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith("*") || l.startsWith(".*")) {
      if (!doc && /[a-z]{3}/i.test(l)) doc = l.replace(/^\.?\*+|\*+$/g, "").trim();
      continue;
    }
    let s = l.slice(0, 71);
    const at = i + 1;
    while (lines[i]!.length > 71 && lines[i]![71] !== " " && i + 1 < lines.length) s += lines[++i]!.slice(15, 71);
    const m = /^(\S*)\s+(\S+)\s*(\S*)/.exec(s);
    if (m) stmts.push({ label: m[1]!.toUpperCase(), op: m[2]!.toUpperCase(), ops: m[3]!.toUpperCase(), line: at });
  }
  const csects = stmts.filter((s) => /^(CSECT|RSECT|START)$/.test(s.op) && s.label).map((s) => s.label);
  const u = unit(member, 1);
  u.endLine = lines.length;
  u.loc = stmts.length;
  const files: Lite["files"] = [];
  // DCBs usually sit at the end, after the GETs and PUTs that use them
  for (const s of stmts) {
    const m = s.op === "DCB" && s.label ? /DDNAME=([A-Z0-9#@$]+)/.exec(s.ops) : null;
    if (!m) continue;
    const macrf = /MACRF=\(?([A-Z,]+)/.exec(s.ops)?.[1] ?? "";
    files.push({ name: s.label, dd: m[1]!, mode: /G/.test(macrf) && /P/.test(macrf) ? "both" : /P/.test(macrf) ? "write" : "read" });
  }
  for (const s of stmts) {
    let m: RegExpExecArray | null;
    if (/^(LINK|XCTL|LOAD)$/.test(s.op) && (m = /EP=([A-Z0-9#@$]+)/.exec(s.ops))) u.progs.push({ name: m[1]!, line: s.line });
    else if (s.op === "CALL" && (m = /^([A-Z#@$][A-Z0-9#@$]*)/.exec(s.ops))) {
      if (!SYSTEM_CALL.test(m[1]!)) u.progs.push({ name: m[1]!, line: s.line });
    } else if (/^(GET|PUT|READ|WRITE)$/.test(s.op)) {
      const f = s.ops.split(",")[0]!;
      if (files.some((x) => x.name === f)) u.files.push({ file: f, op: /^(GET|READ)$/.test(s.op) ? "read" : "write", line: s.line });
    } else if (/^(B|BC|BAL|BALR|BAS|BASR|BCT|BXH|BXLE)$|^B[A-Z]{1,2}$/.test(s.op)) u.complexity += s.op === "B" || s.op === "BALR" || s.op === "BASR" ? 0 : 1;
  }
  return { kind: "asm", names: [member, ...csects], units: [u], files, doc, loc: stmts.length };
}

/** Easytrieve Plus: FILEs (DD names), the JOB activity, `name. PROC` blocks, PERFORM, CALL. */
function parseEzt(text: string, member: string): Lite {
  const lines = text.split(/\r?\n/);
  const main = unit(member, 1);
  const units = [main];
  const files: Lite["files"] = [];
  let cur = main;
  let doc = "";
  lines.forEach((raw, i) => {
    const l = raw.slice(0, 72).trim().toUpperCase();
    const no = i + 1;
    if (!l) return;
    if (l.startsWith("*")) {
      if (!doc && /[A-Z]{3}/.test(l)) doc = raw.replace(/^\s*\*+|\*+\s*$/g, "").trim();
      return;
    }
    let m: RegExpExecArray | null;
    if ((m = /^([A-Z0-9-]+)\.\s+PROC\b/.exec(l))) {
      cur = unit(m[1]!, no);
      units.push(cur);
    } else if (/^END-PROC\b/.test(l)) {
      cur.endLine = no;
      cur.loc++;
      cur = main;
      return;
    } else if ((m = /^FILE\s+([A-Z0-9#@$]+)/.exec(l))) files.push({ name: m[1]!, dd: m[1]!, mode: null });
    cur.loc++;
    cur.endLine = no;
    if ((m = /^JOB\s+INPUT\s+\(?([A-Z0-9#@$]+)/.exec(l))) main.files.push({ file: m[1]!, op: "read", line: no });
    for (const p of l.matchAll(/\bPERFORM\s+([A-Z0-9-]+)/g)) cur.calls.push({ to: p[1]!, line: no });
    for (const c of l.matchAll(/\bCALL\s+([A-Z0-9#@$]+)/g)) if (!SYSTEM_CALL.test(c[1]!)) cur.progs.push({ name: c[1]!, line: no });
    for (const g of l.matchAll(/\b(GET|READ|PUT|WRITE)\s+([A-Z0-9#@$]+)/g))
      if (files.some((f) => f.name === g[2])) cur.files.push({ file: g[2]!, op: g[1] === "GET" || g[1] === "READ" ? "read" : "write", line: no });
    cur.complexity += (l.match(/\b(IF|ELSE-IF|DO|AND|OR)\b/g) ?? []).length;
  });
  for (const f of files) {
    const ops = new Set(units.flatMap((u) => u.files.filter((x) => x.file === f.name).map((x) => x.op)));
    f.mode = ops.size === 2 ? "both" : ops.has("write") ? "write" : ops.has("read") ? "read" : null;
  }
  return { kind: "ezt", names: [member], units, files, doc, loc: lines.filter((l) => l.trim() && !l.trim().startsWith("*")).length };
}

/** Fortran: PROGRAM / SUBROUTINE / FUNCTION units, CALLs between them. */
function parseFortran(text: string, member: string): Lite {
  const lines = text.split(/\r?\n/);
  const units: Unit[] = [];
  let cur: Unit | null = null;
  let doc = "";
  lines.forEach((raw, i) => {
    const no = i + 1;
    if (/^[Cc*!]/.test(raw) || !raw.trim()) {
      if (!doc && /[a-z]{3}/i.test(raw)) doc = raw.slice(1).trim();
      return;
    }
    const l = (raw.length > 6 && /^[ \d]{5}[ \S]/.test(raw) ? raw.slice(6, 72) : raw).trim().toUpperCase();
    const m = /^(?:(?:INTEGER|REAL|DOUBLE\s+PRECISION|LOGICAL|CHARACTER|COMPLEX)(?:\*\d+)?\s+)?(PROGRAM|SUBROUTINE|FUNCTION|BLOCK\s+DATA)\s+([A-Z][A-Z0-9_]*)/.exec(l);
    if (m) units.push((cur = unit(m[2]!, no)));
    if (!cur) units.push((cur = unit(member, no)));
    cur.loc++;
    cur.endLine = no;
    for (const c of l.matchAll(/\bCALL\s+([A-Z][A-Z0-9_]*)/g)) cur.calls.push({ to: c[1]!, line: no });
    cur.complexity += (l.match(/\bIF\s*\(|\.AND\.|\.OR\.|\bDO\s+\d|\bDO\s+[A-Z]/g) ?? []).length;
  });
  if (!units.length) units.push(unit(member, 1));
  // calls to a unit in this file stay local; the rest are other programs
  const local = new Set(units.map((u) => u.name));
  for (const u of units) {
    u.progs = u.calls.filter((c) => !local.has(c.to)).map((c) => ({ name: c.to, line: c.line }));
    u.calls = u.calls.filter((c) => local.has(c.to));
  }
  return { kind: "fortran", names: [member, ...units.map((u) => u.name)], units, files: [], doc, loc: lines.filter((l) => l.trim()).length };
}

function parseIdeal(text: string, member: string): Lite {
  const lines = text.split(/\r?\n/);
  const u = unit(member, 1);
  u.endLine = lines.length;
  u.loc = lines.filter((l) => l.trim()).length;
  return { kind: "ideal", names: [member], units: [u], files: [], doc: "", loc: u.loc };
}

export interface MfReport {
  members: Record<string, number>;
  programs: number;
  paragraphs: number;
  jobs: number;
  steps: number;
  datasets: number;
  tables: number;
  loc: number;
  /** Programs called (or run by a step) that aren't in the source, by how often. */
  notFound: [string, number][];
  /** Member names defined more than once (the first one wins). */
  duplicates: string[];
  missingCopybooks: string[];
  missingProcs: string[];
  unresolvedCalls: number;
}

export interface MfOptions {
  /** Keep each module's source in the map (for the inspector). */
  source?: boolean;
}

interface Built {
  graph: CodeGraph;
  report: MfReport;
  /** For slicing: which jobs read and write each dataset module. */
  readers: Map<string, Set<string>>;
  writers: Map<string, Set<string>>;
  /** Names to start a slice from: job, program and dataset names -> module ids. */
  names: Map<string, string[]>;
}

/**
 * Link a library. `files` maps paths to their kind (from `sniff`); `read`
 * gives a file's text when it's needed (once to parse, again for source),
 * so a big library is never all in memory at once.
 */
export function analyzeMainframe(
  files: Map<string, MfKind>,
  read: (path: string) => string,
  meta: { name: string; title: string; description: string },
  opts: MfOptions = {}
): Built {
  const report: MfReport = {
    members: {}, programs: 0, paragraphs: 0, jobs: 0, steps: 0, datasets: 0, tables: 0, loc: 0,
    notFound: [], duplicates: [], missingCopybooks: [], missingProcs: [], unresolvedCalls: 0
  };
  for (const k of files.values()) report.members[k] = (report.members[k] ?? 0) + 1;

  // members by name: copybooks, JCL members (for PROC and INCLUDE), and everything that can run
  const byName = (kind: (k: MfKind) => boolean) => {
    const m = new Map<string, string>();
    for (const [p, k] of files) if (kind(k)) {
      const n = memberOf(p);
      if (m.has(n)) report.duplicates.push(n);
      else m.set(n, p);
    }
    return m;
  };
  const copybooks = byName((k) => k === "copybook");
  const jclMembers = byName((k) => k === "jcl");
  const cache = new Map<string, string>();
  const text = (p: string) => cache.get(p) ?? read(p);
  const copyText = (name: string) => {
    const p = copybooks.get(name);
    if (!p) return undefined;
    if (!cache.has(p)) cache.set(p, read(p));
    return cache.get(p);
  };
  const missingCopies = new Set<string>();
  const missingProcs = new Set<string>();

  const modules: ModuleNode[] = [];
  const fns: FnNode[] = [];
  const calls = new Map<string, CallEdge>();
  const call = (from: string, to: string, line: number) => {
    if (from === to) return;
    const k = `${from}->${to}`;
    const c = calls.get(k);
    if (c) c.count++;
    else calls.set(k, { from, to, count: 1, line });
  };
  /** Program name -> its entry function, and the module its files are in. */
  const entry = new Map<string, { fn: string; files: Map<string, { fn: string; mode: Op | "both" | null }> }>();
  const names = new Map<string, string[]>();
  const name = (n: string, mod: string) => (names.get(n) ?? names.set(n, []).get(n)!).push(mod);
  const skipped: { path: string; reason: string }[] = [];
  const progCalls: { from: string; name: string; line: number }[] = [];
  const fileOps: { from: string; file: string; op: Op; line: number }[] = [];

  const addFn = (mod: string, f: Partial<FnNode> & { name: string; line: number; endLine: number }): string => {
    const id = `${mod}#${f.name}`;
    fns.push({ id, module: mod, exported: false, params: [], loc: 1, complexity: 1, doc: "", triggers: [], ...f });
    return id;
  };
  const fileFns = (mod: string, list: { name: string; dd: string; mode: Op | "both" | null }[], line: number) => {
    const out = new Map<string, { fn: string; mode: Op | "both" | null }>();
    for (const f of list) {
      const fn = addFn(mod, { name: `FILE ${f.name}`, params: [`DD ${f.dd}`], line, endLine: line, doc: `File ${f.name}, bound by JCL to DD ${f.dd}${f.mode ? ` (${f.mode === "both" ? "read and write" : f.mode})` : ""}.` });
      out.set(f.dd, { fn, mode: f.mode });
    }
    return out;
  };
  const register = (names_: string[], e: { fn: string; files: Map<string, { fn: string; mode: Op | "both" | null }> }, mod: string) => {
    for (const n of new Set(names_)) {
      if (entry.has(n)) {
        if (n === names_[0]) report.duplicates.push(n);
        continue;
      }
      entry.set(n, e);
      name(n, mod);
    }
  };

  // programs
  for (const [path, kind] of files) {
    if (kind === "copybook" || kind === "jcl") continue;
    const member = memberOf(path);
    const src = text(path);
    if (kind === "cobol") {
      let p: CobolProgram;
      try {
        p = parseCobol(src, member, copyText);
      } catch (e) {
        skipped.push({ path, reason: `couldn't parse: ${e instanceof Error ? e.message : e}` });
        continue;
      }
      for (const c of p.missingCopies) missingCopies.add(c);
      report.unresolvedCalls += p.unresolved.length;
      report.programs++;
      report.paragraphs += p.paras.length;
      report.loc += p.loc;
      const lang = ["COBOL", p.sql && "DB2", p.cics && "CICS"].filter(Boolean).join(" · ");
      modules.push({ id: path, dir: path.split("/").slice(0, -1).join("/"), doc: p.doc, loc: p.loc, store: false, fns: [], imports: p.copies.map((c) => `ext:copy:${c}`), source: "", lang });
      const fileMap = new Map(p.files.map((f) => [f.name, f]));
      const ids = p.paras.map((para, i) =>
        addFn(path, {
          name: para.name, line: para.line, endLine: para.endLine, loc: para.loc, complexity: para.complexity, doc: para.doc,
          exported: i === 0, params: i === 0 ? p.params : [],
          triggers: i === 0 && p.transid ? [{ kind: "route", method: "CICS", path: p.transid }] : []
        })
      );
      const files_ = fileFns(path, p.files, p.paras[0]!.line);
      register([member, p.id], { fn: ids[0]!, files: files_ }, path);
      p.paras.forEach((para, i) => {
        const from = ids[i]!;
        for (const c of para.calls) call(from, `${path}#${c.to}`, c.line);
        for (const c of para.progs) progCalls.push({ from, name: c.name, line: c.line });
        for (const f of para.files) {
          const dd = fileMap.get(f.file)?.dd;
          const ff = dd && files_.get(dd);
          if (ff) call(from, ff.fn, f.line);
        }
        for (const t of para.tables) fileOps.push({ from, file: `${t.kind}/${t.name}`, op: t.op, line: t.line });
      });
    } else {
      const lite = kind === "asm" ? parseAsm(src, member) : kind === "ezt" ? parseEzt(src, member) : kind === "fortran" ? parseFortran(src, member) : parseIdeal(src, member);
      report.programs++;
      report.loc += lite.loc;
      const lang = { asm: "ASSEMBLER", ezt: "EASYTRIEVE", fortran: "FORTRAN", ideal: "IDEAL" }[lite.kind];
      modules.push({ id: path, dir: path.split("/").slice(0, -1).join("/"), doc: lite.doc, loc: lite.loc, store: false, fns: [], imports: [], source: "", lang });
      const ids = lite.units.map((u, i) =>
        addFn(path, { name: u.name, line: u.line, endLine: u.endLine, loc: u.loc, complexity: u.complexity, exported: i === 0 || lite.kind === "fortran" })
      );
      report.paragraphs += ids.length;
      const files_ = fileFns(path, lite.files, 1);
      register(lite.names, { fn: ids[0]!, files: files_ }, path);
      if (lite.kind === "fortran") lite.units.forEach((u, i) => register([u.name], { fn: ids[i]!, files: new Map() }, path));
      lite.units.forEach((u, i) => {
        const from = ids[i]!;
        for (const c of u.calls) if (lite.units.some((x) => x.name === c.to)) call(from, `${path}#${c.to}`, c.line);
        for (const c of u.progs) progCalls.push({ from, name: c.name, line: c.line });
        for (const f of u.files) {
          const ff = files_.get(lite.files.find((x) => x.name === f.file)?.dd ?? "");
          if (ff) call(from, ff.fn, f.line);
        }
      });
    }
  }

  // placeholders for programs that aren't in the source
  const notFound = new Map<string, number>();
  const external = (n: string): string => {
    notFound.set(n, (notFound.get(n) ?? 0) + 1);
    const hit = entry.get(n);
    if (hit) return hit.fn;
    const mod = `ext/${n}`;
    modules.push({ id: mod, dir: "ext", doc: "Called, but not in the source analyzed: a vendor product, or a library that wasn't captured.", loc: 0, store: false, fns: [], imports: [], source: "", lang: "NOT IN SOURCE" });
    const fn = addFn(mod, { name: n, line: 0, endLine: 0, exported: true });
    entry.set(n, { fn, files: new Map() });
    name(n, mod);
    return fn;
  };
  const resolve = (n: string): string => {
    const e = entry.get(n);
    if (e && !notFound.has(n)) return e.fn;
    return external(n);
  };
  for (const c of progCalls) call(c.from, resolve(c.name), c.line);

  // stores: datasets, DB2 tables, CICS files; a READ and a WRITE machine each
  const stores = new Map<string, { mod: ModuleNode; read?: string; write?: string }>();
  const store = (id: string, op: Op): string => {
    let s = stores.get(id);
    if (!s) {
      const [kind, ...rest] = id.split("/");
      const label = rest.join("/");
      const lang = kind === "db2" ? "DB2 TABLE" : kind === "cics" ? "CICS FILE" : label.startsWith("&&") ? "TEMP DATASET" : "DATASET";
      const mod: ModuleNode = { id, dir: kind!, doc: "", loc: 0, store: true, fns: [], imports: [], source: "", lang };
      modules.push(mod);
      s = { mod };
      stores.set(id, s);
      if (kind === "db2") report.tables++;
      else report.datasets++;
      name(label.replace(/ \(.*\)$/, ""), id);
    }
    const key = op === "read" ? "read" : "write";
    return (s[key] ??= addFn(id, { name: op === "read" ? "READ" : "WRITE", line: 0, endLine: 0, exported: true }));
  };
  for (const f of fileOps) call(f.from, store(f.file, f.op), f.line);

  // jobs
  const readers = new Map<string, Set<string>>();
  const writers = new Map<string, Set<string>>();
  const SKIP_DD = /^(STEPLIB|JOBLIB|SYSPRINT|SYSOUT|SYSUDUMP|SYSABEND|SYSMDUMP|CEEDUMP|SYSDBOUT|SYSTSPRT|SYSDUMP|SORTWK\d*|SYSUT3|SYSUT4|SYSLIB)$/;
  for (const [path, kind] of files) {
    if (kind !== "jcl") continue;
    const src = text(path);
    if (jclKind(src) !== "job") continue;
    let job: Job;
    try {
      job = parseJcl(src, memberOf(path), { member: (n) => (jclMembers.has(n) ? text(jclMembers.get(n)!) : undefined) });
    } catch (e) {
      skipped.push({ path, reason: `couldn't parse: ${e instanceof Error ? e.message : e}` });
      continue;
    }
    for (const m of job.missing) missingProcs.add(m);
    report.jobs++;
    report.steps += job.steps.length;
    report.loc += job.loc;
    modules.push({ id: path, dir: path.split("/").slice(0, -1).join("/"), doc: job.doc, loc: job.loc, store: false, fns: [], imports: job.procs.map((p) => `ext:proc:${p}`), source: "", lang: "JCL" });
    name(job.name, path);
    const jobFn = addFn(path, {
      name: job.name, line: job.line, endLine: job.line, loc: 1, complexity: 1 + job.steps.filter((s) => s.cond).length,
      doc: job.doc, exported: true, triggers: [{ kind: "job", name: job.name } satisfies Trigger]
    });
    for (const st of job.steps) {
      const stepFn = addFn(path, {
        name: st.name, line: st.line, endLine: st.endLine, loc: st.endLine - st.line + 1, complexity: st.cond ? 2 : 1, doc: st.doc,
        params: [st.utility ? `PGM=${st.utility}` : `PGM=${st.pgm ?? "?"}`, ...(st.parm ? [`PARM=${st.parm}`] : [])]
      });
      call(jobFn, stepFn, st.line);
      // what it runs: its program, or a source member named in a utility's control cards
      let runs = st.pgm;
      if (!runs && st.utility)
        runs = st.dds.find((d) => /^(SYSIN|SYSTSIN)$/.test(d.name) && d.member && entry.has(d.member))?.member;
      const prog = runs ? entry.get(runs) : undefined;
      if (runs) call(stepFn, prog && !notFound.has(runs) ? prog.fn : external(runs), st.line);
      for (const dd of st.dds) {
        if (!dd.dsn || SKIP_DD.test(dd.name)) continue;
        if (/^(SYSIN|SYSTSIN)$/.test(dd.name) && dd.member) continue; // control cards
        const id = `dsn/${dd.dsn.startsWith("&&") ? `${dd.dsn} (${job.name})` : dd.dsn}`;
        const own = prog?.files.get(dd.name);
        const op: Op = own?.mode === "read" || own?.mode === "write" ? own.mode : dd.op;
        const target = store(id, op);
        if (dd.gdg) stores.get(id)!.mod.lang = "GDG";
        call(own ? own.fn : stepFn, target, dd.line);
        const m = op === "read" ? readers : writers;
        (m.get(id) ?? m.set(id, new Set()).get(id)!).add(path);
      }
    }
  }
  const modById = new Map(modules.map((m) => [m.id, m]));
  for (const f of fns) modById.get(f.module)!.fns.push(f.id);
  if (opts.source)
    for (const m of modules) if (files.has(m.id)) m.source = text(m.id);

  report.notFound = [...notFound].sort((a, b) => b[1] - a[1]);
  report.missingCopybooks = [...missingCopies].sort();
  report.missingProcs = [...missingProcs].sort();
  report.duplicates = [...new Set(report.duplicates)].sort();

  const graph: CodeGraph = {
    format: CODEMAP_FORMAT,
    name: meta.name,
    title: meta.title,
    description: meta.description,
    language: "mainframe",
    modules: modules.sort((a, b) => a.id.localeCompare(b.id)),
    fns,
    calls: [...calls.values()],
    externals: [...notFound.keys()].sort(),
    skipped
  };
  return { graph, report, readers, writers, names };
}

const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");

/**
 * Cut out what `from` reaches: the modules named (jobs, programs, datasets,
 * by name or glob), everything their calls reach (at most `depth` hops
 * from one module into another, if given), and for a dataset the jobs that
 * read or write it. With `lineage`, that many rounds of "and the jobs that
 * read what these wrote", following data downstream across jobs.
 */
export function slice(b: Built, from: string[], lineage = 0, depth = Infinity): CodeGraph {
  const g = b.graph;
  const modOf = new Map(g.fns.map((f) => [f.id, f.module]));
  const out = new Map<string, string[]>();
  for (const c of g.calls) (out.get(c.from) ?? out.set(c.from, []).get(c.from)!).push(c.to);
  const keep = new Set<string>();
  for (const pat of from) {
    const re = globRe(pat);
    for (const [n, mods] of b.names) if (re.test(n)) for (const m of mods) keep.add(m);
    for (const m of g.modules) if (re.test(m.id)) keep.add(m.id);
  }
  for (const m of [...keep]) for (const j of [...(b.readers.get(m) ?? []), ...(b.writers.get(m) ?? [])]) keep.add(j);
  const close = () => {
    // breadth first, where only a step into another module counts as a hop
    const hops = new Map(g.fns.filter((f) => keep.has(f.module)).map((f) => [f.id, 0]));
    const queue = [...hops.keys()];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!;
      const h = hops.get(id)!;
      for (const to of out.get(id) ?? []) {
        const th = h + (modOf.get(to) === modOf.get(id) ? 0 : 1);
        if (th > depth || (hops.get(to) ?? Infinity) <= th) continue;
        hops.set(to, th);
        keep.add(modOf.get(to)!);
        if (th === h) queue.splice(i + 1, 0, to);
        else queue.push(to);
      }
    }
  };
  close();
  for (let i = 0; i < lineage; i++) {
    const before = keep.size;
    for (const m of [...keep]) if (b.writers.get(m)?.size) for (const j of b.readers.get(m) ?? []) keep.add(j);
    close();
    if (keep.size === before) break;
  }
  const modules = g.modules.filter((m) => keep.has(m.id));
  const fns = g.fns.filter((f) => keep.has(f.module));
  const ids = new Set(fns.map((f) => f.id));
  return {
    ...g,
    modules,
    fns,
    calls: g.calls.filter((c) => ids.has(c.from) && ids.has(c.to)),
    externals: g.externals.filter((e) => keep.has(`ext/${e}`))
  };
}

/** For in-memory sources (the examples, tests): sniff, analyze, done. */
export function analyzeMainframeFiles(files: Record<string, string>, meta: { name: string; title: string; description: string }, opts: MfOptions = { source: true }): Built {
  const kinds = new Map<string, MfKind>();
  for (const [p, t] of Object.entries(files)) {
    const k = sniff(p, t.slice(0, 8000));
    if (k) kinds.set(p, k);
  }
  return analyzeMainframe(kinds, (p) => files[p]!, meta, opts);
}
