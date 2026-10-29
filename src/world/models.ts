import * as THREE from "three";
import { Builder, brighten, type V3 } from "./builder";

/**
 * Every model in the world, procedural and low-poly, in a Factorio-ish
 * industrial palette: concrete pads with hazard edges, machines painted by
 * tier, steel belts. Models sit on y = 0 and face east (+x): work comes in
 * on the west face and leaves on the east.
 */

export const STEEL = 0x5a6068;
export const STEEL_D = 0x34383e;
export const STEEL_L = 0x8a929c;
export const CONCRETE = 0x8d8a82;
export const HAZARD = 0xe2b33a;
export const HAZARD_D = 0x2a2824;
export const AMBER = 0xffa531;
export const GOOD = 0x6dff9a;
export const BAD = 0xff4a3a;

/** Machine paint by tier (complexity): khaki, steel blue, amber, as Factorio's assemblers 1–3. */
export const TIERS: Record<1 | 2 | 3, { main: number; dark: number }> = {
  1: { main: 0xa49468, dark: 0x6c6146 },
  2: { main: 0x3f74b3, dark: 0x264a75 },
  3: { main: 0xd2862a, dark: 0x8a5418 }
};

export interface MachineModel {
  body: THREE.BufferGeometry;
  /** The flywheel on the roof: spins while the function runs. Pivot at its centre. */
  gear: THREE.BufferGeometry;
  gearAt: V3;
  /** The status lamp and the chimney mouth (for smoke). */
  lampAt: V3;
  smokeAt: V3;
  height: number;
}

const machineCache = new Map<string, MachineModel>();

/** A function's machine: plinth, housing, intake on the west, chute on the east, flywheel and chimney on top. */
export function machineModel(size: number, tier: 1 | 2 | 3, exported: boolean): MachineModel {
  const key = `${size}:${tier}:${exported}`;
  const hit = machineCache.get(key);
  if (hit) return hit;
  const t = TIERS[tier];
  const s = size;
  const h = 0.7 + s * 0.28;
  const b = new Builder();
  b.block(s, 0.22, s, STEEL_D, [0, 0, 0], 0.05);
  b.block(s - 0.35, h, s - 0.35, t.main, [0, 0.22, 0], 0.12, 1.3);
  // corner posts
  for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const)
    b.box(0.18, h + 0.05, 0.18, t.dark, [x * (s / 2 - 0.22), 0.22, z * (s / 2 - 0.22)]);
  // vents along the north and south faces
  for (let i = 0; i < s; i++) {
    const x = -s / 2 + 0.55 + i * ((s - 1.1) / Math.max(1, s - 1));
    for (const z of [-1, 1]) b.box(0.32, 0.12, 0.04, STEEL_D, [x, 0.22 + h * 0.55, z * (s / 2 - 0.17)]);
  }
  // roof plate and flywheel housing
  b.block(s * 0.55, 0.14, s * 0.55, t.dark, [0, 0.22 + h, 0], 0.04);
  // intake hopper (west) and output chute (east)
  b.cyl(0.36, 0.2, 0.42, STEEL, [-s / 2 + 0.1, 0.22 + h * 0.25, 0], 4, { rot: [0, Math.PI / 4, 0] });
  b.box(0.42, 0.28, 0.5, STEEL_L, [s / 2 - 0.05, 0.12, 0]);
  // chimney
  const cx = s / 2 - 0.5;
  const cz = -(s / 2 - 0.5);
  b.cyl(0.16, 0.2, h * 0.75, STEEL_D, [cx, 0.22 + h, cz], 8);
  b.cyl(0.2, 0.2, 0.08, STEEL_L, [cx, 0.22 + h * 1.75 - 0.08, cz], 8);
  // an exported function has a yellow loading arm by its chute: it does business with other pads
  if (exported) {
    b.box(0.22, 0.5, 0.22, HAZARD_D, [s / 2 - 0.2, 0.22, s / 2 - 0.45]);
    b.box(0.14, 0.14, 0.9, HAZARD, [s / 2 - 0.2, 0.68, s / 2 - 0.65], { rot: [0.5, 0, 0] });
  }
  const gr = Math.min(0.5, s * 0.17);
  const gear = new Builder().gear(gr, 0.12, 8, STEEL_L, [0, 0, 0]).cyl(gr * 0.3, gr * 0.3, 0.16, HAZARD, [0, 0, 0], 8).build();
  gear.translate(0, -0.06, 0);
  const m: MachineModel = {
    body: b.build(),
    gear,
    gearAt: [0, 0.22 + h + 0.2, 0],
    lampAt: [-(s / 2 - 0.35), 0.22 + h + 0.12, s / 2 - 0.35],
    smokeAt: [cx, 0.22 + h * 1.75 + 0.1, cz],
    height: 0.22 + h
  };
  machineCache.set(key, m);
  return m;
}

