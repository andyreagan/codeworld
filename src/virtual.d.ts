declare module "virtual:codeworld" {
  import type { CodeGraph } from "./analyze/types";
  export interface Example {
    graph: CodeGraph;
    /** Sample files, keyed by path relative to the example (`samples/x.csv`). */
    samples: Record<string, string>;
    modules: Record<string, () => Promise<Record<string, unknown>>>;
  }
  export const examples: Example[];
}
