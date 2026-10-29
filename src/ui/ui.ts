import type { Example } from "virtual:codeworld";
import { CODEMAP_FORMAT, triggerText, type CodeGraph, type FnNode } from "../analyze/types";
import { roots, type Driver, type Entry } from "../runtime/driver";
import type { CallRec, Run } from "../runtime/trace";
import type { Sfx } from "../world/audio";
import type { Pick, World } from "../world/world";

/**
 * The DOM around the world: the control room (poke the entry points), the
 * inspector (what's this machine, what did it last do), the call log, and
 * the playback controls.
 */

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids);
  return el;
};

const short = (v: unknown, n = 80): string => {
  const s = JSON.stringify(v) ?? "undefined";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

const shortId = (id: string) => id.replace(/\.js#/, "#");

const KEYWORDS = /\b(export|function|return|const|let|if|else|for|of|in|throw|new|import|from|while|try|catch|null|true|false|undefined|typeof)\b/g;

function highlight(src: string): string {
  const esc = src.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  // comments and strings first, keywords outside them
  return esc.replace(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|([^"'`/]+|\/)/g, (_, c, s, rest) =>
    c ? `<span class="c">${c}</span>` : s ? `<span class="s">${s}</span>` : rest.replace(KEYWORDS, '<span class="k">$1</span>')
  );
}

function sourceView(src: string, from: number, to: number, focus?: [number, number]): HTMLElement {
  const lines = highlight(src).split("\n");
  const pre = h("pre", { class: "src" });
  pre.innerHTML = lines
    .slice(from - 1, to)
    .map((l, i) => {
      const n = from + i;
      const hot = focus && n >= focus[0] && n <= focus[1];
      return `<span class="ln${hot ? " hot" : ""}"><i>${n}</i>${l || " "}</span>`;
    })
    .join("");
  return pre;
}

export interface UiDeps {
  examples: Example[];
  driver: Driver;
  world: World;
  /** Select (and fly to) a thing, or clear the selection. */
  focus(p: Pick | null): void;
  setSpeed(x: number): void;
  setFollow(on: boolean): void;
  sfx: Sfx;
  frameAll(): void;
  /** Swap the world for a code map loaded from a file. */
  openMap(graph: CodeGraph): void;
}

/** Parse a code map file, or say why it isn't one. */
export function readMap(text: string): CodeGraph {
  const g = JSON.parse(text) as CodeGraph;
  if (g?.format !== CODEMAP_FORMAT) throw new Error(`not a code map (want format "${CODEMAP_FORMAT}")`);
  return g;
}

export class Ui {
  private log = h("div", { class: "log" });
  private inspector = h("aside", { class: "panel inspector hidden" });
  private responses = new Map<string, HTMLElement>();
  private graph: CodeGraph;
  private fnById: Map<string, FnNode>;
  private selected: Pick | null = null;

  constructor(private d: UiDeps) {
    this.graph = d.driver.graph;
    this.fnById = new Map(this.graph.fns.map((f) => [f.id, f]));
    document.body.append(this.topbar(), this.controlRoom(), this.inspector, this.log, this.playback(), this.dropOverlay());
  }

  private topbar(): HTMLElement {
    const sel = h("select", { "aria-label": "Example codebase" });
    const live = this.d.driver.live;
    for (const ex of this.d.examples) {
      const o = h("option", { value: ex.graph.name }, ex.graph.title);
      if (ex.graph === this.graph) o.setAttribute("selected", "");
      sel.append(o);
    }
    if (!this.d.examples.some((ex) => ex.graph === this.graph)) sel.prepend(h("option", { value: "", selected: "" }, this.graph.title));
    sel.addEventListener("change", () => {
      if (!sel.value) return;
      location.href = `${location.pathname}?example=${encodeURIComponent(sel.value)}`;
    });
    // codebase -> code map -> world: open a map someone made with `npm run codemap`, or save this one
    const file = h("input", { type: "file", accept: ".json,application/json", class: "hidden" }) as HTMLInputElement;
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      if (f) this.loadMapFile(f);
    });
    const open = h("button", { title: "Open a .codemap.json made with npm run codemap" }, "Open map…");
    open.addEventListener("click", () => file.click());
    const save = h("button", { title: "Download this world's code map" }, "Save map");
    save.addEventListener("click", () => {
      const a = h("a", { href: URL.createObjectURL(new Blob([JSON.stringify(this.graph)], { type: "application/json" })), download: `${this.graph.name}.codemap.json` });
      a.click();
      URL.revokeObjectURL(a.href);
    });
    const g = this.graph;
    const stats = `${g.modules.length} modules · ${g.fns.length} functions · ${g.calls.length} belts`;
    return h(
      "header",
      { class: "topbar" },
      h("div", { class: "brand" }, "CODE", h("b", {}, "WORLD")),
      sel,
      h("span", { class: `mode ${live ? "live" : "static"}`, title: live ? "The code itself is running in this page" : "Only the code map: runs are simulated from the call graph" }, live ? "live code" : "static map"),
      open,
      save,
      file,
      h("div", { class: "desc" }, g.description, h("span", { class: "stats" }, stats)),
      h("div", { class: "keys" }, "drag pan · right-drag orbit · wheel zoom · WASD · click to inspect")
    );
  }

  private controlRoom(): HTMLElement {
    const panel = h("aside", { class: "panel control" }, h("h2", {}, "Control room"));
    for (const e of this.d.driver.entries) panel.append(this.entryCard(e));
    if (!this.d.driver.entries.length) {
      panel.append(h("p", { class: "hint" }, "No entry points are tagged (@route, @inbox, @cron). Trace from the functions that reach the most, or click any machine and press ▶ Trace."));
      for (const { fn, reach } of roots(this.graph)) {
        const b = h("button", { class: "root", title: fn.id }, h("code", {}, `${fn.module.split("/").pop()!.replace(/\.(m|c)?js$/, "")}#${fn.name}`), h("span", {}, `reaches ${reach}`));
        b.addEventListener("click", () => {
          this.d.focus({ kind: "machine", id: fn.id });
          this.d.driver.traceFrom?.(fn.id);
        });
        panel.append(b);
      }
    }
    if (this.graph.skipped.length) panel.append(h("p", { class: "hint" }, `${this.graph.skipped.length} files couldn't be read (see Save map → skipped).`));
    panel.append(this.legend());
    return panel;
  }

  private entryCard(e: Entry): HTMLElement {
    const t = e.trigger;
    const locate = h("button", { class: "link", title: "Find it in the world" }, "⌖");
    locate.addEventListener("click", () => this.d.focus({ kind: "dock", id: e.dock }));
    const out = h("pre", { class: "resp empty" });
    this.responses.set(e.dock, out);
    const fire = (f: () => Run) => {
      try {
        f();
        out.className = "resp pending";
        out.textContent = "on the belts…";
      } catch (err) {
        out.className = "resp bad";
        out.textContent = String(err instanceof Error ? err.message : err);
      }
    };
    const head = (kind: string, title: string) =>
      h("div", { class: "card-head" }, h("span", { class: `tag ${kind}` }, kind), h("b", {}, title), h("span", { class: "fn" }, `→ ${e.fn.name}()`), locate);
    if (t.kind === "route") {
      const path = h("input", { class: "path", value: t.path.replace(/:(\w+)/g, (_: string, k: string) => (k === "id" ? "1001" : k)), spellcheck: "false" }) as HTMLInputElement;
      const body = h("textarea", { rows: String(t.method === "GET" || t.method === "CICS" ? 1 : 5), spellcheck: "false" }) as HTMLTextAreaElement;
      body.value = JSON.stringify(t.example ?? {}, null, 2);
      const send = h("button", { class: "go" }, "Send");
      send.addEventListener("click", () =>
        fire(() => {
          const parsed = body.value.trim() ? JSON.parse(body.value) : {};
          return this.d.driver.request(t.method, path.value, parsed);
        })
      );
      return h("section", { class: "card" }, head("route", t.method), h("div", { class: "row" }, path, send), body, out);
    }
    if (t.kind === "inbox") {
      const sample = t.sample ? this.d.driver.samples[t.sample] : undefined;
      const name = t.sample?.split("/").pop() ?? "file";
      const kids: (Node | string)[] = [head("inbox", t.glob)];
      if (sample !== undefined) {
        const ta = h("textarea", { rows: "4", spellcheck: "false", class: "mono" }) as HTMLTextAreaElement;
        ta.value = sample;
        const btn = h("button", { class: "go" }, `Drop ${name}`);
        btn.addEventListener("click", () => fire(() => this.d.driver.drop(name, ta.value)));
        kids.push(ta, h("div", { class: "row" }, btn, h("span", { class: "hint" }, "or drag a file onto the world")));
      } else kids.push(h("span", { class: "hint" }, "drag a file onto the world"));
      kids.push(out);
      return h("section", { class: "card" }, ...kids);
    }
    if (t.kind === "job") {
      const submit = h("button", { class: "go" }, "Submit");
      submit.addEventListener("click", () => fire(() => this.d.driver.tick(e.dock)));
      const steps = this.graph.calls.filter((c) => c.from === e.fn.id).length;
      return h("section", { class: "card" }, head("job", t.name), h("div", { class: "row" }, submit, h("span", { class: "hint" }, `${steps} steps`)), out);
    }
    const toggle = h("button", { class: "go" }, "Start timer");
    toggle.addEventListener("click", () => {
      const on = !this.d.driver.timerOn(e.dock);
      this.d.driver.setTimer(e.dock, on);
      toggle.textContent = on ? "Stop timer" : "Start timer";
      toggle.classList.toggle("on", on);
    });
    const tick = h("button", {}, "Tick now");
    tick.addEventListener("click", () => fire(() => this.d.driver.tick(e.dock)));
    return h("section", { class: "card" }, head("cron", `every ${t.every}s`), h("div", { class: "row" }, toggle, tick), out);
  }

  private legend(): HTMLElement {
    return h(
      "details",
      { class: "legend" },
      h("summary", {}, "Legend"),
      h(
        "ul",
        {},
        h("li", {}, h("i", { class: "sw pad" }), "pad = module (tint = top-level directory)"),
        h("li", {}, h("i", { class: "sw t1" }), h("i", { class: "sw t2" }), h("i", { class: "sw t3" }), "machine = function; size = lines, colour = complexity"),
        h("li", {}, "yellow arm = exported · name with ‘·’ = private"),
        h("li", {}, "ground belt = call inside a module; gantry = call across modules"),
        h("li", {}, "tank + gauge = @store, filled by its count()"),
        h("li", {}, h("i", { class: "sw call" }), "arguments in · ", h("i", { class: "sw ret" }), "result back · ", h("i", { class: "sw err" }), "thrown"),
        h("li", {}, "crate object · barrels array · plates string · gear number · chip boolean · pallet nothing"),
        h("li", {}, "drone = a call with no belt (dynamic dispatch the analyzer didn't see)")
      )
    );
  }

  private playback(): HTMLElement {
    const speed = h("input", { type: "range", min: "-2", max: "3", step: "0.5", value: "0", "aria-label": "Playback speed" }) as HTMLInputElement;
    const val = h("span", { class: "val" }, "1×");
    speed.addEventListener("input", () => {
      const x = 2 ** Number(speed.value);
      val.textContent = `${x < 1 ? x.toFixed(2) : x}×`;
      this.d.setSpeed(x);
    });
    const follow = h("label", { class: "check" }, h("input", { type: "checkbox" }), "follow");
    follow.querySelector("input")!.addEventListener("change", (e) => this.d.setFollow((e.target as HTMLInputElement).checked));
    const all = h("button", {}, "Frame all");
    all.addEventListener("click", () => this.d.frameAll());
    const sfx = this.d.sfx;
    const mute = h("button", { class: "mute", title: "Sound on/off (M)", "aria-label": "Sound" }, sfx.isMuted ? "🔇" : "🔊");
    const vol = h("input", { type: "range", min: "0", max: "1", step: "0.05", value: String(sfx.volume), "aria-label": "Volume", class: "vol" }) as HTMLInputElement;
    const toggle = () => {
      sfx.setMuted(!sfx.isMuted);
      mute.textContent = sfx.isMuted ? "🔇" : "🔊";
    };
    mute.addEventListener("click", toggle);
    addEventListener("keydown", (e) => {
      if (e.key === "m" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) toggle();
    });
    vol.addEventListener("input", () => sfx.setVolume(Number(vol.value)));
    return h("div", { class: "playback" }, h("span", {}, "speed"), speed, val, follow, all, mute, vol);
  }

  private dropOverlay(): HTMLElement {
    const o = h("div", { class: "drop hidden" }, h("div", {}, "Drop a file into the factory"));
    let depth = 0;
    addEventListener("dragenter", (e) => {
      e.preventDefault();
      depth++;
      o.classList.remove("hidden");
    });
    addEventListener("dragleave", () => {
      if (--depth <= 0) o.classList.add("hidden");
    });
    addEventListener("dragover", (e) => e.preventDefault());
    addEventListener("drop", async (e) => {
      e.preventDefault();
      depth = 0;
      o.classList.add("hidden");
      for (const f of e.dataTransfer?.files ?? []) {
        if (/\.codemap\.json$/i.test(f.name)) {
          this.loadMapFile(f);
          continue;
        }
        try {
          this.d.driver.drop(f.name, await f.text());
        } catch (err) {
          this.toast(String(err instanceof Error ? err.message : err), true);
        }
      }
    });
    return o;
  }

  private async loadMapFile(f: File): Promise<void> {
    try {
      this.d.openMap(readMap(await f.text()));
    } catch (err) {
      this.toast(`${f.name}: ${err instanceof Error ? err.message : err}`, true);
    }
  }

  toast(text: string, bad = false): void {
    const t = h("div", { class: `toast${bad ? " bad" : ""}` }, text);
    document.body.append(t);
    setTimeout(() => t.remove(), 3500);
  }

  /** A run has been recorded (it's about to play). */
  started(run: Run): void {
    this.logLine(`▶ ${run.label}  (${run.calls} calls)`, "run");
  }

  enter(c: CallRec): void {
    this.logLine(`${"  ".repeat(this.depthOf(c))}→ ${shortId(c.id)}(${c.args.map((a) => short(a, 28)).join(", ")})`, c.error ? "bad" : "");
    if (this.selected?.kind === "machine" && this.selected.id === c.id) this.show(this.selected);
  }

  private depths = new Map<number, number>();
  private depthOf(c: CallRec): number {
    const d = c.parent === null ? 0 : (this.depths.get(c.parent) ?? 0) + 1;
    this.depths.set(c.seq, d);
    return d;
  }

  finished(run: Run): void {
    const out = run.dock ? this.responses.get(run.dock) : undefined;
    if (out) {
      out.className = run.error === undefined ? "resp ok" : "resp bad";
      // (multi-line strings, like a printed report, shown as lines)
      out.textContent = run.error === undefined ? JSON.stringify(run.result, null, 2).replace(/\\n/g, "\n") : `Error: ${run.error}`;
    }
    this.logLine(`${run.error === undefined ? "✓" : "✗"} ${run.label} → ${run.error ?? short(run.result, 60)}`, run.error === undefined ? "ok" : "bad");
  }

  private logLine(text: string, cls: string): void {
    this.log.append(h("div", { class: cls }, text));
    while (this.log.childElementCount > 60) this.log.firstElementChild!.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }

  show(p: Pick | null): void {
    this.selected = p;
    const el = this.inspector;
    el.replaceChildren();
    if (!p) {
      el.classList.add("hidden");
      return;
    }
    el.classList.remove("hidden");
    const close = h("button", { class: "link close", "aria-label": "Close" }, "×");
    close.addEventListener("click", () => this.d.focus(null));
    const fnLink = (id: string) => {
      const a = h("button", { class: "link fnlink" }, shortId(id));
      a.addEventListener("click", () => this.d.focus({ kind: "machine", id }));
      return a;
    };
    if (p.kind === "machine") {
      const f = this.fnById.get(p.id)!;
      const m = this.d.world.machines.get(p.id)!;
      const mod = this.graph.modules.find((x) => x.id === f.module)!;
      const callers = this.graph.calls.filter((c) => c.to === f.id).map((c) => c.from);
      const callees = this.graph.calls.filter((c) => c.from === f.id).map((c) => c.to);
      const entries = this.d.driver.entries.filter((e) => e.fn.id === f.id);
      el.append(
        close,
        h("div", { class: "kicker" }, `machine · ${f.module}`),
        h("h2", {}, `${f.name}(${f.params.join(", ")})`),
        f.doc ? h("p", { class: "doc" }, f.doc) : "",
        h(
          "div",
          { class: "badges" },
          h("span", {}, `${f.loc} lines`),
          h("span", {}, `complexity ${f.complexity}`),
          h("span", { class: `tier t${m.spot.tier}` }, `tier ${m.spot.tier}`),
          h("span", {}, f.exported ? "exported" : "private"),
          h("span", {}, `${m.calls} calls seen`)
        ),
        entries.length ? h("div", { class: "rel" }, h("b", {}, "entry for "), ...entries.map((e) => h("code", {}, triggerText(e.trigger)))) : "",
        callers.length ? h("div", { class: "rel" }, h("b", {}, "called by "), ...callers.map(fnLink)) : "",
        callees.length ? h("div", { class: "rel" }, h("b", {}, "calls "), ...callees.map(fnLink)) : ""
      );
      if (this.d.driver.traceFrom) {
        const go = h("button", { class: "go trace" }, "▶ Trace from here");
        go.addEventListener("click", () => this.d.driver.traceFrom!(f.id));
        el.append(go);
      }
      if (m.recent.length) {
        const list = h("div", { class: "recent" }, h("h3", {}, "Recent calls"));
        for (const c of m.recent)
          list.append(
            h(
              "div",
              { class: `call${c.error ? " bad" : ""}` },
              h("code", {}, `(${c.args.map((a) => short(a, 60)).join(", ")})`),
              h("code", { class: "res" }, c.error ? `✗ ${c.error}` : `→ ${short(c.result, 90)}`)
            )
          );
        el.append(list);
      }
      if (mod.source) el.append(h("h3", {}, "Source"), sourceView(mod.source, f.line, f.endLine));
    } else if (p.kind === "dock") {
      const e = this.d.driver.entries.find((x) => x.dock === p.id)!;
      const t = e.trigger;
      el.append(
        close,
        h("div", { class: "kicker" }, `dock · ${t.kind}`),
        h("h2", {}, triggerText(t)),
        h("div", { class: "rel" }, h("b", {}, "handled by "), fnLink(e.fn.id)),
        e.fn.doc ? h("p", { class: "doc" }, e.fn.doc) : ""
      );
    } else {
      const mod = this.graph.modules.find((x) => x.id === p.id)!;
      const gauge = this.d.world.silos.get(mod.id);
      el.append(
        close,
        h("div", { class: "kicker" }, `pad · ${mod.lang?.toLowerCase() ?? (mod.store ? "store" : "module")}`),
        h("h2", {}, mod.id),
        mod.doc ? h("p", { class: "doc" }, mod.doc) : "",
        h("div", { class: "badges" }, h("span", {}, `${mod.loc} lines`), h("span", {}, `${mod.fns.length} functions`), gauge ? h("span", {}, `count() = ${gauge.value}`) : ""),
        h("div", { class: "rel" }, h("b", {}, "functions "), ...mod.fns.map(fnLink))
      );
      if (mod.source) el.append(h("h3", {}, "Source"), sourceView(mod.source, 1, mod.source.split("\n").length));
    }
  }
}
