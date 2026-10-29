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
 *   between pads (over whatever's in the way), turning only at right angles.
 *   Raised belts run east-west on one level and north-south (in the
 *   corridor east of the caller's pad) on the level above, so crossings
 *   pass over each other; then `untangle` moves any run that would lie
 *   along another onto a free track beside it.
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
  /** The east edge of its column: its belts turn north or south in the corridor past it. */
  corridor: number;
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
  /**
   * Shared ports: when a machine has more callers (or callees) than its face
   * has room for, belts merge into trunks, and belts on one trunk may share
   * track. Keys like `in:<fn>:<port>`.
   */
  trunks: string[];
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
/** North-south gantry runs, a level above the east-west ones. */
export const GANTRY_Z_Y = GANTRY_Y + 0.6;
/** Belt runs closer than this (centre to centre) would touch. */
const TRACK = 0.62;
export const DOCK_W = 4;
export const DOCK_D = 3.2;
const PAD_MARGIN = 1.6;
const PAD_HEADER = 1.4;
const COL_GAP = 2.2;
const ROW_GAP = 1.4;
const PAD_GAP = 3;
const SILO_W = 3.4;
const LANE = TRACK;

/** Size by lines of code, grown if needed so every belt port on its busiest face gets its own track. */
export const machineSize = (f: FnNode, ports = 0): number => Math.min(8, Math.max(f.loc <= 6 ? 2 : f.loc <= 15 ? 3 : 4, Math.ceil(ports * TRACK + 0.6)));
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
function planPad(mod: ModuleNode, graph: CodeGraph, fnById: Map<string, FnNode>, ports: Map<string, number>) {
  const machineSize_ = (f: FnNode) => machineSize(f, ports.get(f.id));
  const own = new Set(mod.fns);
  const intra = graph.calls.filter((c) => own.has(c.from) && own.has(c.to)).map((c): [string, string] => [c.from, c.to]);
  const depth = depths(mod.fns, intra);
  const cols: FnNode[][] = [];
  for (const id of mod.fns) (cols[depth.get(id)!] ??= []).push(fnById.get(id)!);
  const spots: Omit<MachineSpot, "pad">[] = [];
  let x = PAD_MARGIN;
  let tallest = 0;
  for (const col of cols.filter(Boolean)) {
    const w = Math.max(...col.map(machineSize_));
    let z = PAD_HEADER + PAD_MARGIN;
    for (const fn of col) {
      const size = machineSize_(fn);
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
  // ports on each machine's busier face: calls out (east), or calls and triggers in (west)
  const outs = new Map<string, number>();
  const ins = new Map<string, number>();
  for (const c of graph.calls)
    if (c.from !== c.to) {
      outs.set(c.from, (outs.get(c.from) ?? 0) + 1);
      ins.set(c.to, (ins.get(c.to) ?? 0) + 1);
    }
  const ports = new Map(graph.fns.map((f) => [f.id, Math.max(outs.get(f.id) ?? 0, (ins.get(f.id) ?? 0) + f.triggers.length)]));
  const plans = new Map(graph.modules.map((m) => [m.id, planPad(m, graph, fnById, ports)]));
  // a column taller than this wraps into several, so a big flat codebase makes a square factory, not a ribbon
  const area = graph.modules.reduce((s, m) => s + (plans.get(m.id)!.w + PAD_GAP) * (plans.get(m.id)!.d + PAD_GAP), 0);
  const maxColumn = Math.max(40, Math.sqrt(area) * 1.1);
  const importers = new Map<string, string[]>();
  for (const [a, b] of modEdges) (importers.get(b) ?? importers.set(b, []).get(b)!).push(a);
  const outFrom = new Map<string, number>();
  for (const [a, b] of modEdges) if (a !== b) outFrom.set(a, (outFrom.get(a) ?? 0) + 1);
  const centreZ = new Map<string, number>();
  const pads: PadSpot[] = [];
  const machines = new Map<string, MachineSpot>();
  let x = 0;
  layers.forEach((layer, li) => {
    if (!layer) return;
    const bary = (m: ModuleNode) => {
      const zs = (importers.get(m.id) ?? []).map((a) => centreZ.get(a)).filter((z): z is number => z !== undefined);
      return zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : 0;
    };
    layer.sort((a, b) => bary(a) - bary(b) || a.id.localeCompare(b.id));
    // cut the layer into columns no taller than maxColumn
    const columns: ModuleNode[][] = [[]];
    let height = 0;
    for (const m of layer) {
      const d = plans.get(m.id)!.d + PAD_GAP;
      if (height + d > maxColumn && columns[columns.length - 1]!.length) {
        columns.push([]);
        height = 0;
      }
      columns[columns.length - 1]!.push(m);
      height += d;
    }
    for (const col of columns) {
      const total = col.reduce((s, m) => s + plans.get(m.id)!.d, 0) + PAD_GAP * (col.length - 1);
      const w = Math.max(...col.map((m) => plans.get(m.id)!.w));
      let z = -total / 2;
      for (const mod of col) {
        const p = plans.get(mod.id)!;
        const pad: PadSpot = { mod, layer: li, x, z, w: p.w, d: p.d, corridor: x + w };
        if (p.silo) pad.silo = { x: x + p.silo.x, z: z + p.silo.z };
        pads.push(pad);
        centreZ.set(mod.id, z + p.d / 2);
        for (const s of p.spots) machines.set(s.fn.id, { ...s, pad: mod.id, x: x + s.x, z: z + s.z });
        z += p.d + PAD_GAP;
      }
      x += w + 4 + LANE * col.reduce((n, m) => n + (outFrom.get(m.id) ?? 0), 0);
    }
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
  type Edge = {
    from: string; to: string; fx: number; fz: number; tx: number; tz: number; corridor: number; intra: boolean; padBottom: number;
    /** Its place among the belts leaving its source, and among those reaching its target. */
    fromIdx: number; toIdx: number; trunks: string[];
  };
  const edges: Edge[] = [];
  const padOf = new Map(pads.map((p) => [p.mod.id, p]));
  for (const c of graph.calls) {
    if (c.from === c.to) continue; // recursion: the machine feeds itself
    const a = machines.get(c.from)!;
    const b = machines.get(c.to)!;
    const pa = padOf.get(a.pad)!;
    edges.push({
      from: c.from, to: c.to, fx: a.x + a.size / 2, fz: a.z, tx: b.x - b.size / 2, tz: b.z,
      corridor: pa.corridor, intra: a.pad === b.pad, padBottom: pa.z + pa.d, fromIdx: 0, toIdx: 0, trunks: []
    });
  }
  for (const d of docks) {
    const b = machines.get(d.fn)!;
    edges.push({ from: d.id, to: d.fn, fx: d.x + DOCK_W / 2, fz: d.z, tx: b.x - b.size / 2, tz: b.z, corridor: d.x + DOCK_W / 2, intra: false, padBottom: 0, fromIdx: 0, toIdx: 0, trunks: [] });
  }
  // spread each machine's ports along its face, in the order of what's at the other end
  const spread = (key: "from" | "to", other: "tz" | "fz", coord: "fz" | "tz", idx: "fromIdx" | "toIdx", sizeOf: (id: string) => number) => {
    const groups = new Map<string, Edge[]>();
    for (const e of edges) (groups.get(e[key]) ?? groups.set(e[key], []).get(e[key])!).push(e);
    for (const [id, es] of groups) {
      es.sort((a, b) => a[other] - b[other]);
      const face = sizeOf(id) - 0.6;
      // a port per belt while there's room on the face; past that, neighbours merge onto shared ports
      const room = Math.max(1, Math.floor(face / TRACK) + 1);
      const n = Math.min(es.length, room);
      const step = n > 1 ? Math.min(0.75, face / (n - 1)) : 0;
      es.forEach((e, i) => {
        const port = Math.floor((i * n) / es.length);
        e[coord] += (port - (n - 1) / 2) * step;
        e[idx] = port;
        if (es.length > n) e.trunks.push(`${key === "from" ? "out" : "in"}:${id}:${port}`);
      });
    }
  };
  const sizeOf = (id: string) => machines.get(id)?.size ?? DOCK_D;
  spread("from", "tz", "fz", "fromIdx", sizeOf);
  spread("to", "fz", "tz", "toIdx", sizeOf);
  const lanes = new Map<number, number>();
  const belts = new Map<string, Belt>();
  // the north-south runs of ground belts between two sub-columns of a pad, so each gets its own track
  type Seg = { axis: 0 | 2; c: number; lo: number; hi: number };
  const crossings = new Map<string, Seg[]>();
  const crossAt = (e: Edge): number => {
    const mid = (e.fx + e.tx) / 2;
    const key = `${e.corridor}:${Math.round(mid * 2)}`;
    const used = crossings.get(key) ?? crossings.set(key, []).get(key)!;
    // a ground belt here is three runs: out of its port to x, across, and on into its target
    const runs = (x: number): Seg[] => [
      { axis: 0, c: e.fz, lo: e.fx, hi: x },
      { axis: 2, c: x, lo: Math.min(e.fz, e.tz), hi: Math.max(e.fz, e.tz) },
      { axis: 0, c: e.tz, lo: x, hi: e.tx }
    ];
    const hits = (a: Seg, b: Seg) => a.axis === b.axis && Math.abs(a.c - b.c) < TRACK - 1e-6 && Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) > -0.35;
    const options = [0, -1, 1, -2, 2].map((k) => mid + k * TRACK).filter((x) => x > e.fx + 0.45 && x < e.tx - 0.45);
    const x = options.find((x) => !runs(x).some((r) => used.some((u) => hits(r, u)))) ?? mid;
    used.push(...runs(x));
    return x;
  };
  for (const e of edges) {
    const y = BELT_Y;
    const pts: P3[] = [[e.fx, y, e.fz]];
    if (e.intra) {
      if (e.tx > e.fx + 0.6) {
        const xm = Math.abs(e.fz - e.tz) > 0.01 ? crossAt(e) : (e.fx + e.tx) / 2;
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
      const [H, HZ] = [GANTRY_Y, GANTRY_Z_Y];
      // each belt rises in its own column, stepping out from the machine, so their jogs never stack
      const up = e.fx + 0.6 + e.fromIdx * TRACK;
      const down = e.tx - 0.6 - e.toIdx * TRACK;
      pts.push([up, y, e.fz], [up, H, e.fz], [cx, H, e.fz]);
      if (Math.abs(e.fz - e.tz) > 0.01) pts.push([cx, HZ, e.fz], [cx, HZ, e.tz], [cx, H, e.tz]);
      pts.push([down, H, e.tz], [down, y, e.tz], [e.tx, y, e.tz]);
    }
    const key = beltKey(e.from, e.to);
    belts.set(key, { key, from: e.from, to: e.to, pts: dedupe(pts), elevated: !e.intra, trunks: e.trunks });
  }
  untangle([...belts.values()]);

  const xs = [...pads.flatMap((p) => [p.x, p.x + p.w]), ...docks.flatMap((d) => [d.x - DOCK_W / 2, d.x + DOCK_W / 2])];
  const zs = [...pads.flatMap((p) => [p.z, p.z + p.d]), ...docks.flatMap((d) => [d.z - DOCK_D / 2, d.z + DOCK_D / 2])];
  return {
    pads, machines, docks, belts,
    bounds: { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) }
  };
}

interface Run {
  key: string;
  trunks: string[];
  axis: 0 | 2;
  y: number;
  c: number;
  lo: number;
  hi: number;
}

const runOf = (b: Belt, p: P3, q: P3): Run | null => {
  if (Math.abs(p[1] - q[1]) > 1e-6) return null; // a lift
  const axis = Math.abs(p[0] - q[0]) > 1e-6 ? 0 : 2;
  return { key: b.key, trunks: b.trunks, axis, y: p[1], c: p[axis === 0 ? 2 : 0], lo: Math.min(p[axis], q[axis]), hi: Math.max(p[axis], q[axis]) };
};

const sameTrunk = (a: Run, b: Run): boolean => a.trunks.some((t) => b.trunks.includes(t));

const clash = (a: Run, b: Run): boolean =>
  a.key !== b.key && !sameTrunk(a, b) && a.axis === b.axis && Math.abs(a.y - b.y) < 0.3 && Math.abs(a.c - b.c) < TRACK - 1e-6 &&
  Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) > -0.35;

/**
 * Placed runs, bucketed by level, axis, track (1-tile cells) and extent
 * (8-tile cells), so checking a run for clashes looks at its neighbours
 * only, not the whole factory.
 */
class Placed {
  private cells = new Map<string, Run[]>();
  private static key = (r: Run, c: number, a: number) => `${r.axis}:${Math.round(r.y * 10)}:${c}:${a}`;
  private static span = (r: Run) => [Math.floor((r.lo - 0.4) / 8), Math.floor((r.hi + 0.4) / 8)] as const;
  add(...rs: Run[]): void {
    for (const r of rs) {
      const [a0, a1] = Placed.span(r);
      for (let a = a0; a <= a1; a++) {
        const k = Placed.key(r, Math.floor(r.c), a);
        (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(r);
      }
    }
  }
  clashes(r: Run): boolean {
    const [a0, a1] = Placed.span(r);
    const c = Math.floor(r.c);
    for (let dc = -1; dc <= 1; dc++)
      for (let a = a0; a <= a1; a++) for (const p of this.cells.get(Placed.key(r, c + dc, a)) ?? []) if (clash(r, p)) return true;
    return false;
  }
}

/** The fixed stub at each port: how far a belt runs straight out before it may jog aside. */
const STUB = 0.3;

/**
 * Track assignment: walk every belt's level runs, longest belts first, and
 * slide any run that would lie along an already-placed one sideways onto
 * the nearest free track. Only a short stub at each port stays put; where a
 * moved run meets a port stub or a lift, a short jog keeps them in place.
 */
function untangle(belts: Belt[]): void {
  const placed = new Placed();
  const stub = (b: Belt, port: P3, toward: P3): void => {
    const r = runOf(b, port, toward);
    if (!r) return;
    const d = Math.sign(toward[r.axis] - port[r.axis]) * STUB;
    placed.add({ ...r, lo: Math.min(port[r.axis], port[r.axis] + d), hi: Math.max(port[r.axis], port[r.axis] + d) });
  };
  for (const b of belts) {
    stub(b, b.pts[0]!, b.pts[1]!);
    stub(b, b.pts[b.pts.length - 1]!, b.pts[b.pts.length - 2]!);
  }
  const len = (b: Belt) => b.pts.reduce((s, p, i) => (i ? s + Math.abs(p[0] - b.pts[i - 1]![0]) + Math.abs(p[2] - b.pts[i - 1]![2]) : 0), 0);
  for (const b of [...belts].sort((x, y) => len(y) - len(x))) {
    const pts = b.pts;
    // from the far end back, so the jogs spliced in behind never come round again
    for (let i = pts.length - 2; i >= 0; i--) {
      const run = runOf(b, pts[i]!, pts[i + 1]!);
      if (!run) continue;
      const first = i === 0;
      const last = i === pts.length - 2;
      const room = run.hi - run.lo - (first ? STUB : 0) - (last ? STUB : 0);
      const perp = run.axis === 0 ? 2 : 0;
      const dir = Math.sign(pts[i + 1]![run.axis] - pts[i]![run.axis]);
      // moved to track c, the run needs a jog at each end to rejoin its belt: those must be clear too
      const near = first ? pts[0]![run.axis] + dir * STUB : pts[i]![run.axis];
      const far = last ? pts[i + 1]![run.axis] - dir * STUB : pts[i + 1]![run.axis];
      const jogs = (c: number): Run[] =>
        c === run.c ? [] : [near, far].map((at) => ({ key: run.key, trunks: run.trunks, axis: perp as 0 | 2, y: run.y, c: at, lo: Math.min(run.c, c), hi: Math.max(run.c, c) }));
      const free = (c: number) => ![{ ...run, c }, ...jogs(c)].some((r) => placed.clashes(r));
      let c = run.c;
      if (room > 0.15 && !free(c)) {
        let k = 1;
        for (; k < 40; k++) if (free((c = run.c + Math.ceil(k / 2) * TRACK * (k % 2 ? 1 : -1)))) break;
        if (k === 40) c = run.c; // nowhere clear nearby: stay put rather than wander off
      }
      placed.add({ ...run, c }, ...jogs(c));
      if (c === run.c) continue;
      const moved = (p: P3): P3 => {
        const q: P3 = [...p];
        q[perp] = c;
        return q;
      };
      // the far end: jog before the port stub or a lift, or stretch the level run that follows
      if (last) {
        const anchor: P3 = [...pts[i + 1]!];
        anchor[run.axis] -= dir * STUB;
        pts.splice(i + 1, 0, moved(anchor), anchor);
      } else if (runOf(b, pts[i + 1]!, pts[i + 2]!)) pts[i + 1]![perp] = c;
      else pts.splice(i + 1, 0, moved(pts[i + 1]!));
      // the near end, likewise
      if (first) {
        const anchor: P3 = [...pts[0]!];
        anchor[run.axis] += dir * STUB;
        pts.splice(1, 0, anchor, moved(anchor));
      } else if (runOf(b, pts[i - 1]!, pts[i]!)) pts[i]![perp] = c;
      else pts.splice(i + 1, 0, moved(pts[i]!));
    }
    b.pts = dedupe(pts);
  }
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
