import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [vue()],
  root,
  publicDir: false,
  build: {
    outDir: path.resolve(root, "../public/collector-ui"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(root, "index.html"),
    },
  },
  server: {
    port: 5174,
    proxy: {
      "/api": { target: "http://127.0.0.1:3840", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:3840", ws: true },
    },
  },
});
