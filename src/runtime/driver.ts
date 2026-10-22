import type { CodeGraph, FnNode, Trigger } from "../analyze/types";
import { dockId } from "../world/layout";
import type { CallRec, Run } from "./trace";

/**
 * What the world and the control room poke at. Two kinds:
 * - live (runtime/host.ts): the codebase's real code, loaded and traced;
 * - static (Simulator, below): only a code map, so a run is simulated by
 *   walking the call graph from the entry point, each function's calls in
 *   source order, each path once (no recursion).
 */

export interface Entry {
  dock: string;
  fn: FnNode;
  trigger: Trigger;
}

export interface Driver {
  readonly live: boolean;
  readonly graph: CodeGraph;
  readonly entries: Entry[];
  /** Sample files, keyed by path relative to the codebase (`samples/x.csv`). */
  readonly samples: Record<string, string>;
  request(method: string, path: string, body?: unknown): Run;
  drop(name: string, text: string): Run;
  tick(dock: string): Run;
  /** Start a run at any function (static maps only: live code needs real arguments). */
  traceFrom?(fn: string): Run;
  setTimer(dock: string, on: boolean): void;
  timerOn(dock: string): boolean;
  gauges(): Map<string, number>;
}

export const entriesOf = (graph: CodeGraph): Entry[] =>
  graph.fns.flatMap((fn) => fn.triggers.map((trigger, i) => ({ dock: dockId(fn.id, i), fn, trigger })));

export const globToRe = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");

/** `/orders/:id` against `/orders/1001` -> `{ id: "1001" }`, or null. */
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean);
  const b = path.split("?")[0]!.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith(":")) params[a[i]!.slice(1)] = decodeURIComponent(b[i]!);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

/** Functions worth starting a trace from when nothing is tagged: exported, uncalled, reaching the most. */
export function roots(graph: CodeGraph, n = 8): { fn: FnNode; reach: number }[] {
  const out = new Map<string, string[]>();
  for (const c of graph.calls) (out.get(c.from) ?? out.set(c.from, []).get(c.from)!).push(c.to);
  const called = new Set(graph.calls.map((c) => c.to));
  const reach = (id: string) => {
    const seen = new Set([id]);
    const stack = [id];
    while (stack.length) for (const m of out.get(stack.pop()!) ?? []) if (!seen.has(m)) stack.push(m), seen.add(m);
    return seen.size - 1;
  };
  return graph.fns
    .filter((f) => !called.has(f.id) && (out.get(f.id)?.length ?? 0) > 0)
    .map((fn) => ({ fn, reach: reach(fn.id) }))
    .sort((a, b) => b.reach - a.reach)
    .slice(0, n);
}

export class Simulator implements Driver {
  readonly live = false;
  readonly entries: Entry[];
  private timers = new Map<string, number>();
  private out = new Map<string, string[]>();

  constructor(readonly graph: CodeGraph, readonly samples: Record<string, string> = {}, private onRun: (run: Run) => void) {
    this.entries = entriesOf(graph);
    for (const c of [...graph.calls].sort((a, b) => a.line - b.line)) (this.out.get(c.from) ?? this.out.set(c.from, []).get(c.from)!).push(c.to);
  }

  /** The call tree a run from `fn` could make: every callee in source order, each path once, capped. */
  simulate(fn: string, label: string, dock: string | null): Run {
    let seq = 0;
    let budget = 300;
    const visit = (id: string, parent: number | null, path: Set<string>): CallRec => {
      const rec: CallRec = { seq: ++seq, id, parent, args: [{}], result: {}, children: [] };
      if (path.size < 16)
        for (const to of this.out.get(id) ?? []) {
          if (path.has(to) || budget-- <= 0) continue;
          rec.children.push(visit(to, rec.seq, new Set(path).add(to)));
        }
      return rec;
    };
    const root = visit(fn, null, new Set([fn]));
    const run: Run = { label: `${label} (simulated)`, dock, root, result: { simulated: true, calls: seq }, calls: seq };
    this.onRun(run);
    return run;
  }

  request(method: string, path: string): Run {
    for (const e of this.entries) {
      if (e.trigger.kind !== "route" || e.trigger.method !== method.toUpperCase()) continue;
      if (matchRoute(e.trigger.path, path)) return this.simulate(e.fn.id, `${method.toUpperCase()} ${path}`, e.dock);
    }
    throw new Error(`no route for ${method.toUpperCase()} ${path}`);
  }

  drop(name: string): Run {
    const e = this.entries.find((x) => x.trigger.kind === "inbox" && globToRe(x.trigger.glob).test(name));
    if (!e) throw new Error(`no inbox takes ${name}`);
    return this.simulate(e.fn.id, `file ${name}`, e.dock);
  }

  tick(dock: string): Run {
    const e = this.entries.find((x) => x.dock === dock)!;
    return this.simulate(e.fn.id, `tick ${e.fn.name}`, dock);
  }

  traceFrom(fn: string): Run {
    return this.simulate(fn, `trace ${fn.split("#")[1]}`, null);
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

  gauges(): Map<string, number> {
    return new Map();
  }
}
