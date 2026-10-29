/**
 * COBOL program -> the facts the mainframe linker (mainframe.ts) needs:
 * paragraphs and sections (the machines), and what each one does that
 * reaches outside itself: PERFORM / GO TO (other paragraphs), CALL and
 * EXEC CICS LINK / XCTL (other programs), READ / WRITE (files, by the DD
 * name JCL binds them to), EXEC SQL (DB2 tables) and EXEC CICS file
 * commands.
 *
 * Not a full parser: line- and token-based, tolerant of what it doesn't
 * understand. Fixed format (sequence area, indicator column, area A at
 * column 8) is the default; free format is detected. COPY members are
 * spliced in, so record layouts and procedure-division copybooks count.
 */

export type Op = "read" | "write";

export interface ProgFile {
  /** The COBOL file name (SELECT x), and the DD name JCL binds it to (ASSIGN TO). */
  name: string;
  dd: string;
  /** From OPEN INPUT / OUTPUT / I-O / EXTEND, when seen. */
  mode: Op | "both" | null;
}

export interface Para {
  name: string;
  section: boolean;
  line: number;
  endLine: number;
  loc: number;
  complexity: number;
  doc: string;
  /** Other paragraphs of this program it performs or goes to. */
  calls: { to: string; line: number }[];
  /** Other programs it calls (CALL, EXEC CICS LINK / XCTL). */
  progs: { name: string; line: number }[];
  files: { file: string; op: Op; line: number }[];
  tables: { kind: "db2" | "cics"; name: string; op: Op; line: number }[];
}

export interface CobolProgram {
  /** PROGRAM-ID (falls back to the member name). */
  id: string;
  params: string[];
  doc: string;
  loc: number;
  /** The first is the program's entry: the procedure division up to its first paragraph, named after the program. */
  paras: Para[];
  files: ProgFile[];
  /** EXEC CICS RETURN TRANSID: the transaction that starts it. */
  transid?: string;
  cics: boolean;
  sql: boolean;
  copies: string[];
  missingCopies: string[];
  /** Runtime and subsystem entry points it calls (CEE*, CBLTDLI, DSNTIAR...): not drawn. */
  system: string[];
  /** CALL <identifier> whose value we couldn't work out. */
  unresolved: string[];
}

interface Line {
  no: number;
  code: string;
  /** Fixed format: whether the code starts in area A (columns 8-11). Free format: undefined. */
  areaA?: boolean;
  comment?: string;
}

const RESERVED = new Set(["EXIT", "GOBACK", "CONTINUE", "ELSE", "DECLARATIVES", "STOP", "END", "SKIP1", "SKIP2", "SKIP3", "EJECT"]);
/** CALL targets that are the runtime or a subsystem's API, not application programs. */
export const SYSTEM_CALL = /^(CEE|ILBO|IGZ|DSN|DFH|CBLTDLI$|AIBTDLI$|PLITDLI$|CBLTDLI|EZT|IEF|IGG|ADR)/;
const VERBS = new Set([
  "ACCEPT", "ADD", "CALL", "CLOSE", "COMPUTE", "CONTINUE", "DELETE", "DISPLAY", "DIVIDE", "ELSE", "END-IF", "EVALUATE", "EXEC",
  "EXIT", "GO", "GOBACK", "IF", "INITIALIZE", "INSPECT", "MOVE", "MULTIPLY", "OPEN", "PERFORM", "READ", "RELEASE", "RETURN",
  "REWRITE", "SEARCH", "SET", "SORT", "START", "STOP", "STRING", "SUBTRACT", "UNSTRING", "WHEN", "WRITE"
]);

/** Fixed or free format: fixed if nearly every long line has a sequence area and an indicator column. */
function isFixed(raw: string[]): boolean {
  let n = 0;
  let fixed = 0;
  for (const l of raw) {
    if (l.trim().length === 0 || l.length < 8) continue;
    n++;
    if (/^[ 0-9A-Za-z]{6}[ *\/\-Dd]/.test(l)) fixed++;
  }
  return n === 0 || fixed / n > 0.85;
}

