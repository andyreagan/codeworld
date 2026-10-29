declare module "virtual:codeworld" {
  import type { CodeGraph } from "./analyze/types";
  export interface Example {
    graph: CodeGraph;
    /** Whether its code runs in the page (JS), or only its map is simulated (mainframe). */
    live: boolean;
    /** Sample files, keyed by path relative to the example (`samples/x.csv`). */
    samples: Record<string, string>;
    modules: Record<string, () => Promise<Record<string, unknown>>>;
  }
  export const examples: Example[];
}
