import * as THREE from "three";
import type { CodeGraph } from "../analyze/types";
import type { CallRec } from "../runtime/trace";
import { buildBelts, Path, type BeltMeshes } from "./belts";
import { brighten } from "./builder";
import { Fx } from "./fx";
import { layoutWorld, type DockSpot, type MachineSpot, type PadSpot, type WorldLayout } from "./layout";
import { AMBER, BAD, CONCRETE, dockModel, GOOD, machineModel, padModel, siloModel, type DockKind } from "./models";
import { label } from "./textures";

/**
 * The factory: the layout (layout.ts) made solid. Holds every machine,
 * dock, tank and belt, animates them (flywheels spin and chimneys smoke
 * while a function runs; lamps go amber when busy, red on an error) and
 * answers what's under the cursor.
 */

const modelMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.62, metalness: 0.18 });
const lampMats = {
  idle: new THREE.MeshBasicMaterial({ color: brighten(GOOD, 0.45), toneMapped: false }),
  busy: new THREE.MeshBasicMaterial({ color: AMBER, toneMapped: false }),
  error: new THREE.MeshBasicMaterial({ color: BAD, toneMapped: false })
};
const lampGeo = new THREE.SphereGeometry(0.11, 8, 6);
const ACCENT: Record<DockKind, number> = { route: 0x2f8f6a, inbox: 0x7a5aa8, cron: 0xa8453a };

/** Pad paint per top-level directory, so a package's modules read as one district. */
const DISTRICT = [0x8d8a82, 0x8a8f96, 0x958a7c, 0x86917f, 0x93879a, 0x8c9490];
function districtTint(dir: string, all: string[]): number {
  const top = dir.split("/")[0] ?? "";
  if (!top) return CONCRETE;
  return DISTRICT[(all.indexOf(top) % (DISTRICT.length - 1)) + 1]!;
}

interface Lit {
  lamp: THREE.Mesh;
  busy: number;
  /** Seconds left of the red error lamp. */
  hurt: number;
}

export interface Machine extends Lit {
  spot: MachineSpot;
  root: THREE.Group;
  gear: THREE.Mesh;
  gearSpin: number;
  smokeAt: THREE.Vector3;
  top: THREE.Vector3;
  name: THREE.Sprite;
  smokeClock: number;
  /** The last few calls it made, newest first. */
  recent: CallRec[];
  calls: number;
}

export interface Dock extends Lit {
  spot: DockSpot;
  root: THREE.Group;
  spinner: THREE.Mesh;
  axis: "x" | "y" | "z";
  top: THREE.Vector3;
  /** The last response, shown on its sign. */
  sign: THREE.Sprite | null;
}

export interface Silo {
  pad: PadSpot;
  fill: THREE.Mesh;
  height: number;
  value: number;
  shown: number;
  max: number;
  sign: THREE.Sprite | null;
  at: THREE.Vector3;
}

export type Pick = { kind: "machine"; id: string } | { kind: "dock"; id: string } | { kind: "pad"; id: string };

export class World {
  readonly group = new THREE.Group();
  readonly layout: WorldLayout;
  readonly machines = new Map<string, Machine>();
  readonly docks = new Map<string, Dock>();
  readonly silos = new Map<string, Silo>();
  readonly paths = new Map<string, Path>();
  readonly fx: Fx;
  private belts: BeltMeshes;
  private pickables: THREE.Object3D[] = [];
  private padLabels: THREE.Sprite[] = [];
  private selection: THREE.Mesh;
  private t = 0;

