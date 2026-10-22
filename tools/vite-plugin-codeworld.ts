import { join, relative, sep } from "node:path";
import type { Plugin } from "vite";
import { analyzeJs, instrumentJs } from "../src/analyze/js";
import { readExamples } from "./examples";

const VIRTUAL = "virtual:codeworld";
const RESOLVED = `\0${VIRTUAL}`;

/**
 * Serves the example codebases to the world:
 * - `virtual:codeworld` exports each example's CodeGraph (analyzed here, at
 *   build time), its sample files, and a loader per module;
 * - every module under examples/<name>/src/ is instrumented on its way to
 *   the browser (analyze/js.ts instrumentJs), so it runs for real, traced.
 */
export function codeworld(root: string): Plugin {
  const dir = join(root, "examples");
  return {
    name: "codeworld",
    resolveId(id) {
      return id === VIRTUAL ? RESOLVED : undefined;
    },
    load(id) {
      if (id !== RESOLVED) return undefined;
      const entries = readExamples(dir).map((ex) => {
        const graph = analyzeJs(ex.files, { name: ex.name, ...ex.meta });
        const loaders = Object.keys(ex.files)
          .filter((f) => f.endsWith(".js"))
          .map((f) => `${JSON.stringify(f)}: () => import(${JSON.stringify(`/examples/${ex.name}/src/${f}`)})`);
        return `{ graph: ${JSON.stringify(graph)}, samples: ${JSON.stringify(ex.samples)}, modules: { ${loaders.join(", ")} } }`;
      });
      return `export const examples = [${entries.join(",\n")}];`;
    },
    transform(code, id) {
      const rel = relative(dir, id.split("?")[0]!).split(sep);
      if (rel[0] === ".." || rel[1] !== "src" || !id.endsWith(".js")) return undefined;
      return { code: instrumentJs(rel.slice(2).join("/"), code), map: null };
    },
    handleHotUpdate({ file, server }) {
      if (!file.startsWith(dir)) return;
      const mod = server.moduleGraph.getModuleById(RESOLVED);
      if (mod) server.moduleGraph.invalidateModule(mod);
      server.ws.send({ type: "full-reload" });
      return [];
    }
  };
}
