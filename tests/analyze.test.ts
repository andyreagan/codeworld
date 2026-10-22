import { describe, expect, it } from "vitest";
import { analyzeJs, instrumentJs, resolveSpec } from "../src/analyze/js";
import { readExamples } from "../tools/examples";

const examples = readExamples(new URL("../examples", import.meta.url).pathname);
const graph = (name: string) => {
  const ex = examples.find((e) => e.name === name)!;
  return analyzeJs(ex.files, { name, ...ex.meta });
};

describe("resolveSpec", () => {
  it("resolves relative imports and marks packages external", () => {
    expect(resolveSpec("routes/orders.js", "../domain/pricing.js")).toBe("domain/pricing.js");
    expect(resolveSpec("a.js", "./b")).toBe("b.js");
    expect(resolveSpec("a.js", "lodash")).toBe("ext:lodash");
  });
});

describe("hello-pipeline", () => {
  const g = graph("hello-pipeline");
  it("finds modules, functions and docs", () => {
    expect(g.modules.map((m) => m.id)).toEqual(["api.js", "log.js", "text.js"]);
    expect(g.modules.find((m) => m.id === "log.js")!.store).toBe(true);
    expect(g.modules.find((m) => m.id === "text.js")!.doc).toBe("Text helpers: checking and dressing up names.");
    const greet = g.fns.find((f) => f.id === "api.js#greet")!;
    expect(greet.doc).toBe("Greet someone by name, and log that we did.");
    expect(greet.triggers).toEqual([{ kind: "route", method: "POST", path: "/greet", example: { name: "ada lovelace" } }]);
    expect(g.fns.find((f) => f.id === "text.js#capitalize")!.exported).toBe(false);
  });
  it("links calls across modules and inside callbacks", () => {
    const calls = g.calls.map((c) => `${c.from} -> ${c.to}`).sort();
    expect(calls).toEqual([
      "api.js#greet -> log.js#record",
      "api.js#greet -> text.js#format",
      "api.js#greet -> text.js#validate",
      "text.js#format -> text.js#capitalize"
    ]);
  });
  it("counts branches", () => {
    expect(g.fns.find((f) => f.id === "text.js#validate")!.complexity).toBe(5);
  });
});

describe("order-service", () => {
  const g = graph("order-service");
  it("resolves namespace imports", () => {
    expect(g.calls.some((c) => c.from === "routes/orders.js#createOrder" && c.to === "store/orders.js#insert")).toBe(true);
  });
  it("reads every trigger kind", () => {
    const t = g.fns.flatMap((f) => f.triggers.map((x) => x.kind)).sort();
    expect(t).toEqual(["cron", "inbox", "route", "route"]);
    expect(g.fns.find((f) => f.name === "importInventory")!.triggers[0]).toEqual({ kind: "inbox", glob: "*.csv", sample: "samples/inventory.csv" });
  });
});

describe("instrumentJs", () => {
  it("rebinds every top-level function on line 1", () => {
    const src = "export function a() { return b(); }\nfunction b() { return 1; }\n";
    const out = instrumentJs("m.js", src);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out).toContain('a = globalThis.__cw.wrap("m.js#a", a);');
    expect(out).toContain('b = globalThis.__cw.wrap("m.js#b", b);');
  });
});

it("analyzes every example", () => {
  for (const ex of examples) expect(analyzeJs(ex.files, { name: ex.name, ...ex.meta }).fns.length).toBeGreaterThan(0);
});