function cobolLines(text: string): Line[] {
  const raw = text.split(/\r?\n/);
  const fixed = isFixed(raw);
  const out: Line[] = [];
  raw.forEach((l, i) => {
    const no = i + 1;
    if (fixed) {
      const ind = l[6] ?? " ";
      const area = l.slice(7, 72);
      if (ind === "*" || ind === "/") return void out.push({ no, code: "", comment: area.trim() });
      if (ind === "D" || ind === "d") return;
      const code = area.replace(/\*>.*$/, "");
      if (ind === "-") {
        const prev = out.findLast((x) => x.code.trim());
        if (prev) {
          const c = code.trim();
          prev.code = /^['"]/.test(c) ? prev.code.trimEnd() + c.slice(1) : `${prev.code} ${c}`;
        }
        return;
      }
      const first = code.search(/\S/);
      out.push({ no, code, areaA: first >= 0 && first < 4 });
    } else {
      const t = l.trim();
      if (t.startsWith("*")) return void out.push({ no, code: "", comment: t.replace(/^\*>?/, "").trim() });
      out.push({ no, code: l.replace(/\*>.*$/, "") });
    }
  });
  return out;
}

/** Splice COPY members in place (nested, up to a few levels); their lines take the COPY statement's line number. */
function expandCopies(lines: Line[], copybook: (name: string) => string | undefined, copies: Set<string>, missing: Set<string>, depth = 0): Line[] {
  const out: Line[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const m = /(^|\s)COPY\s+(['"]?)([A-Z0-9#@$-]+)\2/i.exec(l.code);
    if (!m || depth > 5) {
      out.push(l);
      continue;
    }
    const name = m[3]!.toUpperCase();
    const before = l.code.slice(0, m.index + m[1]!.length);
    // the statement runs to its period, maybe over a REPLACING clause on later lines
    let rest = l.code.slice(m.index + m[0].length);
    while (!rest.includes(".") && i + 1 < lines.length) rest = lines[++i]!.code;
    const after = rest.slice(rest.indexOf(".") + 1);
    if (before.trim()) out.push({ ...l, code: before });
    copies.add(name);
    const text = copybook(name);
    if (text === undefined) missing.add(name);
    else for (const c of expandCopies(cobolLines(text), copybook, copies, missing, depth + 1)) out.push({ ...c, no: l.no, areaA: c.areaA });
    if (after.trim()) out.push({ ...l, code: after });
  }
  return out;
}

interface Tok {
  t: string;
  line: number;
}

const TOKEN = /'(?:[^']|'')*'?|"(?:[^"]|"")*"?|[A-Z0-9_#@$][A-Z0-9_#@$-]*|\S/gi;
const isLit = (t: string) => t.startsWith("'") || t.startsWith('"');
const unquote = (t: string) => t.replace(/^['"]|['"]$/g, "").trim().toUpperCase();
const ident = (t: string | undefined) => !!t && /^[A-Z0-9_#@$-]+$/i.test(t) && /[A-Z]/i.test(t);

/** `UT-S-TXNIN` -> `TXNIN`: the device prefixes old compilers wanted are dropped. */
export function ddOf(assign: string): string {
  const parts = assign.toUpperCase().split("-");
  if (parts.length > 1 && (["UT", "DA", "UR", "SYS"].includes(parts[0]!) || parts[0]!.length === 1)) return parts[parts.length - 1]!;
  return assign.toUpperCase();
}

/** Tables a SQL statement reads from (FROM and JOIN lists), qualifiers dropped. */
export function sqlReads(sql: string): string[] {
  const out = new Set<string>();
  const clause = /\bFROM\s+([\s\S]*?)(?=\bWHERE\b|\bGROUP\b|\bORDER\b|\bHAVING\b|\bUNION\b|\bFETCH\b|\bFOR\b|\bWITH\b|\bINNER\b|\bLEFT\b|\bRIGHT\b|\bFULL\b|\bJOIN\b|\bEXCEPT\b|\)|$)/g;
  for (const m of sql.matchAll(clause))
    for (const item of m[1]!.split(",")) {
      const t = item.trim().split(/\s+/)[0] ?? "";
      if (/^[A-Z][A-Z0-9_#@$.]*$/.test(t)) out.add(t);
    }
  for (const m of sql.matchAll(/\bJOIN\s+([A-Z][A-Z0-9_#@$.]*)/g)) out.add(m[1]!);
  return [...out].filter((t) => !t.startsWith("SYSIBM.")).map((t) => t.split(".").pop()!);
}

/** One EXEC SQL statement: the tables it reads and writes. Cursors resolve through their DECLARE. */
function sqlOps(sql: string, cursors: Map<string, string[]>): { name: string; op: Op }[] {
  const s = sql.replace(/\s+/g, " ").trim();
  const bare = (t: string) => t.split(".").pop()!;
  const out: { name: string; op: Op }[] = [];
  let m: RegExpExecArray | null;
  if (/^(INCLUDE|WHENEVER|COMMIT|ROLLBACK|CONNECT|SET|DECLARE|CLOSE|PREPARE|DESCRIBE|BEGIN|END)\b/.test(s)) return out;
  if ((m = /^(?:OPEN|FETCH)\s+(?:NEXT\s+)?(?:FROM\s+)?([A-Z0-9_-]+)/.exec(s))) return (cursors.get(m[1]!) ?? []).map((name) => ({ name, op: "read" as Op }));
  let rest = s;
  if ((m = /^INSERT\s+INTO\s+([A-Z][A-Z0-9_#@$.]*)/.exec(s))) out.push({ name: bare(m[1]!), op: "write" });
  else if ((m = /^UPDATE\s+([A-Z][A-Z0-9_#@$.]*)/.exec(s))) out.push({ name: bare(m[1]!), op: "write" });
  else if ((m = /^DELETE\s+FROM\s+([A-Z][A-Z0-9_#@$.]*)/.exec(s))) {
    out.push({ name: bare(m[1]!), op: "write" });
    rest = s.slice(m[0].length);
  } else if ((m = /^MERGE\s+INTO\s+([A-Z][A-Z0-9_#@$.]*)/.exec(s))) out.push({ name: bare(m[1]!), op: "write" });
  for (const t of sqlReads(rest)) out.push({ name: t, op: "read" });
  return out;
}

export function parseCobol(text: string, member: string, copybook: (name: string) => string | undefined = () => undefined): CobolProgram {
  const copies = new Set<string>();
  const missing = new Set<string>();
  const lines = expandCopies(cobolLines(text), copybook, copies, missing);
  const procAt = lines.findIndex((l) => /^\s*PROCEDURE\s+DIVISION\b/i.test(l.code));
  const head = procAt < 0 ? lines : lines.slice(0, procAt);
  const dataText = head.map((l) => l.code).join(" ").toUpperCase();
  const fullUpper = lines.map((l) => l.code).join(" ").toUpperCase();

  const id = (/PROGRAM-ID\s*\.?\s*['"]?([A-Z0-9#@$-]+)/.exec(dataText)?.[1] ?? member).toUpperCase();

  // the first comment block that says something, for the program's doc
  let doc = "";
  {
    let block: string[] = [];
    for (const l of head) {
      if (l.comment !== undefined) {
        const c = l.comment.replace(/^[*\s-]+|[*\s-]+$/g, "");
        if (/[a-z]{3}/i.test(c) && !/^(AUTHOR|DATE|INSTALLATION|SECURITY)\b/i.test(c)) block.push(c);
      } else if (block.length) break;
    }
    if (!block.length) block = [/REMARKS\.\s*([^.]*)/.exec(dataText)?.[1]?.toLowerCase() ?? ""];
    doc = block.join(" ").slice(0, 300).trim();
  }

  // files: SELECT name ASSIGN TO dd; FD name and the records under it
  const files = new Map<string, ProgFile>();
  for (const m of dataText.matchAll(/\bSELECT\s+(?:OPTIONAL\s+)?([A-Z0-9-]+)\s+ASSIGN\s+(?:TO\s+)?(?:EXTERNAL\s+|DYNAMIC\s+)?(['"]?)([A-Z0-9#@$-]+)\2/g))
    files.set(m[1]!, { name: m[1]!, dd: ddOf(m[3]!), mode: null });
  const recordFile = new Map<string, string>();
  for (const m of dataText.matchAll(/\b(?:FD|SD)\s+([A-Z0-9-]+)([\s\S]*?)(?=\b(?:FD|SD)\s+[A-Z0-9-]+|WORKING-STORAGE\s+SECTION|LINKAGE\s+SECTION|LOCAL-STORAGE\s+SECTION|$)/g))
    for (const r of m[2]!.matchAll(/\b01\s+([A-Z0-9-]+)/g)) recordFile.set(r[1]!, m[1]!);

  // literal values data items can hold, for CALL <identifier>
  const values = new Map<string, Set<string>>();
  const addValue = (k: string, v: string) => (values.get(k) ?? values.set(k, new Set()).get(k)!).add(v);
  for (const m of dataText.matchAll(/\b\d{2}\s+([A-Z0-9-]+)\b[^.]*?\bVALUE\s+(?:IS\s+)?(['"])([A-Z0-9#@$]{1,8})\s*\2/g)) addValue(m[1]!, m[3]!);

  // cursors, wherever they're declared
  const cursors = new Map<string, string[]>();
  for (const m of fullUpper.matchAll(/EXEC\s+SQL\s+DECLARE\s+([A-Z0-9_-]+)\s+(?:[A-Z ]*?)CURSOR\b([\s\S]*?)END-EXEC/g)) cursors.set(m[1]!, sqlReads(m[2]!));

  // procedure division: USING, then paragraphs and sections by their headers
  const proc = procAt < 0 ? [] : lines.slice(procAt);
  let using = "";
  let start = 0;
  if (proc.length) {
    let s = "";
    for (; start < proc.length; start++) {
      s += " " + proc[start]!.code;
      if (s.includes(".")) break;
    }
    start++;
    using = /\bUSING\s+([^.]*)/i.exec(s)?.[1] ?? "";
  }
  const params = using.split(/[\s,]+/).filter((w) => w && !/^(BY|REFERENCE|VALUE|CONTENT)$/i.test(w)).map((w) => w.toUpperCase());

  interface Block {
    para: Para;
    lines: Line[];
  }
  const blank = (name: string, line: number, section: boolean, doc: string): Block => ({
    para: { name, section, line, endLine: line, loc: 0, complexity: 1, doc, calls: [], progs: [], files: [], tables: [] },
    lines: []
  });
  const entryLine = proc[0]?.no ?? 1;
  const blocks: Block[] = [blank(id, entryLine, false, doc)];
  let comments: string[] = [];
  for (const l of proc.slice(start)) {
    if (l.comment !== undefined) {
      const c = l.comment.replace(/^[*\s-]+|[*\s-]+$/g, "");
      if (c) comments.push(c);
      continue;
    }
    if (!l.code.trim()) continue;
    const h = /^([A-Z0-9][A-Z0-9-]*)(\s+SECTION(?:\s+\d+)?)?\s*\.$/i.exec(l.code.trim());
    if (h && l.areaA !== false && !RESERVED.has(h[1]!.toUpperCase()) && !/^END-/i.test(h[1]!)) {
      blocks.push(blank(h[1]!.toUpperCase(), l.no, !!h[2], comments.join(" ").slice(0, 300)));
    } else blocks[blocks.length - 1]!.lines.push(l);
    comments = [];
  }
  const paraNames = new Map(blocks.map((b, i) => [b.para.name, i]));
  const isPara = (t: string | undefined) => t !== undefined && paraNames.has(t.toUpperCase());

  const system = new Set<string>();
  const unresolved = new Set<string>();
  const dynamic: { para: Para; ident: string; line: number }[] = [];
  let cics = false;
  let sql = false;
  let transid: string | undefined;
  let entryEnds = false;

  blocks.forEach((b, bi) => {
    const p = b.para;
    if (b.lines.length) {
      p.line = bi === 0 ? b.lines[0]!.no : p.line;
      p.endLine = b.lines[b.lines.length - 1]!.no;
    }
    p.loc = new Set(b.lines.map((l) => l.no)).size + (bi === 0 ? 0 : 1);
    const toks: Tok[] = [];
    for (const l of b.lines) for (const m of l.code.matchAll(TOKEN)) toks.push({ t: m[0], line: l.no });
    const U = (i: number) => toks[i]?.t.toUpperCase();
    const prog = (name: string, line: number) => {
      if (SYSTEM_CALL.test(name)) system.add(name);
      else p.progs.push({ name, line });
    };
    for (let i = 0; i < toks.length; i++) {
      const t = U(i)!;
      const line = toks[i]!.line;
      switch (t) {
        case "EXEC": {
          const kind = U(i + 1);
          let j = i + 2;
          const words: string[] = [];
          while (j < toks.length && U(j) !== "END-EXEC") words.push(toks[j++]!.t);
          i = j;
          const body = words.join(" ").replace(/\s*\.\s*/g, ".").replace(/\s*,\s*/g, ", ").replace(/\(\s*/g, "(").replace(/\s*\)/g, ")");
          const upper = body.toUpperCase();
          if (kind === "SQL") {
            sql = true;
            for (const o of sqlOps(upper, cursors)) p.tables.push({ kind: "db2", name: o.name, op: o.op, line });
          } else if (kind === "CICS") {
            cics = true;
            let m: RegExpExecArray | null;
            if (/^(LINK|XCTL)\b/.test(upper) && (m = /PROGRAM\s*\(\s*(?:'([^']+)'|"([^"]+)"|([A-Z0-9-]+))\s*\)/.exec(upper))) {
              if (m[3]) dynamic.push({ para: p, ident: m[3], line });
              else prog((m[1] ?? m[2]!).trim(), line);
            } else if ((m = /^(READ|READNEXT|READPREV|STARTBR|WRITE|REWRITE|DELETE)\b[\s\S]*?\b(?:FILE|DATASET)\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(upper)))
              p.tables.push({ kind: "cics", name: m[2]!.trim(), op: /^(READ|READNEXT|READPREV|STARTBR)$/.test(m[1]!) ? "read" : "write", line });
            else if ((m = /^RETURN\b[\s\S]*?\bTRANSID\s*\(\s*['"]([^'"]+)['"]/.exec(upper))) transid ??= m[1]!.trim();
            if (/^(RETURN|XCTL)\b/.test(upper) && bi === 0) entryEnds = true;
          }
          break;
        }
        case "PERFORM": {
          const n = U(i + 1);
          if (isPara(n)) {
            p.calls.push({ to: n!, line });
            const thru = U(i + 2);
            if ((thru === "THRU" || thru === "THROUGH") && isPara(U(i + 3))) {
              const a = paraNames.get(n!)!;
              const z = paraNames.get(U(i + 3)!)!;
              for (let k = a + 1; k <= z; k++) p.calls.push({ to: blocks[k]!.para.name, line });
              i += 2;
            }
            i++;
          }
          break;
        }
        case "GO": {
          let j = i + 1;
          if (U(j) === "TO") j++;
          while (j < toks.length && (isPara(U(j)) || U(j) === ",")) {
            if (U(j) !== ",") p.calls.push({ to: U(j)!, line });
            j++;
          }
          if (bi === 0) entryEnds = true;
          break;
        }
        case "CALL": {
          const n = toks[i + 1]?.t;
          if (n && isLit(n)) prog(unquote(n), line);
          else if (ident(n)) dynamic.push({ para: p, ident: n!.toUpperCase(), line });
          break;
        }
        case "READ": {
          const f = U(i + 1);
          if (f && files.has(f)) p.files.push({ file: f, op: "read", line });
          break;
        }
        case "WRITE":
        case "REWRITE": {
          const r = U(i + 1);
          const f = r && (recordFile.get(r) ?? (files.has(r) ? r : undefined));
          if (f && files.has(f)) p.files.push({ file: f, op: "write", line });
          break;
        }
        case "DELETE": {
          const f = U(i + 1);
          if (f && files.has(f)) p.files.push({ file: f, op: "write", line });
          break;
        }
        case "OPEN": {
          let mode: Op | "both" | null = null;
          let j = i + 1;
          for (; j < toks.length; j++) {
            const w = U(j)!;
            if (w === "INPUT") mode = "read";
            else if (w === "OUTPUT" || w === "EXTEND") mode = "write";
            else if (w === "I-O") mode = "both";
            else if (files.has(w)) {
              const f = files.get(w)!;
              f.mode = f.mode && f.mode !== mode ? "both" : mode;
            } else if (w !== ",") break;
          }
          i = j - 1;
          break;
        }
        case "MOVE": {
          const v = toks[i + 1]?.t;
          if (v && isLit(v) && U(i + 2) === "TO") {
            let j = i + 3;
            for (; j < toks.length && ident(toks[j]!.t) && !VERBS.has(U(j)!); j++) addValue(U(j)!, unquote(v));
          }
          break;
        }
        case "STOP":
          if (U(i + 1) === "RUN" && bi === 0) entryEnds = true;
          break;
        case "GOBACK":
          if (bi === 0) entryEnds = true;
          break;
        case "EXIT":
          if (U(i + 1) === "PROGRAM" && bi === 0) entryEnds = true;
          break;
        case "IF":
        case "WHEN":
        case "UNTIL":
        case "AND":
        case "OR":
        case "VARYING":
          p.complexity++;
          break;
      }
    }
  });

  for (const d of dynamic) {
    const vs = values.get(d.ident);
    if (!vs?.size) unresolved.add(d.ident);
    else
      for (const v of vs) {
        if (SYSTEM_CALL.test(v)) system.add(v);
        else d.para.progs.push({ name: v, line: d.line });
      }
  }

  // sections run their paragraphs in order; the entry falls into the first paragraph unless it ends the program
  let section: Para | null = null;
  for (const b of blocks.slice(1)) {
    if (b.para.section) section = b.para;
    else if (section) section.calls.push({ to: b.para.name, line: b.para.line });
  }
  const first = blocks[1]?.para;
  if (first && !entryEnds) blocks[0]!.para.calls.push({ to: first.name, line: first.line });

  return {
    id,
    params,
    doc,
    loc: lines.filter((l) => l.code.trim()).length,
    paras: blocks.map((b) => b.para),
    files: [...files.values()],
    transid,
    cics,
    sql,
    copies: [...copies],
    missingCopies: [...missing],
    system: [...system],
    unresolved: [...unresolved]
  };
}
