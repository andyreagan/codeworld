import * as THREE from "three";
import { examples } from "virtual:codeworld";
import type { CodeGraph } from "./analyze/types";
import { Simulator, type Driver } from "./runtime/driver";
import { Host } from "./runtime/host";
import type { Run } from "./runtime/trace";
import { keepMap, keptMap } from "./ui/keep";
import { readMap, Ui } from "./ui/ui";
import "./ui/style.css";
import { Sfx } from "./world/audio";
import { Player } from "./world/player";
import { Stage } from "./world/stage";
import { World, type Pick } from "./world/world";

/**
 * Boot. Codebase -> code map -> world: the world is drawn from a code map
 * (analyze/types.ts), either
 * - an example's (`?example=`), analyzed at build time, whose code is also
 *   loaded and run for real (live); or
 * - a code map file (`?map=<url>`, or `?map=local` for the last one opened
 *   or dropped on the page), from `npm run codemap`: nothing runs, runs are
 *   simulated from the call graph (static).
 * Then wire the outside world in: the control room, drag-and-drop,
 * `window.codeworld` and `postMessage`.
 */

const q = new URLSearchParams(location.search);
const mapAt = q.get("map");
const example = mapAt ? null : (examples.find((e) => e.graph.name === q.get("example")) ?? examples[0]!);
let graph: CodeGraph;
try {
  graph = example ? example.graph : readMap(mapAt === "local" ? await keptMap() : await (await fetch(mapAt!)).text());
} catch (err) {
  document.body.textContent = `Couldn't open the code map ${mapAt}: ${err instanceof Error ? err.message : err}`;
  throw err;
}
document.title = `${graph.title} · Codeworld`;

const stage = new Stage(document.getElementById("world")!);
if (innerWidth > 900) stage.setInset(175);
const world = new World(graph, stage.scene);
stage.ground(world.layout.bounds);
stage.frame(world.layout.bounds);

// sounds pan with where they happen on screen, and fade with distance from the camera's focus
const sfx = new Sfx();
const ndc = new THREE.Vector3();
sfx.locate = (p) => {
  ndc.copy(p).project(stage.camera);
  const focus = stage.camera.position.distanceTo(stage.controls.target);
  const off = Math.max(0, Math.abs(ndc.x) - 1.1) + Math.max(0, Math.abs(ndc.y) - 1.1);
  const near = Math.min(1, (focus * 0.9) / Math.max(1, stage.camera.position.distanceTo(p)));
  return { pan: Math.max(-1, Math.min(1, ndc.x * 0.8)), level: ndc.z > 1 ? 0 : near * Math.max(0, 1 - off) };
};

let ui: Ui;
const player = new Player(
  world,
  {
    enter: (c) => ui.enter(c),
    finished: (r) => ui.finished(r)
  },
  sfx
);
const onRun = (run: Run) => {
  ui.started(run);
  void player.play(run);
};
let host: Driver;
if (example?.live) {
  const live = new Host(example, onRun);
  await live.load();
  host = live;
} else host = new Simulator(graph, example?.samples ?? {}, onRun);
for (const [m, v] of host.gauges()) world.setGauge(m, v);

const placeOf = (p: Pick): THREE.Vector3 => {
  if (p.kind === "machine") return world.machines.get(p.id)!.top.clone().setY(0);
  if (p.kind === "dock") return world.docks.get(p.id)!.top.clone().setY(0);
  const pad = world.layout.pads.find((x) => x.mod.id === p.id)!;
  return new THREE.Vector3(pad.x + pad.w / 2, 0, pad.z + pad.d / 2);
};

const select = (p: Pick | null, fly: boolean) => {
  world.select(p);
  ui.show(p);
  if (p && fly) stage.focus(placeOf(p), p.kind === "pad" ? 36 : 24);
};

ui = new Ui({
  examples,
  driver: host,
  world,
  openMap: (g) => {
    void keepMap(JSON.stringify(g)).then(() => (location.href = `${location.pathname}?map=local`));
  },
  focus: (p) => select(p, true),
  setSpeed: (x) => (player.speed = x),
  setFollow: (on) => (player.follow = on),
  sfx,
  frameAll: () => stage.frame(world.layout.bounds)
});

// click to inspect (a drag is a pan, not a click)
const canvas = stage.renderer.domElement;
let down: [number, number] | null = null;
canvas.addEventListener("pointerdown", (e) => (down = [e.clientX, e.clientY]));
canvas.addEventListener("pointerup", (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5 || e.button !== 0) return;
  const r = canvas.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), stage.camera);
  select(world.pick(ray), false);
});
addEventListener("keydown", (e) => {
  if (e.key === "Escape") select(null, false);
});

// scripted access: window.codeworld.request("POST", "/orders", {...}), or postMessage({ codeworld: "request", ... })
const api = {
  graph,
  samples: host.samples,
  request: (method: string, path: string, body?: unknown) => host.request(method, path, body),
  drop: (name: string, text: string) => host.drop(name, text),
  tick: (fn: string) => host.tick(host.entries.find((e) => e.fn.name === fn && e.trigger.kind === "cron")!.dock),
  /** Submit a batch job by name. */
  submit: (job: string) => host.tick(host.entries.find((e) => e.trigger.kind === "job" && e.trigger.name === job)!.dock),
  setSpeed: (x: number) => (player.speed = x),
  audioState: () => sfx.state,
  /** Static maps: start a simulated run at any function. */
  trace: (fn: string) => host.traceFrom?.(fn),
  /** Select something and fly to it: `select("machine", "domain/pricing.js#priceOrder")`. */
  select: (kind: Pick["kind"], id: string) => select({ kind, id } as Pick, true),
  /** Resolves once nothing is on the belts. */
  idle: () => new Promise<void>((done) => {
    const check = () => (player.active === 0 ? done() : setTimeout(check, 100));
    check();
  })
};
(window as unknown as { codeworld: typeof api }).codeworld = api;
addEventListener("message", (e) => {
  const m = e.data as { codeworld?: string; method?: string; path?: string; body?: unknown; name?: string; text?: string };
  try {
    if (m?.codeworld === "request") api.request(m.method ?? "GET", m.path ?? "/", m.body);
    else if (m?.codeworld === "drop") api.drop(m.name ?? "file", m.text ?? "");
  } catch (err) {
    ui.toast(String(err instanceof Error ? err.message : err), true);
  }
});

const clock = new THREE.Clock();
stage.renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  player.update(dt);
  sfx.setActivity(player.moving);
  if (player.follow && player.lead?.parent) stage.follow(player.lead.getWorldPosition(new THREE.Vector3()));
  world.update(dt, stage.camera.position.distanceTo(stage.controls.target));
  stage.update(dt);
});
