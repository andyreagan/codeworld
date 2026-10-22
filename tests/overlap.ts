import type { Belt } from "../src/world/layout";

/** Pairs of belt runs (from different belts, not merged on one trunk) lying along each other: same height, same line, overlapping extent. */
export function overlaps(belts: Iterable<Belt>): string[] {
  type Seg = { key: string; trunks: string[]; axis: 0 | 2; y: number; c: number; lo: number; hi: number };
  const segs: Seg[] = [];
  for (const b of belts)
    for (let i = 1; i < b.pts.length; i++) {
      const [p, q] = [b.pts[i - 1]!, b.pts[i]!];
      if (Math.abs(p[1] - q[1]) > 1e-6) continue;
      const axis = Math.abs(p[0] - q[0]) > 1e-6 ? 0 : 2;
      const other = axis === 0 ? 2 : 0;
      segs.push({ key: b.key, trunks: b.trunks, axis, y: p[1], c: p[other], lo: Math.min(p[axis], q[axis]), hi: Math.max(p[axis], q[axis]) });
    }
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const [a, b] = [segs[i]!, segs[j]!];
      if (a.key === b.key || a.trunks.some((t) => b.trunks.includes(t)) || a.axis !== b.axis || Math.abs(a.y - b.y) > 0.3 || Math.abs(a.c - b.c) > 0.5) continue;
      if (Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) > 0.3) out.push(`${a.key} | ${b.key} @ ${a.axis ? "x" : "z"}=${a.c.toFixed(2)} y=${a.y.toFixed(1)}`);
    }
  return out;
}
