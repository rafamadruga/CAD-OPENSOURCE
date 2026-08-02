import { defineConfig } from "vite";

export default defineConfig({
  // caminhos relativos: funciona em GitHub Pages (subdiretório) e em qualquer host
  base: "./",
  build: {
    target: "esnext",
  },
  optimizeDeps: {
    exclude: ["replicad-opencascadejs"],
  },
});
