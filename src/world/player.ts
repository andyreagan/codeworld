import * as THREE from "three";
import type { CallRec, Run } from "../runtime/trace";
import type { Sfx } from "./audio";
import { Path } from "./belts";
import { beltKey } from "./layout";
import { BAD, GOOD, shapeOf } from "./models";
import type { World } from "./world";

/**
 * Replays a recorded run (runtime/trace.ts) on the factory floor, slowly
 * enough to watch: each call's arguments ride the belt from caller to
 * callee, the callee's machine runs (and makes its own calls in order), and
 * its result rides back, or a red error token if it threw. A call the
 * analyzer didn't see coming (no belt) is flown over by drone instead.
 *
 * Runs play concurrently: a timer can fire while a request is still on
 * the belts. A call with many children plays them faster, so loops over
 * hundreds of records stream past instead of taking all day.
 */

interface Mover {
  path: Path;
  obj: THREE.Object3D;
  s: number;
  rate: number;
  done: () => void;
}

interface Waiter {
  left: number;
  done: () => void;
}

export interface PlayerEvents {
  enter?(call: CallRec): void;
  exit?(call: CallRec): void;
  finished?(run: Run): void;
}

export class Player {
  speed = 1;
  follow = false;
  private movers: Mover[] = [];
  private waiters: Waiter[] = [];
  /** The token the camera follows: the newest one moving. */
  lead: THREE.Object3D | null = null;
  active = 0;

  constructor(private world: World, private on: PlayerEvents = {}, private sfx?: Sfx) {}

  /** Tokens on the move right now (the factory hum follows it). */
  get moving(): number {
    return this.movers.length;
  }

  private wait(sec: number): Promise<void> {
    return new Promise((done) => this.waiters.push({ left: sec, done }));
  }

  private travel(path: Path, obj: THREE.Object3D, sec: number): Promise<void> {
    obj.position.copy(path.pts[0]!);
    this.lead = obj;
    return new Promise((done) => this.movers.push({ path, obj, s: 0, rate: path.length / Math.max(sec, 0.05), done }));
  }

  /** The belt from `from` to `to`, or a flight path; `flown` if there's no belt. */
  private pathFor(from: string | null, to: string): { path: Path; flown: boolean } {
    if (from === null) {
      // a trace started at a machine: the work drops in from the sky
      const b = this.world.topOf(to);
      return { path: new Path([b.clone().setY(b.y + 7), b.clone().setY(b.y + 0.3)]), flown: true };
    }
    const p = this.world.paths.get(beltKey(from, to));
    if (p) return { path: p, flown: false };
    // no belt: a drone flight, roof to roof
    const a = this.world.topOf(from);
    const b = this.world.topOf(to);
    const h = 3 + a.distanceTo(b) * 0.15;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      pts.push(a.clone().lerp(b, t).setY(a.y + (b.y - a.y) * t + Math.sin(t * Math.PI) * h + 0.4));
    }
    return { path: new Path(pts), flown: true };
  }

  private hop(path: Path, scale: number): number {
    return (Math.min(1.2, Math.max(0.25, path.length / 14)) * scale) / this.speed;
  }

  async play(run: Run): Promise<void> {
    const dock = run.dock ? this.world.docks.get(run.dock)! : null;
    this.active++;
    if (dock) {
      dock.busy++;
      this.sfx?.dock(dock.spot.trigger.kind, dock.top);
    }
    try {
      if (run.root) await this.call(run.root, run.dock, 1, 0);
      else await this.wait(0.3);
    } finally {
      if (dock) dock.busy--;
      this.active--;
    }
    const ok = run.error === undefined;
    this.sfx?.runDone(ok, dock?.top ?? (run.root ? this.world.topOf(run.root.id) : null));
    if (dock && run.dock) {
      if (!ok) dock.hurt = 1.5;
      this.world.fx.flash(dock.top, ok ? GOOD : BAD);
      this.world.setDockSign(run.dock, ok ? JSON.stringify(run.result ?? null) : `✗ ${run.error}`, ok);
    }
    this.on.finished?.(run);
  }

  private async call(c: CallRec, from: string | null, scale: number, depth: number): Promise<void> {
    const w = this.world;
    const { path, flown } = this.pathFor(from, c.id);
    const t = w.fx.token(shapeOf(c.args[0]), "call");
    if (flown) this.sfx?.drone(path.pts[0]!);
    else this.sfx?.depart(path.pts[0]!);
    await this.travel(path, t, this.hop(path, scale));
    w.fx.drop(t);
    const m = w.machines.get(c.id)!;
    m.busy++;
    m.calls++;
    m.recent.unshift(c);
    if (m.recent.length > 8) m.recent.pop();
    this.on.enter?.(c);
    this.sfx?.machineStart(m.spot.tier, m.top);
    await this.wait((0.22 * scale) / this.speed);
    const n = c.children.length;
    const k = scale * (n > 3 ? Math.max(0.2, 3 / n) : 1);
    for (const child of c.children) await this.call(child, c.id, k, depth + 1);
    await this.wait((0.12 * scale) / this.speed);
    m.busy--;
    if (c.gauge !== undefined) {
      const silo = w.silos.get(m.spot.fn.module);
      if (silo && c.gauge !== silo.value) this.sfx?.gauge(c.gauge > silo.value, silo.at);
      w.setGauge(m.spot.fn.module, c.gauge);
    }
    this.on.exit?.(c);
    let back;
    if (c.error !== undefined) {
      m.hurt = 1.2;
      w.fx.sparks(m.top);
      this.sfx?.error(m.top);
      back = w.fx.token("empty", "error");
    } else {
      back = w.fx.token(shapeOf(c.result), "return");
      this.sfx?.machineDone(depth, m.top);
    }
    const home = path.reversed();
    if (!flown) this.sfx?.depart(home.pts[0]!);
    await this.travel(home, back, this.hop(path, scale) * 0.8);
    w.fx.drop(back);
  }

  update(dt: number): void {
    const v = new THREE.Vector3();
    this.movers = this.movers.filter((m) => {
      m.s += m.rate * dt;
      m.path.at(m.s, m.obj.position);
      // face the way it's going
      m.path.at(m.s + 0.05, v);
      v.y = m.obj.position.y;
      if (v.distanceToSquared(m.obj.position) > 1e-8) m.obj.lookAt(v);
      if (m.s >= m.path.length) {
        m.done();
        return false;
      }
      return true;
    });
    this.waiters = this.waiters.filter((w) => {
      w.left -= dt;
      if (w.left <= 0) {
        w.done();
        return false;
      }
      return true;
    });
  }
}
