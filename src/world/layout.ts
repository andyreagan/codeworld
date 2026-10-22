import type { CodeGraph, FnNode, ModuleNode, Trigger } from "../analyze/types";

/**
 * Codebase -> factory floor plan. World units are tiles; x runs east (the
 * direction work flows), z south, y up.
 *
 * - Each module is a concrete pad. Pads stand in columns by depth in the
 *   module dependency graph, so requests come in on the west and work flows
 *   east toward the stores, which usually end up on the far side.
 * - Each function is a machine on its module's pad, in sub-columns by depth
 *   among the module's own calls. Size follows lines of code, tier
 *   (colour) follows complexity.
 * - Each entry point (route, inbox, timer) is a dock west of everything.
 * - Each call edge is a belt: on the ground inside a pad, raised on gantries
 *   between pads (over whatever's in the way), turning only at right angles,
 *   each in its own lane of the corridor east of its caller's pad.
 */

export type P3 = [number, number, number];

export interface MachineSpot {
  fn: FnNode;
  pad: string;
  /** Centre. */
  x: number;
  z: number;
  size: number;
  tier: 1 | 2 | 3;
}

export interface PadSpot {
  mod: ModuleNode;
  layer: number;
  /** North-west corner, and extent. */
  x: number;
  z: number;
  w: number;
  d: number;
  /** A store's tank, centre. */
  silo?: { x: number; z: number };
}

export interface DockSpot {
  id: string;
  fn: string;
  trigger: Trigger;
  x: number;
  z: number;
}

export interface Belt {
  key: string;
  from: string;
  to: string;
  pts: P3[];
  elevated: boolean;
}

