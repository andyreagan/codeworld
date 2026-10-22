import { describe, expect, it } from "vitest";
import { analyzeJs } from "../src/analyze/js";
import { beltKey, layoutWorld } from "../src/world/layout";
import { readExamples } from "../tools/examples";

for (const ex of readExamples(new URL("../examples", import.meta.url).pathname)) {
  describe(`layout: ${ex.name}`, () => {
    const g = analyzeJs(ex.files, { name: ex.name, ...ex.meta });
    const w = layoutWorld(g);
    it("places every function, and no two pads overlap", () => {
      expect(w.machines.size).toBe(g.fns.length);
      for (const a of w.pads)
        for (const b of w.pads) {
          if (a === b) continue;
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.z + a.d <= b.z || b.z + b.d <= a.z;
          expect(apart, `${a.mod.id} overlaps ${b.mod.id}`).toBe(true);
        }
    });
    it("keeps every machine on its pad", () => {
      for (const m of w.machines.values()) {
        const p = w.pads.find((p) => p.mod.id === m.pad)!;
        expect(m.x - m.size / 2).toBeGreaterThanOrEqual(p.x);
        expect(m.x + m.size / 2).toBeLessThanOrEqual(p.x + p.w);
        expect(m.z + m.size / 2).toBeLessThanOrEqual(p.z + p.d);
      }
    });
    it("gives every call a belt that only turns at right angles", () => {
      for (const c of g.calls) {
        if (c.from === c.to) continue;
        const b = w.belts.get(beltKey(c.from, c.to));
        expect(b, c.from + " -> " + c.to).toBeDefined();
        for (let i = 1; i < b!.pts.length; i++) {
          const [p, q] = [b!.pts[i - 1]!, b!.pts[i]!];
          const moved = [0, 1, 2].filter((k) => Math.abs(p[k]! - q[k]!) > 1e-6);
          expect(moved.length).toBe(1);
        }
      }
    });
    it("puts docks west of every pad", () => {
      const west = Math.min(...w.pads.map((p) => p.x));
      for (const d of w.docks) expect(d.x).toBeLessThan(west);
      expect(w.docks.length).toBe(g.fns.reduce((n, f) => n + f.triggers.length, 0));
    });
  });
}
