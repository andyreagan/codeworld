import { describe, expect, it } from "vitest";
import { ddOf, parseCobol, sqlReads } from "../src/analyze/cobol";
import { parseJcl, subst } from "../src/analyze/jcl";
import { analyzeMainframeFiles, slice, sniff } from "../src/analyze/mainframe";
import { readExamples } from "../tools/examples";

const ex = readExamples(new URL("../examples", import.meta.url).pathname).find((e) => e.name === "policy-billing")!;
const built = analyzeMainframeFiles(ex.files, { name: ex.name, ...ex.meta });
const g = built.graph;
const has = (from: string, to: string) => g.calls.some((c) => c.from === from && c.to === to);

describe("sniff", () => {
  it("sorts members by content first, then library and extension", () => {
    expect(sniff("PROD.CNTL/PBNIGHT", "//PBNIGHT JOB (1),'X'\n//S1 EXEC PGM=X\n")).toBe("jcl");
    expect(sniff("SRC/ABC", "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. ABC.\n")).toBe("cobol");
    expect(sniff("PROD.COPYLIB/REC", "       01  REC.\n           05  A PIC X.\n")).toBe("copybook");
    expect(sniff("x/PRINT.asm", "PRINT    CSECT\n         BR 14\n")).toBe("asm");
    expect(sniff("x/README", "hello")).toBeNull();
  });
});

describe("COBOL", () => {
  const cbl = (proc: string, data = "") =>
    parseCobol(
      ["       IDENTIFICATION DIVISION.", "       PROGRAM-ID. T1.", "       DATA DIVISION.", "       WORKING-STORAGE SECTION.", data, "       PROCEDURE DIVISION.", proc].join("\n"),
      "T1"
    );
  it("finds paragraphs in area A, PERFORM THRU ranges and GO TO", () => {
    const p = cbl(["       A-PARA.", "           PERFORM B-PARA THRU D-PARA", "           GO TO E-PARA.", "       B-PARA.", "           EXIT.", "       C-PARA.", "           CONTINUE.", "       D-PARA.", "           EXIT.", "       E-PARA.", "           STOP RUN."].join("\n"));
    expect(p.paras.map((x) => x.name)).toEqual(["T1", "A-PARA", "B-PARA", "C-PARA", "D-PARA", "E-PARA"]);
    expect(p.paras[1]!.calls.map((c) => c.to)).toEqual(["B-PARA", "C-PARA", "D-PARA", "E-PARA"]);
    // the entry falls into the first paragraph
    expect(p.paras[0]!.calls.map((c) => c.to)).toEqual(["A-PARA"]);
  });
  it("doesn't take inline PERFORMs or EXIT for paragraphs", () => {
    const p = cbl(["       MAIN.", "           PERFORM UNTIL X = 1", "               PERFORM 3 TIMES", "               END-PERFORM", "           END-PERFORM", "           STOP RUN."].join("\n"));
    expect(p.paras.map((x) => x.name)).toEqual(["T1", "MAIN"]);
    expect(p.paras[1]!.calls).toEqual([]);
  });
  it("resolves CALL <identifier> through VALUE clauses and MOVEs", () => {
    const p = cbl(["       MAIN.", "           CALL WS-PGM", "           MOVE 'OTHER' TO WS-PGM2", "           CALL WS-PGM2", "           CALL WS-UNKNOWN", "           CALL 'CEE3ABD'."].join("\n"), "       01  WS-PGM  PIC X(8) VALUE 'SUBPGM'.");
    expect(p.paras[1]!.progs.map((c) => c.name).sort()).toEqual(["OTHER", "SUBPGM"]);
    expect(p.unresolved).toEqual(["WS-UNKNOWN"]);
    expect(p.system).toEqual(["CEE3ABD"]);
  });
  it("reads tables out of SQL", () => {
    expect(sqlReads("SELECT A FROM S.T1 X, T2 Y WHERE A = (SELECT B FROM T3)")).toEqual(["T1", "T2", "T3"]);
    expect(sqlReads("SELECT * FROM A JOIN B ON A.X = B.X LEFT JOIN C ON 1=1")).toEqual(["A", "B", "C"]);
  });
  it("drops device prefixes from ASSIGN", () => {
    expect(ddOf("UT-S-TXNIN")).toBe("TXNIN");
    expect(ddOf("S-IN")).toBe("IN");
    expect(ddOf("POLIN")).toBe("POLIN");
  });
  it("reads free-format source too", () => {
    const p = parseCobol(["IDENTIFICATION DIVISION.", "PROGRAM-ID. FREE1.", "PROCEDURE DIVISION.", "MAIN-PARA.", "  PERFORM WORK-PARA", "  GOBACK.", "WORK-PARA.", "  CALL 'X'."].join("\n"), "FREE1");
    expect(p.paras.map((x) => x.name)).toEqual(["FREE1", "MAIN-PARA", "WORK-PARA"]);
    expect(p.paras[2]!.progs.map((c) => c.name)).toEqual(["X"]);
  });
});