  constructor(readonly graph: CodeGraph, scene: THREE.Scene) {
    this.layout = layoutWorld(graph);
    scene.add(this.group);
    this.fx = new Fx(this.group);
    const dirs = [...new Set(graph.modules.map((m) => m.dir.split("/")[0] ?? "").filter(Boolean))].sort();

    for (const pad of this.layout.pads) {
      const mesh = new THREE.Mesh(padModel(pad.w, pad.d, districtTint(pad.mod.dir, dirs)), modelMat);
      mesh.position.set(pad.x, 0, pad.z);
      mesh.receiveShadow = true;
      mesh.userData.pick = { kind: "pad", id: pad.mod.id } satisfies Pick;
      this.group.add(mesh);
      this.pickables.push(mesh);
      const sign = label(pad.mod.id + (pad.mod.store ? "  ◆ store" : ""), {
        size: Math.min(1.1, Math.max(0.6, pad.w / 9)), bg: "rgba(24,22,19,0.82)", border: "#e2b33a", color: "#f6eedb"
      });
      sign.position.set(pad.x + pad.w / 2, 0.25, pad.z + 0.2);
      this.group.add(sign);
      this.padLabels.push(sign);
      if (pad.silo) this.addSilo(pad);
    }
    for (const spot of this.layout.machines.values()) this.addMachine(spot);
    for (const spot of this.layout.docks) this.addDock(spot);
    for (const [k, b] of this.layout.belts) this.paths.set(k, Path.of(b.pts));
    this.belts = buildBelts(this.layout.belts.values());
    this.group.add(this.belts.surface, this.belts.frame);

    this.selection = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1, 4, 1).rotateX(-Math.PI / 2).rotateY(Math.PI / 4),
      new THREE.MeshBasicMaterial({ color: 0xffd34a, toneMapped: false, transparent: true, opacity: 0.9 })
    );
    this.selection.visible = false;
    this.group.add(this.selection);
  }

  private addMachine(spot: MachineSpot): void {
    const m = machineModel(spot.size, spot.tier, spot.fn.exported);
    const root = new THREE.Group();
    root.position.set(spot.x, 0, spot.z);
    const body = new THREE.Mesh(m.body, modelMat);
    body.castShadow = body.receiveShadow = true;
    body.userData.pick = { kind: "machine", id: spot.fn.id } satisfies Pick;
    const gear = new THREE.Mesh(m.gear, modelMat);
    gear.position.set(...m.gearAt);
    gear.castShadow = true;
    const lamp = new THREE.Mesh(lampGeo, lampMats.idle);
    lamp.position.set(...m.lampAt);
    const name = label(spot.fn.name + (spot.fn.exported ? "" : " ·"), { size: 0.34, bg: "rgba(20,20,18,0.72)", color: "#f1e9d2" });
    name.position.set(0, m.height + 0.55, 0);
    root.add(body, gear, lamp, name);
    this.group.add(root);
    this.pickables.push(body);
    this.machines.set(spot.fn.id, {
      spot, root, gear, lamp, name, busy: 0, hurt: 0, gearSpin: 0, smokeClock: 0, recent: [], calls: 0,
      smokeAt: new THREE.Vector3(...m.smokeAt).add(root.position),
      top: new THREE.Vector3(spot.x, m.height, spot.z)
    });
  }

  private addDock(spot: DockSpot): void {
    const kind = spot.trigger.kind;
    const m = dockModel(kind, ACCENT[kind]);
    const root = new THREE.Group();
    root.position.set(spot.x, 0, spot.z);
    const body = new THREE.Mesh(m.body, modelMat);
    body.castShadow = body.receiveShadow = true;
    body.userData.pick = { kind: "dock", id: spot.id } satisfies Pick;
    const spinner = new THREE.Mesh(m.spinner, modelMat);
    spinner.position.set(...m.spinnerAt);
    spinner.castShadow = true;
    const lamp = new THREE.Mesh(lampGeo, lampMats.idle);
    lamp.position.set(...m.lampAt);
    lamp.scale.setScalar(1.6);
    const t = spot.trigger;
    const text = t.kind === "route" ? `${t.method} ${t.path}` : t.kind === "inbox" ? `inbox ${t.glob}` : `every ${t.every}s`;
    const sign = label(text, { size: 0.5, bg: "rgba(16,18,20,0.85)", border: "#" + ACCENT[kind].toString(16).padStart(6, "0"), color: "#ffffff" });
    sign.position.set(0, 4.3, 0);
    root.add(body, spinner, lamp, sign);
    this.group.add(root);
    this.pickables.push(body);
    this.docks.set(spot.id, { spot, root, spinner, axis: m.spinAxis, lamp, busy: 0, hurt: 0, sign: null, top: new THREE.Vector3(spot.x, 2.6, spot.z) });
  }

  private addSilo(pad: PadSpot): void {
    const s = pad.silo!;
    const m = siloModel();
    const body = new THREE.Mesh(m.body, modelMat);
    body.position.set(s.x, 0, s.z);
    body.castShadow = body.receiveShadow = true;
    body.userData.pick = { kind: "pad", id: pad.mod.id } satisfies Pick;
    this.pickables.push(body);
    const fill = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 1, 0.18).translate(0, 0.5, 0),
      new THREE.MeshBasicMaterial({ color: 0x4fe0d0, toneMapped: false })
    );
    fill.position.set(s.x + m.gaugeAt[0], m.gaugeAt[1], s.z + m.gaugeAt[2]);
    fill.scale.y = 0.001;
    this.group.add(body, fill);
    this.silos.set(pad.mod.id, { pad, fill, height: m.gaugeH, value: 0, shown: 0, max: 8, sign: null, at: new THREE.Vector3(s.x, m.height + 0.2, s.z) });
  }

  /** A store's `count()`: fills its gauge and updates its sign. */
  setGauge(module: string, value: number): void {
    const s = this.silos.get(module);
    if (!s) return;
    s.value = value;
    s.max = Math.max(s.max, value * 1.25);
    if (s.sign) {
      this.group.remove(s.sign);
      s.sign.material.map?.dispose();
      s.sign.material.dispose();
    }
    s.sign = label(String(value), { size: 0.55, bg: "rgba(10,40,40,0.85)", border: "#4fe0d0", color: "#c8fff8" });
    s.sign.position.copy(s.at);
    this.group.add(s.sign);
  }

  /** The response a dock got back, on a sign above it. */
  setDockSign(id: string, text: string, ok: boolean): void {
    const d = this.docks.get(id)!;
    if (d.sign) {
      d.root.remove(d.sign);
      d.sign.material.map?.dispose();
      d.sign.material.dispose();
    }
    const short = text.length > 46 ? `${text.slice(0, 45)}…` : text;
    d.sign = label(short, { size: 0.36, bg: ok ? "rgba(14,40,24,0.85)" : "rgba(60,14,10,0.85)", color: ok ? "#bfffd2" : "#ffc4bc" });
    d.sign.position.set(0, 5.1, 0);
    d.root.add(d.sign);
  }

  /** Where a call's token leaves from or arrives at: a machine or dock's roof. */
  topOf(id: string): THREE.Vector3 {
    return (this.machines.get(id) ?? this.docks.get(id))!.top;
  }

  pick(ray: THREE.Raycaster): Pick | null {
    const hit = ray.intersectObjects(this.pickables, false)[0];
    return (hit?.object.userData.pick as Pick | undefined) ?? null;
  }

  select(p: Pick | null): void {
    const sel = this.selection;
    sel.visible = false;
    if (!p) return;
    if (p.kind === "machine") {
      const m = this.machines.get(p.id)!;
      sel.scale.setScalar(m.spot.size * 0.78);
      sel.position.set(m.spot.x, 0.13, m.spot.z);
    } else if (p.kind === "dock") {
      const d = this.docks.get(p.id)!;
      sel.scale.setScalar(3);
      sel.position.set(d.spot.x, 0.33, d.spot.z);
    } else {
      const pad = this.layout.pads.find((x) => x.mod.id === p.id)!;
      sel.scale.set(pad.w * 0.72, 1, pad.d * 0.72);
      sel.position.set(pad.x + pad.w / 2, 0.13, pad.z + pad.d / 2);
    }
    sel.visible = true;
  }

  update(dt: number, camDist: number): void {
    this.t += dt;
    this.belts.texture.offset.x -= dt * 1.4;
    // machine name tags only when close enough to read them
    const tags = camDist < 60;
    for (const m of this.machines.values()) {
      m.name.visible = tags;
      const want = m.busy > 0 ? 9 : 0.25;
      m.gearSpin += (want - m.gearSpin) * Math.min(1, dt * 5);
      m.gear.rotation.y += m.gearSpin * dt;
      this.lamp(m, dt);
      if (m.busy > 0) {
        m.smokeClock -= dt;
        if (m.smokeClock <= 0) {
          m.smokeClock = 0.12;
          this.fx.smoke(m.smokeAt, 0.4);
        }
        m.root.scale.y = 1 + Math.sin(this.t * 30) * 0.015;
      } else m.root.scale.y = 1;
    }
    for (const d of this.docks.values()) {
      d.spinner.rotation[d.axis] += (d.busy > 0 ? 6 : d.axis === "x" ? 0.4 : 0.8) * dt;
      this.lamp(d, dt);
    }
    for (const s of this.silos.values()) {
      s.shown += (s.value - s.shown) * Math.min(1, dt * 4);
      s.fill.scale.y = Math.max(0.001, (s.shown / s.max) * s.height);
    }
    for (const l of this.padLabels) l.visible = camDist < 160;
    this.fx.update(dt);
  }

  private lamp(l: Lit, dt: number): void {
    l.hurt = Math.max(0, l.hurt - dt);
    l.lamp.material = l.hurt > 0 ? lampMats.error : l.busy > 0 ? lampMats.busy : lampMats.idle;
  }
}
