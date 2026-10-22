import type { Example } from "virtual:codeworld";
import type { CodeGraph, FnNode } from "../analyze/types";
import { entriesOf, globToRe, matchRoute, type Driver, type Entry } from "./driver";
import { Tracer, type Run } from "./trace";

/**
 * Runs an example codebase for real, in the page: loads its (instrumented)
 * modules, and turns the outside world's pokes into calls on its entry
 * points: an HTTP-style request to a `@route`, a file to an `@inbox`, a
 * tick to a `@cron`. Each poke is recorded as a Run for the world to replay.
 */

type Mod = Record<string, unknown>;

export class Host implements Driver {
  readonly live = true;
  readonly tracer = new Tracer();
  readonly graph: CodeGraph;
  readonly entries: Entry[];
  readonly samples: Record<string, string>;
  private mods = new Map<string, Mod>();
  private timers = new Map<string, number>();

  constructor(readonly example: Example, private onRun: (run: Run) => void) {
    this.graph = example.graph;
    this.samples = example.samples;
    this.entries = entriesOf(this.graph);
  }

  async load(): Promise<void> {
    (globalThis as { __cw?: Tracer }).__cw = this.tracer;
    for (const m of this.graph.modules) if (m.store) this.tracer.stores.add(m.id);
    this.tracer.gauge = (module) => {
      const count = this.mods.get(module)?.count;
      return typeof count === "function" ? Number(count()) : undefined;
    };
    for (const [path, load] of Object.entries(this.example.modules)) this.mods.set(path, await load());
    for (const e of this.entries)
      if (!e.fn.exported) throw new Error(`${e.fn.id} is an entry point (@${e.trigger.kind}) but isn't exported`);
  }

  /** Every store's current `count()`. */
  gauges(): Map<string, number> {
    const out = new Map<string, number>();
    for (const id of this.tracer.stores) {
      const v = this.tracer.untraced(() => this.tracer.gauge(id));
      if (v !== undefined) out.set(id, v);
    }
    return out;
  }

  private handler(fn: FnNode): (...a: unknown[]) => unknown {
    const f = this.mods.get(fn.module)?.[fn.name];
    if (typeof f !== "function") throw new Error(`${fn.id} didn't load`);
    return f as (...a: unknown[]) => unknown;
  }

  private fire(e: Entry, label: string, args: unknown[]): Run {
    const run = this.tracer.record(label, e.dock, () => this.handler(e.fn)(...args));
    this.onRun(run);
    return run;
  }

  /** An HTTP-style request: routed to the matching `@route` handler as `(body, params)`. */
  request(method: string, path: string, body?: unknown): Run {
    for (const e of this.entries) {
      if (e.trigger.kind !== "route" || e.trigger.method !== method.toUpperCase()) continue;
      const params = matchRoute(e.trigger.path, path);
      if (params) return this.fire(e, `${method.toUpperCase()} ${path}`, [body ?? {}, params]);
    }
    throw new Error(`no route for ${method.toUpperCase()} ${path}`);
  }

  /** A file arriving: handed to the first `@inbox` whose glob matches its name, as `(name, text)`. */
  drop(name: string, text: string): Run {
    const e = this.entries.find((x) => x.trigger.kind === "inbox" && globToRe(x.trigger.glob).test(name));
    if (!e) throw new Error(`no inbox takes ${name}`);
    return this.fire(e, `file ${name}`, [name, text]);
  }

  tick(dock: string): Run {
    const e = this.entries.find((x) => x.dock === dock)!;
    return this.fire(e, `tick ${e.fn.name}`, []);
  }

  setTimer(dock: string, on: boolean): void {
    const e = this.entries.find((x) => x.dock === dock);
    if (!e || e.trigger.kind !== "cron") return;
    clearInterval(this.timers.get(dock));
    this.timers.delete(dock);
    if (on) this.timers.set(dock, window.setInterval(() => this.tick(dock), e.trigger.every * 1000));
  }

  timerOn(dock: string): boolean {
    return this.timers.has(dock);
  }
}