describe("JCL", () => {
  it("substitutes symbolics, keeping temporary datasets", () => {
    const v = new Map([["HLQ", "PROD"]]);
    expect(subst("&HLQ..PB.X", v)).toBe("PROD.PB.X");
    expect(subst("&&TEMP", v)).toBe("&&TEMP");
    expect(subst("&NOPE..X", v)).toBe("&NOPE..X");
  });
  it("expands PROCs with EXEC overrides beating PROC defaults, and DD overrides", () => {
    const proc = "//P1 PROC HLQ=TEST\n//S1 EXEC PGM=PROG1\n//IN DD DSN=&HLQ..IN,DISP=SHR\n//OUT DD DSN=&HLQ..OUT,DISP=(NEW,CATLG)\n";
    const job = parseJcl("//J1 JOB 1\n//  SET HLQ=SETVAL\n//A EXEC P1,HLQ=PROD\n//S1.OUT DD DSN=OVER.OUT,DISP=(MOD,CATLG)\n//B EXEC PGM=IKJEFT01\n//SYSTSIN DD *\n RUN PROGRAM(DB2PGM) PLAN(X)\n/*\n", "J1", {
      member: (n) => (n === "P1" ? proc : undefined)
    });
    expect(job.steps.map((s) => [s.name, s.pgm])).toEqual([["A.S1", "PROG1"], ["B", "DB2PGM"]]);
    expect(job.steps[0]!.dds.map((d) => [d.name, d.dsn, d.op])).toEqual([["IN", "PROD.IN", "read"], ["OUT", "OVER.OUT", "write"]]);
    expect(job.procs).toEqual(["P1"]);
  });
  it("strips GDG generations and continues statements over lines", () => {
    const job = parseJcl("//J2 JOB 1\n//S EXEC PGM=X\n//OUT DD DSN=A.B.C(+1),\n//      DISP=(NEW,CATLG)\n//IN DD DSN=A.LIB(MEM),DISP=SHR\n", "J2", { member: () => undefined });
    expect(job.steps[0]!.dds.map((d) => [d.dsn, d.gdg ?? false, d.member, d.op])).toEqual([["A.B.C", true, undefined, "write"], ["A.LIB", false, "MEM", "read"]]);
  });
});