/** A module's pad: a concrete slab with a hazard-striped kerb and a darker header strip for its sign. */
export function padModel(w: number, d: number, tint: number): THREE.BufferGeometry {
  const b = new Builder(0.1);
  b.box(w, 0.1, d, tint, [w / 2, 0, d / 2]);
  b.box(w - 0.6, 0.02, 1.0, brighten(tint, 0.78), [w / 2, 0.1, 0.75]);
  const stripe = 0.6;
  const kerb = (len: number, place: (u: number) => V3, along: "x" | "z") => {
    const n = Math.floor(len / stripe);
    for (let i = 0; i < n; i++) {
      const c = i % 2 ? HAZARD : HAZARD_D;
      const at = place(i * stripe + stripe / 2 + (len - n * stripe) / 2);
      if (along === "x") b.box(stripe, 0.16, 0.18, c, at, { grade: 0.15 });
      else b.box(0.18, 0.16, stripe, c, at, { grade: 0.15 });
    }
  };
  kerb(w, (u) => [u, 0, 0.09], "x");
  kerb(w, (u) => [u, 0, d - 0.09], "x");
  kerb(d - 0.36, (u) => [0.09, 0, u + 0.18], "z");
  kerb(d - 0.36, (u) => [w - 0.09, 0, u + 0.18], "z");
  return b.build();
}

/** A store's tank: a ribbed silo with a glass gauge tube on its west side (the fill is a separate mesh). */
export function siloModel(): { body: THREE.BufferGeometry; gaugeAt: V3; gaugeH: number; height: number } {
  const b = new Builder(0.35);
  const r = 1.35;
  const h = 3.2;
  b.cyl(r + 0.15, r + 0.2, 0.25, STEEL_D, [0, 0, 0], 16);
  b.cyl(r, r, h, 0xb8bcc2, [0, 0.25, 0], 16);
  for (let i = 1; i < 4; i++) b.cyl(r + 0.05, r + 0.05, 0.08, STEEL, [0, 0.25 + (i * h) / 4, 0], 16, { grade: 0 });
  b.cyl(0.25, r, 0.5, 0xa0a4aa, [0, 0.25 + h, 0], 16);
  b.cyl(0.18, 0.18, 0.25, STEEL_D, [0, 0.75 + h, 0], 8);
  // ladder up the south side
  b.box(0.05, h, 0.05, HAZARD_D, [-0.2, 0.25, r + 0.08]).box(0.05, h, 0.05, HAZARD_D, [0.2, 0.25, r + 0.08]);
  for (let y = 0.5; y < h; y += 0.35) b.box(0.45, 0.04, 0.04, HAZARD_D, [0, y, r + 0.08]);
  // gauge tube frame
  b.box(0.3, h - 0.4, 0.3, STEEL_D, [-r - 0.1, 0.45, 0]);
  return { body: b.build(), gaugeAt: [-r - 0.26, 0.55, 0], gaugeH: h - 0.6, height: h + 1 };
}

export type DockKind = "route" | "inbox" | "cron" | "job";

