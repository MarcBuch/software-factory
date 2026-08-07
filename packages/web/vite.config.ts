import { dirname, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
const here = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  plugins: [TanStackRouterVite(), react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: resolve(here, "../cli/ui/dist"), emptyOutDir: true },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
  },
});
