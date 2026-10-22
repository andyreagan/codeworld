import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { codeworld } from "./tools/vite-plugin-codeworld";

export default defineConfig({
  base: "./",
  plugins: [codeworld(fileURLToPath(new URL(".", import.meta.url)))],
  build: { target: "es2022", chunkSizeWarningLimit: 1200 }
});