export interface DockModel {
  body: THREE.BufferGeometry;
  /** A moving part: the route station's radar dish, the hopper's crusher drum, the clock's hand. */
  spinner: THREE.BufferGeometry;
  spinnerAt: V3;
  spinAxis: "x" | "y" | "z";
  lampAt: V3;
}

/** An entry point, 4 x 3.2 tiles, facing east. */
export function dockModel(kind: DockKind, accent: number): DockModel {
  const b = new Builder(0.3);
  const W = 4;
  const D = 3.2;
  b.block(W, 0.3, D, STEEL_D, [0, 0, 0], 0.06);
  if (kind === "route") {
    // a receiving station: platform, canopy on posts, a radar mast listening for requests
    b.block(W - 0.4, 0.25, D - 0.6, CONCRETE, [0, 0.3, 0], 0.05);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) b.box(0.16, 1.7, 0.16, STEEL, [x * 1.5, 0.55, z * 1.0]);
    b.block(W - 0.2, 0.16, D - 0.8, accent, [0, 2.25, 0], 0.05, 1.3);
    b.box(1.2, 0.8, 1.0, STEEL_L, [-0.9, 0.55, 0]);
    b.box(0.5, 0.35, 0.04, 0x1a2a3a, [-0.9, 0.95, 0.51]);
    b.cyl(0.08, 0.1, 1.6, STEEL, [0.9, 2.41, -0.6], 6);
    const dish = new Builder(0)
      .cyl(0.7, 0.15, 0.25, STEEL_L, [0, 0, 0], 12, { rot: [Math.PI / 2 - 0.5, 0, 0] })
      .box(0.06, 0.06, 0.5, STEEL_D, [0, 0.05, 0.05])
      .build();
    return { body: b.build(), spinner: dish, spinnerAt: [0.9, 4.1, -0.6], spinAxis: "y", lampAt: [1.6, 2.5, 1.2] };
  }
  if (kind === "inbox") {
    // a receiving hopper: drop files in the funnel, a crusher drum chews them, they leave by the east belt
    b.block(2.4, 1.0, 2.2, accent, [-0.3, 0.3, 0], 0.08, 1.3);
    b.cyl(1.25, 0.75, 1.1, STEEL, [-0.3, 1.3, 0], 4, { rot: [0, Math.PI / 4, 0] });
    b.cyl(1.32, 1.32, 0.1, HAZARD, [-0.3, 2.4, 0], 4, { rot: [0, Math.PI / 4, 0], grade: 0 });
    b.box(1.2, 0.5, 0.8, STEEL_L, [1.3, 0.3, 0]);
    for (const z of [-1, 1]) b.box(0.4, 0.2, 0.06, HAZARD_D, [-0.3, 0.8, z * 1.11]);
    const drum = new Builder(0)
      .cyl(0.25, 0.25, 1.4, STEEL_D, [0, 0, -0.7], 8, { rot: [Math.PI / 2, 0, 0] })
      .box(0.08, 0.6, 0.08, HAZARD, [0, -0.3, 0])
      .build();
    return { body: b.build(), spinner: drum, spinnerAt: [1.3, 1.05, 0], spinAxis: "z", lampAt: [1.7, 0.95, 1.1] };
  }
  if (kind === "job") {
    // a job entry station: a card reader with its hopper of punched cards, and an operator's console
    b.block(2.2, 1.2, 2.0, accent, [-0.5, 0.3, 0], 0.08, 1.3);
    b.cyl(0.75, 0.45, 0.7, STEEL, [-0.9, 1.5, 0], 4, { rot: [0, Math.PI / 4, 0] });
    for (let i = 0; i < 6; i++) b.box(0.62, 0.05, 0.36, i % 2 ? 0xe9dfc4 : 0xd8cca8, [-0.9, 1.75 + i * 0.06, 0]);
    b.box(0.9, 1.2, 0.9, STEEL_L, [-0.6, 0.3, -1.05]);
    b.box(0.7, 0.5, 0.04, 0x0d2a14, [-0.6, 1.0, -0.59]);
    b.box(0.5, 0.06, 0.04, GOOD, [-0.6, 1.1, -0.56], { grade: 0 });
    b.box(1.4, 0.5, 1.2, STEEL_L, [1.1, 0.3, 0]);
    const roller = new Builder(0)
      .cyl(0.18, 0.18, 1.0, STEEL_D, [0, 0, -0.5], 8, { rot: [Math.PI / 2, 0, 0] })
      .box(0.06, 0.4, 0.06, HAZARD, [0, -0.2, 0])
      .build();
    return { body: b.build(), spinner: roller, spinnerAt: [0.45, 1.25, 0], spinAxis: "z", lampAt: [1.6, 0.9, 0.5] };
  }
  // cron: a clock tower
  b.block(1.6, 3.2, 1.6, accent, [-0.6, 0.3, 0], 0.1, 1.3);
  b.cyl(0.05, 1.25, 0.8, STEEL_D, [-0.6, 3.5, 0], 4, { rot: [0, Math.PI / 4, 0] });
  b.cyl(0.62, 0.62, 0.08, 0xe9e4d4, [0.21, 2.6, 0], 20, { rot: [0, 0, Math.PI / 2], grade: 0 });
  b.cyl(0.68, 0.68, 0.06, STEEL_D, [0.19, 2.6, 0], 20, { rot: [0, 0, Math.PI / 2], grade: 0 });
  b.box(1.4, 0.5, 1.2, STEEL_L, [1.1, 0.3, 0]);
  const hand = new Builder(0).box(0.05, 0.5, 0.06, HAZARD_D, [0, 0, 0]).box(0.06, 0.06, 0.06, BAD, [0, 0, 0]).build();
  return { body: b.build(), spinner: hand, spinnerAt: [0.3, 2.6, 0], spinAxis: "x", lampAt: [1.6, 0.9, 0.5] };
}

