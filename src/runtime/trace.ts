/**
 * The tracer the instrumented code calls into (`globalThis.__cw.wrap`, see
 * analyze/js.ts). It records every call to a function the analyzer knows,
 * with its parent, a JSON-safe snapshot of its arguments and its result or
 * error, as a run: everything one trigger set off. Runs are recorded at
 * full speed and replayed slowly by the world (world/player.ts).
 *
 * Parents come from the call stack, so this is exact for synchronous code;
 * an async function's calls after its first `await` would be orphaned.
 */

export interface CallRec {
  seq: number;
  id: string;
  parent: number | null;
  args: unknown[];
  result?: unknown;
  error?: string;
  /** For calls into a store module: its `count()` once the call returned. */
  gauge?: number;
  children: CallRec[];
}

export interface Run {
  label: string;
  /** The trigger that started it: a dock id (see world/layout.ts). */
  dock: string;
  root: CallRec | null;
  result?: unknown;
  error?: string;
  calls: number;
}

type Fn = (...args: unknown[]) => unknown;

/** A JSON-safe, size-capped copy of a value, for the inspector and the token shapes. */
export function snapshot(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return v.length > 400 ? `${v.slice(0, 400)}…` : v;
  if (typeof v === "function") return `ƒ ${v.name || "anonymous"}`;
  if (depth > 4) return "…";
  if (v instanceof Map) return { "<Map>": snapshot(Object.fromEntries([...v].slice(0, 30)), depth + 1) };
  if (v instanceof Set) return { "<Set>": snapshot([...v].slice(0, 30), depth + 1) };
  if (v instanceof Error) return { error: v.message };
  if (Array.isArray(v)) {
    const out = v.slice(0, 30).map((x) => snapshot(x, depth + 1));
    if (v.length > 30) out.push(`… ${v.length - 30} more`);
    return out;
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as object).slice(0, 40)) out[k] = snapshot(x, depth + 1);
    return out;
  }
  return String(v);
}

export class Tracer {
  private seq = 0;
  private stack: CallRec[] = [];
  private quiet = 0;
  private current: CallRec[] | null = null;
  /** Gauges a store module after one of its calls returns (set by the runtime). */
  gauge: (module: string) => number | undefined = () => undefined;
  stores = new Set<string>();

  wrap(id: string, fn: Fn): Fn {
    const self = this;
    const module = id.slice(0, id.indexOf("#"));
    const traced = function (this: unknown, ...args: unknown[]) {
      if (self.quiet > 0 || !self.current) return fn.apply(this, args);
      const parent = self.stack[self.stack.length - 1];
      const rec: CallRec = { seq: ++self.seq, id, parent: parent?.seq ?? null, args: args.map((a) => snapshot(a)), children: [] };
      (parent ? parent.children : self.current).push(rec);
      self.stack.push(rec);
      try {
        const r = fn.apply(this, args);
        rec.result = snapshot(r);
        return r;
      } catch (e) {
        rec.error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        self.stack.pop();
        if (self.stores.has(module)) rec.gauge = self.untraced(() => self.gauge(module));
      }
    };
    Object.defineProperty(traced, "name", { value: fn.name });
    return traced;
  }

  /** Run `f` with tracing off (gauges, the inspector poking at stores). */
  untraced<T>(f: () => T): T {
    this.quiet++;
    try {
      return f();
    } finally {
      this.quiet--;
    }
  }

  /** Run one trigger's handler, recording everything it calls. */
  record(label: string, dock: string, f: () => unknown): Run {
    const roots: CallRec[] = [];
    this.current = roots;
    const start = this.seq;
    const run: Run = { label, dock, root: null, calls: 0 };
    try {
      run.result = snapshot(f());
    } catch (e) {
      run.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.current = null;
      this.stack = [];
    }
    run.root = roots[0] ?? null;
    run.calls = this.seq - start;
    return run;
  }
}