export interface WorldLayout {
  pads: PadSpot[];
  machines: Map<string, MachineSpot>;
  docks: DockSpot[];
  belts: Map<string, Belt>;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export const BELT_Y = 0.14;
export const GANTRY_Y = 2.8;
export const DOCK_W = 4;
export const DOCK_D = 3.2;
const PAD_MARGIN = 1.6;
const PAD_HEADER = 1.4;
const COL_GAP = 2.2;
const ROW_GAP = 1.4;
const PAD_GAP = 3;
const SILO_W = 3.4;
const LANE = 0.5;

export const machineSize = (f: FnNode): number => (f.loc <= 6 ? 2 : f.loc <= 15 ? 3 : 4);
export const machineTier = (f: FnNode): 1 | 2 | 3 => (f.complexity <= 2 ? 1 : f.complexity <= 5 ? 2 : 3);
export const beltKey = (from: string, to: string): string => `${from}->${to}`;
export const dockId = (fn: string, i: number): string => `dock:${fn}:${i}`;

/** Longest-path depth of each node from the nodes nothing points at (back edges of cycles ignored). */
function depths(nodes: string[], edges: [string, string][]): Map<string, number> {
  const out = new Map<string, string[]>(nodes.map((n) => [n, []]));
  const indeg = new Map<string, number>(nodes.map((n) => [n, 0]));
  // drop back edges, found by DFS, so what's left is a DAG
  const state = new Map<string, 1 | 2>();
  const keep: [string, string][] = [];
  const adj = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const [a, b] of edges) if (a !== b) adj.get(a)?.push(b);
  const visit = (n: string) => {
    state.set(n, 1);
    for (const m of adj.get(n) ?? []) {
      if (state.get(m) === 1) continue; // back edge
      keep.push([n, m]);
      if (!state.has(m)) visit(m);
    }
    state.set(n, 2);
  };
  for (const n of nodes) if (!state.has(n)) visit(n);
  for (const [a, b] of keep) {
    out.get(a)!.push(b);
    indeg.set(b, indeg.get(b)! + 1);
  }
  const depth = new Map<string, number>(nodes.map((n) => [n, 0]));
  const queue = nodes.filter((n) => indeg.get(n) === 0);
  while (queue.length) {
    const n = queue.shift()!;
    for (const m of out.get(n)!) {
      depth.set(m, Math.max(depth.get(m)!, depth.get(n)! + 1));
      indeg.set(m, indeg.get(m)! - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
  }
  return depth;
}

/** Lay out a pad's machines (relative to the pad's corner) and size the pad. */
function planPad(mod: ModuleNode, graph: CodeGraph, fnById: Map<string, FnNode>) {
  const own = new Set(mod.fns);
  const intra = graph.calls.filter((c) => own.has(c.from) && own.has(c.to)).map((c): [string, string] => [c.from, c.to]);
  const depth = depths(mod.fns, intra);
  const cols: FnNode[][] = [];
  for (const id of mod.fns) (cols[depth.get(id)!] ??= []).push(fnById.get(id)!);
  const spots: Omit<MachineSpot, "pad">[] = [];
  let x = PAD_MARGIN;
  let tallest = 0;
  for (const col of cols.filter(Boolean)) {
    const w = Math.max(...col.map(machineSize));
    let z = PAD_HEADER + PAD_MARGIN;
    for (const fn of col) {
      const size = machineSize(fn);
      spots.push({ fn, x: x + w / 2, z: z + size / 2, size, tier: machineTier(fn) });
      z += size + ROW_GAP;
    }
    tallest = Math.max(tallest, z - ROW_GAP);
    x += w + COL_GAP;
  }
  x -= COL_GAP;
  let silo: { x: number; z: number } | undefined;
  if (mod.store) {
    silo = { x: x + COL_GAP / 2 + SILO_W / 2, z: PAD_HEADER + PAD_MARGIN + SILO_W / 2 };
    x += COL_GAP / 2 + SILO_W;
    tallest = Math.max(tallest, PAD_HEADER + PAD_MARGIN + SILO_W);
  }
  return { spots, w: Math.max(x + PAD_MARGIN, 6), d: tallest + PAD_MARGIN, silo };
}

export function layoutWorld(graph: CodeGraph): WorldLayout {
  const fnById = new Map(graph.fns.map((f) => [f.id, f]));
  const modOf = (fn: string) => fnById.get(fn)!.module;
  const modIds = graph.modules.map((m) => m.id);
  const modEdges: [string, string][] = [];
  for (const c of graph.calls) if (modOf(c.from) !== modOf(c.to)) modEdges.push([modOf(c.from), modOf(c.to)]);
  for (const m of graph.modules) for (const i of m.imports) if (!i.startsWith("ext:")) modEdges.push([m.id, i]);
  const layerOf = depths(modIds, modEdges);

  // columns of pads; within a column, order by where their callers sit (barycentre), then by path
  const layers: ModuleNode[][] = [];
  for (const m of graph.modules) (layers[layerOf.get(m.id)!] ??= []).push(m);
  const plans = new Map(graph.modules.map((m) => [m.id, planPad(m, graph, fnById)]));
  const centreZ = new Map<string, number>();
  const pads: PadSpot[] = [];
  const machines = new Map<string, MachineSpot>();
  const outCount = (l: number) => modEdges.filter(([a, b]) => layerOf.get(a) === l && a !== b).length;
  let x = 0;
  layers.forEach((layer, li) => {
    if (!layer) return;
    const bary = (m: ModuleNode) => {
      const zs = modEdges.filter(([, b]) => b === m.id).map(([a]) => centreZ.get(a)).filter((z): z is number => z !== undefined);
      return zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : 0;
    };
    layer.sort((a, b) => bary(a) - bary(b) || a.id.localeCompare(b.id));
    const total = layer.reduce((s, m) => s + plans.get(m.id)!.d, 0) + PAD_GAP * (layer.length - 1);
    let z = -total / 2;
    const w = Math.max(...layer.map((m) => plans.get(m.id)!.w));
    for (const mod of layer) {
      const p = plans.get(mod.id)!;
      const pad: PadSpot = { mod, layer: li, x, z, w: p.w, d: p.d };
      if (p.silo) pad.silo = { x: x + p.silo.x, z: z + p.silo.z };
      pads.push(pad);
      centreZ.set(mod.id, z + p.d / 2);
      for (const s of p.spots) machines.set(s.fn.id, { ...s, pad: mod.id, x: x + s.x, z: z + s.z });
      z += p.d + PAD_GAP;
    }
    x += w + 4 + LANE * outCount(li);
  });

  // docks, in a column west of everything, each level with its handler where there's room
  const want: { fn: FnNode; trigger: Trigger; i: number; z: number }[] = [];
  for (const fn of graph.fns) fn.triggers.forEach((trigger, i) => want.push({ fn, trigger, i, z: machines.get(fn.id)!.z }));
  want.sort((a, b) => a.z - b.z);
  const nDocks = want.length;
  const dockX = -(4 + LANE * nDocks) - DOCK_W / 2;
  const docks: DockSpot[] = [];
  let floor = -Infinity;
  for (const w of want) {
    const z = Math.max(w.z, floor + DOCK_D + 2);
    floor = z;
    docks.push({ id: dockId(w.fn.id, w.i), fn: w.fn.id, trigger: w.trigger, x: dockX, z });
  }

  // belts
  type Edge = { from: string; to: string; fx: number; fz: number; tx: number; tz: number; corridor: number; intra: boolean; padBottom: number };
  const edges: Edge[] = [];
  const padOf = new Map(pads.map((p) => [p.mod.id, p]));
  for (const c of graph.calls) {
    if (c.from === c.to) continue; // recursion: the machine feeds itself
    const a = machines.get(c.from)!;
    const b = machines.get(c.to)!;
    const pa = padOf.get(a.pad)!;
    edges.push({
      from: c.from, to: c.to, fx: a.x + a.size / 2, fz: a.z, tx: b.x - b.size / 2, tz: b.z,
      corridor: pa.x + pa.w, intra: a.pad === b.pad, padBottom: pa.z + pa.d
    });
  }
  for (const d of docks) {
    const b = machines.get(d.fn)!;
    edges.push({ from: d.id, to: d.fn, fx: d.x + DOCK_W / 2, fz: d.z, tx: b.x - b.size / 2, tz: b.z, corridor: d.x + DOCK_W / 2, intra: false, padBottom: 0 });
  }
  // spread each machine's ports along its face, in the order of what's at the other end
  const spread = (key: "from" | "to", other: "tz" | "fz", coord: "fz" | "tz", sizeOf: (id: string) => number) => {
    const groups = new Map<string, Edge[]>();
    for (const e of edges) (groups.get(e[key]) ?? groups.set(e[key], []).get(e[key])!).push(e);
    for (const [id, es] of groups) {
      es.sort((a, b) => a[other] - b[other]);
      const face = sizeOf(id) - 0.7;
      const step = es.length > 1 ? Math.min(0.6, face / (es.length - 1)) : 0;
      es.forEach((e, i) => (e[coord] += (i - (es.length - 1) / 2) * step));
    }
  };
  const sizeOf = (id: string) => machines.get(id)?.size ?? DOCK_D;
  spread("from", "tz", "fz", sizeOf);
  spread("to", "fz", "tz", sizeOf);
  const lanes = new Map<number, number>();
  const belts = new Map<string, Belt>();
  for (const e of edges) {
    const y = BELT_Y;
    const pts: P3[] = [[e.fx, y, e.fz]];
    if (e.intra) {
      if (e.tx > e.fx + 0.6) {
        const xm = (e.fx + e.tx) / 2;
        if (Math.abs(e.fz - e.tz) > 0.01) pts.push([xm, y, e.fz], [xm, y, e.tz]);
      } else {
        // backward, or within a column: round by the pad's south margin
        const zb = e.padBottom - 0.8;
        pts.push([e.fx + 0.5, y, e.fz], [e.fx + 0.5, y, zb], [e.tx - 0.5, y, zb], [e.tx - 0.5, y, e.tz]);
      }
      pts.push([e.tx, y, e.tz]);
    } else {
      const lane = lanes.get(e.corridor) ?? 0;
      lanes.set(e.corridor, lane + 1);
      const cx = e.corridor + 1.2 + lane * LANE;
      const H = GANTRY_Y + (lane % 3) * 0.12;
      const up = e.fx + 0.6;
      const down = e.tx - 0.6;
      pts.push([up, y, e.fz], [up, H, e.fz], [cx, H, e.fz], [cx, H, e.tz], [down, H, e.tz], [down, y, e.tz], [e.tx, y, e.tz]);
    }
    const key = beltKey(e.from, e.to);
    belts.set(key, { key, from: e.from, to: e.to, pts: dedupe(pts), elevated: !e.intra });
  }

  const xs = [...pads.flatMap((p) => [p.x, p.x + p.w]), ...docks.flatMap((d) => [d.x - DOCK_W / 2, d.x + DOCK_W / 2])];
  const zs = [...pads.flatMap((p) => [p.z, p.z + p.d]), ...docks.flatMap((d) => [d.z - DOCK_D / 2, d.z + DOCK_D / 2])];
  return {
    pads, machines, docks, belts,
    bounds: { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) }
  };
}

/** Drop repeated and collinear-redundant points. */
function dedupe(pts: P3[]): P3[] {
  const out: P3[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]) + Math.abs(q[2] - p[2]) < 1e-6) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i > 0; i--) {
    const [a, b, c] = [out[i - 1]!, out[i]!, out[i + 1]!];
    const d1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const d2 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    const cross = Math.abs(d1[1]! * d2[2]! - d1[2]! * d2[1]!) + Math.abs(d1[2]! * d2[0]! - d1[0]! * d2[2]!) + Math.abs(d1[0]! * d2[1]! - d1[1]! * d2[0]!);
    const dot = d1[0]! * d2[0]! + d1[1]! * d2[1]! + d1[2]! * d2[2]!;
    if (cross < 1e-6 && dot > 0) out.splice(i, 1);
  }
  return out;
}