/** What rides the belts: the shape says the value's type. */
export type TokenShape = "object" | "array" | "string" | "number" | "boolean" | "empty";

export function shapeOf(v: unknown): TokenShape {
  if (v === null || v === undefined) return "empty";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  if (typeof v === "string") return "string";
  if (typeof v === "number") return "number";
  return "boolean";
}

const tokenCache = new Map<TokenShape, THREE.BufferGeometry>();

/** Tokens are white-ish, tinted by their material (call, return, error). */
export function tokenModel(shape: TokenShape): THREE.BufferGeometry {
  const hit = tokenCache.get(shape);
  if (hit) return hit;
  const b = new Builder(0.25);
  const W = 0xf2f2f2;
  const D = 0x9a9a9a;
  switch (shape) {
    case "object": // a crate
      b.block(0.38, 0.32, 0.38, W, [0, 0, 0], 0.03, 1.1);
      b.box(0.4, 0.06, 0.06, D, [0, 0.14, 0]).box(0.06, 0.06, 0.4, D, [0, 0.14, 0]);
      break;
    case "array": // a stack of barrels
      for (const [x, z] of [[-0.1, -0.1], [0.1, -0.1], [-0.1, 0.1], [0.1, 0.1]] as const) b.cyl(0.09, 0.09, 0.3, W, [x, 0, z], 8);
      break;
    case "string": // plates
      for (let i = 0; i < 3; i++) b.box(0.4, 0.05, 0.26, i % 2 ? D : W, [0, i * 0.06, 0]);
      break;
    case "number": // a gear
      b.gear(0.2, 0.1, 6, W, [0, 0, 0]);
      break;
    case "boolean": // a chip
      b.box(0.28, 0.06, 0.28, D, [0, 0, 0]).box(0.16, 0.06, 0.16, W, [0, 0.06, 0]);
      break;
    case "empty": // an empty pallet
      b.box(0.36, 0.05, 0.36, D, [0, 0, 0]).box(0.36, 0.04, 0.08, W, [0, 0.05, 0]);
      break;
  }
  const g = b.build();
  tokenCache.set(shape, g);
  return g;
}
