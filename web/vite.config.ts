import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@core": fileURLToPath(new URL("../packages/core/src", import.meta.url)),
    },
  },
  build: {
    // wrangler.jsonc serves assets from ./dist/client at the repo root.
    outDir: fileURLToPath(new URL("../dist/client", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    // `npm run dev:web` alone has no Worker behind it. Point /api at `wrangler dev`.
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
});
