import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // served from the repo root so /assets/… stays stable for the landing page
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: "public",
  server: {
    port: 5173,
    // the dev server also proxies nothing: the game talks to the Colyseus
    // server directly (ws://localhost:2567) — see net.ts.
  },
  build: {
    target: "es2023",
    outDir: "dist",
  },
});
