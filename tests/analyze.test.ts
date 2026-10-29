import { describe, expect, it } from "vitest";
import { analyzeJs, instrumentJs, resolveSpec } from "../src/analyze/js";
import { graphOf, readExamples } from "../tools/examples";

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
  for (const ex of examples) expect(graphOf(ex).fns.length).toBeGreaterThan(0);
});

describe("real-world shapes", () => {
  const files = {
    "a.js": `
import Cart, { helper } from "./b.js";
const total = (items) => items.reduce((s, i) => s + price(i), 0);
let price = function (i) { return i.p; };
export class Shop {
  constructor() { this.cart = new Cart(); }
  checkout() { return this.sum() + helper(); }
  sum() { return total(this.cart.items); }
  static open() { return new Shop(); }
}
export function main() { return Shop.open().checkout(); }
`,
    "b.js": `
export default class Cart { constructor() { this.items = []; } }
export const helper = () => 1;
`,
    "c.js": `
const b = require("./d");
const { twice } = require("./d.js");
module.exports.run = function () { return b() + twice(2); };
`,
    "d.js": `
function once(x) { return x; }
function twice(x) { return once(x) * 2; }
module.exports = once;
module.exports.twice = twice;
`
  };
  const g = analyzeJs(files, { name: "t", title: "t", description: "" });
  const calls = g.calls.map((c) => `${c.from} -> ${c.to}`).sort();
  it("maps arrows, function expressions, classes and CommonJS", () => {
    expect(g.fns.map((f) => f.id).sort()).toEqual([
      "a.js#Shop.checkout", "a.js#Shop.constructor", "a.js#Shop.open", "a.js#Shop.sum", "a.js#main", "a.js#price", "a.js#total",
      "b.js#Cart.constructor", "b.js#helper", "c.js#run", "d.js#once", "d.js#twice"
    ]);
    expect(g.fns.find((f) => f.id === "d.js#once")!.exported).toBe(true);
  });
  it("links this.method, Class.static, new Class, default imports and require", () => {
    expect(calls).toEqual([
      "a.js#Shop.checkout -> a.js#Shop.sum",
      "a.js#Shop.checkout -> b.js#helper",
      "a.js#Shop.constructor -> b.js#Cart.constructor",
      "a.js#Shop.open -> a.js#Shop.constructor",
      "a.js#Shop.sum -> a.js#total",
      "a.js#main -> a.js#Shop.open",
      "a.js#total -> a.js#price",
      "c.js#run -> d.js#once",
      "c.js#run -> d.js#twice",
      "d.js#twice -> d.js#once"
    ]);
  });
  it("only instruments hoisted declarations", () => {
    expect(instrumentJs("a.js", files["a.js"])).toMatch(/^main = globalThis.__cw.wrap\("a.js#main", main\); \n/);
  });
});
