import * as THREE from "three";
import { Builder } from "./builder";
import type { Belt, P3 } from "./layout";
import { HAZARD_D, STEEL, STEEL_D, STEEL_L } from "./models";
import { beltTexture } from "./textures";

/**
 * Every belt in the world as two meshes: the moving surfaces (one geometry,
 * UVs running along each belt's length so the shared chevron texture
 * scrolls the way work flows) and the steelwork (frames, lift shafts,
 * gantry legs) in vertex colours.
 */

const WIDTH = 0.42;
const UV_PER_TILE = 1.6;

/** A polyline you can walk by distance. */
export class Path {
  readonly cum: number[] = [0];
  readonly length: number;
  constructor(readonly pts: THREE.Vector3[]) {
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1]! + pts[i]!.distanceTo(pts[i - 1]!));
    this.length = this.cum[this.cum.length - 1]!;
  }

  static of(pts: P3[]): Path {
    return new Path(pts.map((p) => new THREE.Vector3(...p)));
  }

  /** The point `s` along it (clamped), into `out`. */
  at(s: number, out: THREE.Vector3): THREE.Vector3 {
    const d = Math.max(0, Math.min(this.length, s));
    let i = 1;
    while (i < this.cum.length - 1 && this.cum[i]! < d) i++;
    const a = this.pts[i - 1]!;
    const b = this.pts[i]!;
    const seg = this.cum[i]! - this.cum[i - 1]!;
    return out.copy(a).lerp(b, seg > 0 ? (d - this.cum[i - 1]!) / seg : 0);
  }

  reversed(): Path {
    return new Path([...this.pts].reverse());
  }
}

export interface BeltMeshes {
  surface: THREE.Mesh;
  frame: THREE.Mesh;
  texture: THREE.Texture;
}

export function buildBelts(belts: Iterable<Belt>): BeltMeshes {
  const pos: number[] = [];
  const uv: number[] = [];
  const nor: number[] = [];
  const frame = new Builder(0.3);
  let any = false;
  // belts merged on a trunk share stretches of track: draw each stretch once
  const drawn = new Set<string>();
  for (const belt of belts) {
    let s = 0;
    for (let i = 1; i < belt.pts.length; i++) {
      const [ax, ay, az] = belt.pts[i - 1]!;
      const [bx, by, bz] = belt.pts[i]!;
      const len = Math.hypot(bx - ax, by - ay, bz - az);
      const k = [[ax, ay, az], [bx, by, bz]].map((p) => p.map((v) => v.toFixed(2)).join(",")).sort().join("|");
      if (drawn.has(k)) {
        s += len;
        continue;
      }
      drawn.add(k);
      if (Math.abs(by - ay) > 1e-6) {
        // a lift shaft: four corner rails, the token rides up the middle
        const lo = Math.min(ay, by);
        for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const)
          frame.box(0.06, len + 0.1, 0.06, STEEL_L, [ax + dx * 0.26, lo - 0.05, az + dz * 0.26]);
        frame.box(0.6, 0.06, 0.6, STEEL_D, [ax, Math.max(ay, by) - 0.1, az]);
        s += len;
        continue;
      }
      any = true;
      const dx = (bx - ax) / len;
      const dz = (bz - az) / len;
      // left of travel, in xz
      const lx = dz * (WIDTH / 2);
      const lz = -dx * (WIDTH / 2);
      const y = ay + 0.025;
      const u0 = s * UV_PER_TILE;
      const u1 = (s + len) * UV_PER_TILE;
      const quad = [
        [ax + lx, az + lz, u0, 1], [ax - lx, az - lz, u0, 0], [bx - lx, bz - lz, u1, 0],
        [ax + lx, az + lz, u0, 1], [bx - lx, bz - lz, u1, 0], [bx + lx, bz + lz, u1, 1]
      ];
      // (left = (dz, -dx), so these wind counter-clockwise seen from above: facing up)
      for (const [x, z, u, v] of quad) {
        pos.push(x!, y, z!);
        uv.push(u!, v!);
        nor.push(0, 1, 0);
      }
      // frame: the belt's bed and side rails, a little longer so corners close up
      const cx = (ax + bx) / 2;
      const cz = (az + bz) / 2;
      const along = len + WIDTH + 0.08;
      const [w, d] = Math.abs(dx) > 0.5 ? [along, WIDTH + 0.12] : [WIDTH + 0.12, along];
      const bed = belt.elevated && ay > 1 ? 0.18 : 0.12;
      frame.box(w, bed, d, STEEL, [cx, ay - bed + 0.02, cz]);
      const [rw, rd] = Math.abs(dx) > 0.5 ? [along, 0.05] : [0.05, along];
      for (const side of [-1, 1]) frame.box(rw, 0.07, rd, STEEL_L, [cx + side * lx * 1.25, ay, cz + side * lz * 1.25]);
      // gantry legs under raised runs, every few tiles and at both ends
      if (ay > 1) {
        const n = Math.max(1, Math.round(len / 4));
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          const px = ax + (bx - ax) * t;
          const pz = az + (bz - az) * t;
          frame.box(0.12, ay - bed, 0.12, HAZARD_D, [px, 0, pz]);
          frame.box(0.34, 0.06, 0.34, STEEL_D, [px, 0, pz]);
        }
      }
      s += len;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  const texture = beltTexture();
  const surface = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85, metalness: 0.1 }));
  surface.receiveShadow = true;
  const fm = new THREE.Mesh(
    any ? frame.build() : new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.7, metalness: 0.25 })
  );
  fm.castShadow = true;
  fm.receiveShadow = true;
  return { surface, frame: fm, texture };
}
