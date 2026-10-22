/**
 * The codebase graph every analyzer produces and the world is built from.
 * Language-agnostic on purpose: the JS analyzer (js.ts) is the first, but a
 * COBOL/JCL one would emit the same shapes (programs and paragraphs for
 * modules and functions, PERFORM/CALL for calls, DD files for inboxes, VSAM
 * and DB2 tables for stores).
 */

/** An entry point: something outside the code that starts a run. */
export type Trigger =
  | { kind: "route"; method: string; path: string; example?: unknown }
  | { kind: "inbox"; glob: string; sample?: string }
  | { kind: "cron"; every: number };

export interface FnNode {
  /** `module#name`, unique in the codebase. */
  id: string;
  module: string;
  name: string;
  exported: boolean;
  params: string[];
  /** Lines of code, and a rough cyclomatic complexity (1 + branches). */
  loc: number;
  complexity: number;
  /** First paragraph of its doc comment. */
  doc: string;
  /** 1-based source lines. */
  line: number;
  endLine: number;
  triggers: Trigger[];
}

export interface ModuleNode {
  /** Path relative to the codebase root, e.g. `orders/pricing.js`. */
  id: string;
  dir: string;
  doc: string;
  loc: number;
  /** A data store (tagged `@store`): drawn as a tank farm, its size gauged by `count()`. */
  store: boolean;
  fns: string[];
  /** Modules (or external packages, prefixed `ext:`) it imports. */
  imports: string[];
  source: string;
}

export interface CallEdge {
  from: string;
  to: string;
  /** Call sites in `from`'s body. */
  count: number;
  /** Line of the first call site (so a simulated run makes its calls in source order). */
  line: number;
}

/** The code map file format; bump on breaking changes. */
export const CODEMAP_FORMAT = "codeworld.codemap/1";

/**
 * The code map: the contract between analyzers and the world. Saved as
 * `<name>.codemap.json`; the world can load one without the code itself.
 */
export interface CodeGraph {
  format: typeof CODEMAP_FORMAT;
  name: string;
  title: string;
  description: string;
  language: string;
  modules: ModuleNode[];
  fns: FnNode[];
  calls: CallEdge[];
  externals: string[];
  /** Files the analyzer couldn't read, and why. */
  skipped: { path: string; reason: string }[];
}
