import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
const here = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  plugins: [react()],
  build: { outDir: resolve(here, "../cli/ui/dist"), emptyOutDir: true },
});
