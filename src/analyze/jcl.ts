/**
 * JCL -> jobs and their steps: which program each step runs and which
 * datasets it reads and writes (from its DD statements). Cataloged and
 * in-stream PROCs are expanded into the job (steps named `JSTEP.PSTEP`),
 * with symbolics substituted from SET, the PROC's defaults and the EXEC's
 * overrides, and `PSTEP.DD` overrides applied; INCLUDE members are spliced
 * in. Programs run indirectly are found too: IKJEFT01's `RUN PROGRAM(x)`,
 * IMS's DFSRRC00 `PARM='BMP,x,...'`, and SYSIN members (Easytrieve).
 */

export interface DD {
  name: string;
  /** Dataset name, GDG generations stripped; `&&NAME` for temporary ones. */
  dsn?: string;
  member?: string;
  gdg?: boolean;
  op: "read" | "write";
  /** In-stream data (`DD *`). */
  data?: string[];
  line: number;
}

export interface Step {
  name: string;
  /** The program it runs (EXEC PGM=), or the one found inside a utility's control cards. */
  pgm?: string;
  utility?: string;
  parm?: string;
  dds: DD[];
  line: number;
  endLine: number;
  doc: string;
  cond: boolean;
}

export interface Job {
  name: string;
  doc: string;
  steps: Step[];
  procs: string[];
  includes: string[];
  missing: string[];
  loc: number;
  line: number;
}

interface Stmt {
  name: string;
  op: string;
  ops: string;
  line: number;
  endLine: number;
  doc: string[];
  data?: string[];
}

/** Programs that come with the system: a step running one shows its name but has no belt to it. */
export const UTILITIES = new Set([
  "IEFBR14", "IEBGENER", "ICEGENER", "IEBCOPY", "IEBPTPCH", "IEBUPDTE", "IEBCOMPR", "IEBDG", "IEHLIST", "IEHPROGM", "IDCAMS",
  "SORT", "DFSORT", "ICEMAN", "ICETOOL", "SYNCSORT", "SYNCTOOL", "IKJEFT01", "IKJEFT1A", "IKJEFT1B", "IRXJCL", "DFSRRC00",
  "DSNUTILB", "DSNUPROC", "DSNTIAUL", "DSNTEP2", "DSNTEP4", "ADRDSSU", "IEWL", "HEWL", "IEWBLINK", "HEWLH096", "IGYCRCTL",
  "ASMA90", "IEV90", "FTP", "BPXBATCH", "EZTPA00", "FILEAID", "IEBEDIT", "IEFBR15", "DFHCSDUP", "IGYCRCTL", "CEEWUCHA"
]);

/** The first field of `s`, up to an unquoted space (JCL operands), and what follows. */
function field(s: string): [string, string] {
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") q = !q;
    else if (c === " " && !q) return [s.slice(0, i), s.slice(i)];
  }
  return [s, ""];
}

