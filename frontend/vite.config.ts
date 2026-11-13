import { defineConfig } from "vite";

// Relative base so the build can be served from any path (GitHub Pages, IPFS, a subfolder).
export default defineConfig({
  base: "./",
  build: { target: "es2022" },
});