describe("policy-billing, linked", () => {
  it("makes programs, jobs, datasets and tables into modules", () => {
    const lang = (id: string) => g.modules.find((m) => m.id === id)?.lang;
    expect(lang("cobol/PBPOST.cbl")).toBe("COBOL · DB2");
    expect(lang("cobol/PBINQ.cbl")).toBe("COBOL · CICS");
    expect(lang("jcl/PBNIGHT.jcl")).toBe("JCL");
    expect(lang("dsn/PROD.PB.STMTS")).toBe("GDG");
    expect(lang("db2/POLICY")).toBe("DB2 TABLE");
    expect(g.modules.filter((m) => m.store).length).toBe(13);
    expect(built.report.notFound).toEqual([]);
    expect(built.report.missingCopybooks).toEqual([]);
  });
  it("runs a job's steps in order, through the PROC, into the programs", () => {
    const steps = g.calls.filter((c) => c.from === "jcl/PBNIGHT.jcl#PBNIGHT").sort((a, b) => a.line - b.line).map((c) => c.to.split("#")[1]);
    expect(steps).toEqual(["STEP010", "STEP020", "STEP030.EXTRACT", "STEP040", "STEP050"]);
    expect(has("jcl/PBNIGHT.jcl#STEP030.EXTRACT", "cobol/PBEXTRCT.cbl#PBEXTRCT")).toBe(true);
    expect(has("jcl/PBNIGHT.jcl#STEP040", "cobol/PBPOST.cbl#PBPOST")).toBe(true); // RUN PROGRAM under IKJEFT01
    expect(has("jcl/PBNIGHT.jcl#STEP050", "ezt/PBRPT.ezt#PBRPT")).toBe(true); // Easytrieve via its SYSIN member
    expect(has("jcl/PBMONTH.jcl#PRINT", "asm/PBPRINT.asm#PBPRINT")).toBe(true);
  });
  it("binds program files to the step's datasets through their DD names", () => {
    expect(has("cobol/PBEXTRCT.cbl#2100-READ-TXN", "cobol/PBEXTRCT.cbl#FILE TXN-FILE")).toBe(true);
    expect(has("cobol/PBEXTRCT.cbl#FILE TXN-FILE", "dsn/&&SORTED (PBNIGHT)#READ")).toBe(true);
    expect(has("jcl/PBNIGHT.jcl#STEP020", "dsn/&&SORTED (PBNIGHT)#WRITE")).toBe(true);
    expect(has("cobol/PBPOST.cbl#FILE EXTRACT-FILE", "dsn/PROD.PB.EXTRACT#READ")).toBe(true);
    expect(has("asm/PBPRINT.asm#FILE PRTIN", "dsn/PROD.PB.STMTS#READ")).toBe(true);
    expect(has("ezt/PBRPT.ezt#FILE POSTED", "dsn/PROD.PB.POSTED#READ")).toBe(true);
  });
  it("links calls: static, dynamic, CICS LINK, and copybook paragraphs", () => {
    expect(has("cobol/PBEXTRCT.cbl#2000-PROCESS", "cobol/PBVALID.cbl#PBVALID")).toBe(true);
    expect(has("cobol/PBEXTRCT.cbl#2200-PRICE", "cobol/PBCALC.cbl#PBCALC")).toBe(true);
    expect(has("cobol/PBINQ.cbl#2000-QUOTE", "cobol/PBCALC.cbl#PBCALC")).toBe(true);
    expect(has("cobol/PBEXTRCT.cbl#2200-PRICE", "cobol/PBEXTRCT.cbl#9000-ABEND")).toBe(true);
    expect(has("cobol/PBPOST.cbl#2000-FLAG-OVERDUE", "db2/POLICY#READ")).toBe(true); // cursor declared in WORKING-STORAGE
    expect(has("cobol/PBPOST.cbl#1200-INSERT-HISTORY", "db2/BILLING_HIST#WRITE")).toBe(true);
    expect(has("cobol/PBINQ.cbl#1000-READ-POLICY", "cics/POLMAST#READ")).toBe(true);
  });
  it("gives jobs and CICS transactions docks", () => {
    const triggers = g.fns.flatMap((f) => f.triggers);
    expect(triggers).toContainEqual({ kind: "job", name: "PBNIGHT" });
    expect(triggers).toContainEqual({ kind: "route", method: "CICS", path: "PBIQ" });
  });
  it("slices out what a job reaches, and follows data with lineage", () => {
    const month = slice(built, ["PBMONTH"]);
    expect(month.modules.map((m) => m.id)).not.toContain("jcl/PBNIGHT.jcl");
    expect(month.modules.map((m) => m.id)).toContain("cobol/PBFMTADR.cbl");
    const night = slice(built, ["PBNIGHT"]);
    expect(night.modules.map((m) => m.id)).not.toContain("jcl/PBMONTH.jcl");
    // PBNIGHT writes POLICY (DB2), but only datasets carry lineage between jobs
    expect(slice(built, ["PROD.PB.STMTS"]).modules.map((m) => m.id)).toContain("jcl/PBMONTH.jcl");
    for (const s of [month, night]) {
      const ids = new Set(s.fns.map((f) => f.id));
      for (const c of s.calls) expect(ids.has(c.from) && ids.has(c.to)).toBe(true);
    }
  });
});