/** Split operands on top-level commas: `[key or null, value]`. */
export function operands(s: string): [string | null, string][] {
  const out: [string | null, string][] = [];
  let depth = 0;
  let q = false;
  let cur = "";
  const push = () => {
    const m = /^([A-Z0-9@#$.]+)=([\s\S]*)$/i.exec(cur);
    out.push(m ? [m[1]!.toUpperCase(), m[2]!] : [null, cur]);
    cur = "";
  };
  for (const c of s) {
    if (c === "'") q = !q;
    if (!q && c === "(") depth++;
    if (!q && c === ")") depth--;
    if (!q && depth === 0 && c === ",") push();
    else cur += c;
  }
  if (cur) push();
  return out;
}

const unq = (v: string) => v.replace(/^'|'$/g, "").replace(/''/g, "'");

/** `&HLQ..DATA` with HLQ=PROD -> `PROD.DATA`. `&&TEMP` is a temporary dataset, not a symbol. */
export function subst(s: string, vars: Map<string, string>): string {
  return s.replace(/(?<!&)&([A-Z@#$][A-Z0-9@#$]{0,7})(\.)?/gi, (all, k: string) => vars.get(k.toUpperCase()) ?? all);
}

function statements(text: string): Stmt[] {
  const out: Stmt[] = [];
  let doc: string[] = [];
  let cur: Stmt | null = null;
  let cont = false;
  let data: string[] | null = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const no = i + 1;
    const l = raw.slice(0, 72).trimEnd();
    if (data) {
      if (l.startsWith("/*") || (l.startsWith("//") && !l.startsWith("//*"))) data = null;
      else return void data.push(l);
      if (l.startsWith("/*")) return;
    }
    if (l.startsWith("//*")) {
      const c = l.slice(3).replace(/^[*\s-]+|[*\s-]+$/g, "");
      if (c) doc.push(c);
      return;
    }
    if (!l.startsWith("//")) return;
    const rest = l.slice(2);
    if (cont && cur) {
      const [f] = field(rest.trimStart());
      cur.ops += f;
      cur.endLine = no;
      cont = f.endsWith(",");
      return;
    }
    if (!rest.trim()) return; // the null statement
    const [name, after] = rest.startsWith(" ") ? ["", rest] : field(rest);
    const [op, after2] = field(after.trimStart());
    const [ops] = field(after2.trimStart());
    cur = { name: name.toUpperCase(), op: op.toUpperCase(), ops, line: no, endLine: no, doc, data: undefined };
    doc = [];
    out.push(cur);
    cont = ops.endsWith(",");
    if (cur.op === "DD") {
      const pos = operands(ops).filter(([k]) => k === null).map(([, v]) => v.toUpperCase());
      if (pos.includes("*") || pos.includes("DATA")) data = cur.data = [];
    }
  });
  return out;
}

function makeDD(s: Stmt, name: string, vars: Map<string, string>): DD {
  const ops = operands(subst(s.ops, vars));
  const get = (k: string) => ops.find(([x]) => x === k)?.[1];
  const dd: DD = { name, op: "read", line: s.line };
  if (s.data) dd.data = s.data.map((l) => subst(l, vars));
  let dsn = get("DSN") ?? get("DSNAME");
  if (dsn && !dsn.startsWith("*.") && !/^NULLFILE$/i.test(dsn)) {
    dsn = dsn.toUpperCase();
    const m = /^(.+?)\((.+)\)$/.exec(dsn);
    if (m) {
      if (/^[+-]?\d+$/.test(m[2]!)) dd.gdg = true;
      else dd.member = m[2]!;
      dsn = m[1]!;
    }
    dd.dsn = dsn;
  }
  const disp = (get("DISP") ?? "").replace(/^\(|\)$/g, "").split(",")[0]!.toUpperCase();
  // no DISP means NEW
  dd.op = disp === "SHR" || disp === "OLD" ? "read" : "write";
  if (!get("DISP") && dd.dsn?.startsWith("&&")) dd.op = "write";
  return dd;
}

const EXEC_KEYS = new Set(["PGM", "PROC", "PARM", "COND", "REGION", "TIME", "ACCT", "DYNAMNBR", "ADDRSPC", "PERFORM", "RD", "CCSID", "MEMLIMIT"]);

/** The program a utility step really runs, from its PARM or control cards. */
function indirect(step: Step): string | undefined {
  if (/^IKJEFT/.test(step.utility ?? ""))
    for (const dd of step.dds)
      if (dd.name === "SYSTSIN")
        for (const l of dd.data ?? []) {
          const m = /\bRUN\s+PROG(?:RAM)?\s*\(\s*([A-Z0-9#@$]+)\s*\)/i.exec(l);
          if (m) return m[1]!.toUpperCase();
        }
  if (step.utility === "DFSRRC00" && step.parm) return unq(step.parm.replace(/^\(|\)$/g, "")).split(",")[1]?.trim().toUpperCase() || undefined;
  return undefined;
}

export interface JclResolver {
  /** A cataloged PROC or INCLUDE member's text, by member name. */
  member(name: string): string | undefined;
}

export function parseJcl(text: string, member: string, r: JclResolver): Job {
  const stmts = statements(text);
  const jobStmt = stmts.find((s) => s.op === "JOB");
  const job: Job = {
    name: jobStmt?.name || member.toUpperCase(),
    doc: "",
    steps: [],
    procs: [],
    includes: [],
    missing: [],
    loc: text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("//*")).length,
    line: jobStmt?.line ?? 1
  };
  const firstExec = stmts.find((s) => s.op === "EXEC");
  job.doc = [...(jobStmt?.doc ?? []), ...(firstExec?.doc ?? [])].filter((c) => /[a-z]{3}/i.test(c)).join(" ").slice(0, 300);
  const instream = new Map<string, Stmt[]>();
  job.steps = expand(stmts, new Map(), new Set(), "", 0, null);
  return job;

  /** `fixed`: symbols the calling EXEC set, which the PROC's defaults don't replace. */
  function expand(list: Stmt[], vars: Map<string, string>, fixed: Set<string>, prefix: string, depth: number, at: Stmt | null): Step[] {
    const steps: Step[] = [];
    let step: Step | null = null;
    let lastDD = "";
    // a PROC call's steps, waiting for the `PSTEP.DD` overrides that follow it
    let pending: { steps: Step[] } | null = null;
    const flush = () => {
      if (step) steps.push(step);
      if (pending) steps.push(...pending.steps);
      step = null;
      pending = null;
    };
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      const line = at?.line ?? s.line;
      if (s.op === "SET") {
        for (const [k, v] of operands(s.ops)) if (k) vars.set(k, unq(subst(v, vars)));
      } else if (s.op === "PROC" && depth === 0 && at === null && s !== list[0]) {
        // an in-stream PROC: keep it until PEND, for EXECs later in the job
        const body: Stmt[] = [s];
        while (++i < list.length && list[i]!.op !== "PEND") body.push(list[i]!);
        instream.set(s.name, body);
      } else if (s.op === "PROC") {
        for (const [k, v] of operands(s.ops)) if (k && !fixed.has(k)) vars.set(k, unq(v));
      } else if (s.op === "INCLUDE") {
        const name = (operands(s.ops).find(([k]) => k === "MEMBER")?.[1] ?? "").toUpperCase();
        const text = r.member(name);
        if (text === undefined) job.missing.push(name);
        else {
          job.includes.push(name);
          list.splice(i + 1, 0, ...statements(text));
        }
      } else if (s.op === "EXEC") {
        flush();
        const ops = operands(subst(s.ops, vars));
        const pgm = ops.find(([k]) => k === "PGM")?.[1]?.toUpperCase();
        const procName = (ops.find(([k]) => k === "PROC")?.[1] ?? ops.find(([k]) => k === null)?.[1])?.toUpperCase();
        const name = prefix + (s.name || `STEP${String(steps.length + 1).padStart(2, "0")}`);
        if (pgm || !procName) {
          const p = pgm ?? "?";
          step = {
            name,
            pgm: UTILITIES.has(p) ? undefined : p,
            utility: UTILITIES.has(p) ? p : undefined,
            parm: ops.find(([k]) => k === "PARM")?.[1],
            dds: [],
            line,
            endLine: at?.endLine ?? s.endLine,
            doc: s.doc.join(" ").slice(0, 300),
            cond: ops.some(([k]) => k === "COND")
          };
        } else if (depth < 6) {
          const body = instream.get(procName) ?? (r.member(procName) !== undefined ? statements(r.member(procName)!) : undefined);
          if (!body) {
            job.missing.push(procName);
            step = { name, pgm: procName, dds: [], line, endLine: s.endLine, doc: s.doc.join(" "), cond: false };
          } else {
            job.procs.push(procName);
            const pv = new Map(vars);
            const set = new Set<string>();
            for (const [k, v] of ops) if (k && !EXEC_KEYS.has(k) && !k.includes(".")) pv.set(k, unq(v)), set.add(k);
            pending = { steps: expand(body, pv, set, `${name}.`, depth + 1, at ?? s) };
            for (const p of pending.steps) p.doc ||= s.doc.join(" ");
          }
        }
      } else if (s.op === "DD") {
        const dot = s.name.indexOf(".");
        if (pending && (dot > 0 || !s.name)) {
          // `PSTEP.DD` overrides (or adds to) a DD in the PROC's step
          const target = dot > 0 ? pending.steps.find((p) => p.name.endsWith(`.${s.name.slice(0, dot)}`)) : pending.steps[0];
          const ddName = dot > 0 ? s.name.slice(dot + 1) : lastDD;
          if (target) {
            const dd = makeDD(s, ddName, vars);
            dd.line = line;
            const j = target.dds.findIndex((d) => d.name === ddName);
            if (j >= 0 && s.name) target.dds[j] = dd;
            else target.dds.push(dd);
          }
          if (s.name) lastDD = ddName;
        } else if (step) {
          const ddName = s.name || lastDD;
          const dd = makeDD(s, ddName, vars);
          dd.line = line;
          step.dds.push(dd);
          if (!at) step.endLine = Math.max(step.endLine, s.endLine);
          lastDD = ddName;
        }
      } else if (s.op === "IF") {
        if (step) step.cond = true;
      }
    }
    flush();
    for (const st of steps) if (st.utility && !st.pgm) st.pgm = indirect(st);
    return steps;
  }
}

/** Is this JCL a job, a PROC, or a fragment (an INCLUDE member)? */
export function jclKind(text: string): "job" | "proc" | "include" {
  for (const s of statements(text.slice(0, 20000))) {
    if (s.op === "JOB") return "job";
    if (s.op === "PROC") return "proc";
  }
  return "include";
}
