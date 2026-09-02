import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("./viewer", import.meta.url)),
  plugins: [react()],
  base: "./",
  define: {
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/viewer", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3579",
      "/ws": { target: "ws://localhost:3579", ws: true },
    },
  },
});
