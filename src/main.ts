import * as THREE from "three";
import { examples } from "virtual:codeworld";
import { Host } from "./runtime/host";
import type { Run } from "./runtime/trace";
import { Ui } from "./ui/ui";
import "./ui/style.css";
import { Player } from "./world/player";
import { Stage } from "./world/stage";
import { World, type Pick } from "./world/world";

/**
 * Boot: pick the example (`?example=`), build its world, load and run its
 * code, and wire the outside world in: the control room, drag-and-drop,
 * `window.codeworld` and `postMessage`.
 */

const want = new URLSearchParams(location.search).get("example");
const example = examples.find((e) => e.graph.name === want) ?? examples[0]!;
document.title = `${example.graph.title} · Codeworld`;

const stage = new Stage(document.getElementById("world")!);
if (innerWidth > 900) stage.setInset(175);
const world = new World(example.graph, stage.scene);
stage.ground(world.layout.bounds);
stage.frame(world.layout.bounds);

let ui: Ui;
const player = new Player(world, {
  enter: (c) => ui.enter(c),
  finished: (r) => ui.finished(r)
});
const host = new Host(example, (run: Run) => {
  ui.started(run);
  void player.play(run);
});
await host.load();
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
  example,
  host,
  world,
  focus: (p) => select(p, true),
  setSpeed: (x) => (player.speed = x),
  setFollow: (on) => (player.follow = on),
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
  graph: example.graph,
  samples: example.samples,
  request: (method: string, path: string, body?: unknown) => host.request(method, path, body),
  drop: (name: string, text: string) => host.drop(name, text),
  tick: (fn: string) => host.tick(host.entries.find((e) => e.fn.name === fn && e.trigger.kind === "cron")!.dock),
  setSpeed: (x: number) => (player.speed = x),
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
  if (player.follow && player.lead?.parent) stage.follow(player.lead.getWorldPosition(new THREE.Vector3()));
  world.update(dt, stage.camera.position.distanceTo(stage.controls.target));
  stage.update(dt);
});
