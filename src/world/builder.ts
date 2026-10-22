import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Low-poly model construction, after battledrones' ModelBuilder: place
 * coloured primitives, then merge them into one vertex-coloured geometry, so
 * a whole machine is a draw call or two. Each primitive is shaded darker
 * toward its own base (`grade`), so stacked parts separate and everything
 * reads lit from above even where the shadows don't reach.
 */

export type V3 = [number, number, number];

export interface PartOpts {
  rot?: V3;
  grade?: number;
}

const tmp = new THREE.Color();

export class Builder {
  private parts: THREE.BufferGeometry[] = [];
  constructor(private grade = 0.3) {}

  add(g: THREE.BufferGeometry, color: number, at: V3, o: PartOpts = {}): this {
    let geo = g.index ? g.toNonIndexed() : g;
    geo.deleteAttribute("uv");
    geo.computeBoundingBox();
    const lo = geo.boundingBox!.min.y;
    const hi = geo.boundingBox!.max.y;
    const pos = geo.getAttribute("position");
    const col = new Float32Array(pos.count * 3);
    const grade = o.grade ?? this.grade;
    for (let i = 0; i < pos.count; i++) {
      const k = hi > lo ? (pos.getY(i) - lo) / (hi - lo) : 1;
      tmp.setHex(color).multiplyScalar(1 - grade * (1 - k));
      col.set([tmp.r, tmp.g, tmp.b], i * 3);
    }
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    if (o.rot) geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...o.rot)));
    geo.translate(...at);
    this.parts.push(geo);
    return this;
  }

  /** A box with its base at `at[1]`. */
  box(w: number, h: number, d: number, color: number, at: V3, o?: PartOpts): this {
    return this.add(new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), color, at, o);
  }

  /** A cylinder (or cone, or prism with few `seg`) with its base at `at[1]`. */
  cyl(rTop: number, rBot: number, h: number, color: number, at: V3, seg = 12, o?: PartOpts): this {
    return this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg).translate(0, h / 2, 0), color, at, o);
  }

  /** A box whose top edges are chamfered and lit: the crisp highlight of a painted block. */
  block(w: number, h: number, d: number, color: number, at: V3, bevel = 0.08, edge = 1.25): this {
    const b = Math.min(bevel, w / 3, d / 3, h / 3);
    this.box(w, h - b, d, color, at);
    this.add(frustum(w, d, w - 2 * b, d - 2 * b, b), brighten(color, edge), [at[0], at[1] + h - b, at[2]], { grade: 0 });
    return this;
  }

  /** A flat gear: `teeth` teeth round a disc of radius `r`, `t` thick, lying in the xz plane. */
  gear(r: number, t: number, teeth: number, color: number, at: V3, o?: PartOpts): this {
    const s = new THREE.Shape();
    const n = teeth * 4;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = i % 4 < 2 ? r : r * 0.78;
      if (i === 0) s.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      else s.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    const hole = new THREE.Path();
    hole.absarc(0, 0, r * 0.25, 0, Math.PI * 2, true);
    s.holes.push(hole);
    const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false, curveSegments: 4 }).rotateX(-Math.PI / 2);
    return this.add(g, color, at, { grade: 0.15, ...o });
  }

  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.parts, false)!;
    g.computeVertexNormals();
    g.computeBoundingSphere();
    for (const p of this.parts) p.dispose();
    this.parts = [];
    return g;
  }
}

/** A truncated pyramid, base `w`x`d` at y=0, top `tw`x`td` at y=h. */
function frustum(w: number, d: number, tw: number, td: number, h: number): THREE.BufferGeometry {
  const b = [[-w / 2, 0, -d / 2], [w / 2, 0, -d / 2], [w / 2, 0, d / 2], [-w / 2, 0, d / 2]];
  const t = [[-tw / 2, h, -td / 2], [tw / 2, h, -td / 2], [tw / 2, h, td / 2], [-tw / 2, h, td / 2]];
  const pos: number[] = [];
  const quad = (a: number[], b2: number[], c: number[], d2: number[]) => pos.push(...a, ...b2, ...c, ...a, ...c, ...d2);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(b[j]!, b[i]!, t[i]!, t[j]!);
  }
  quad(t[0]!, t[3]!, t[2]!, t[1]!);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export function brighten(hex: number, k: number): number {
  return tmp.setHex(hex).multiplyScalar(k).getHex();
}
