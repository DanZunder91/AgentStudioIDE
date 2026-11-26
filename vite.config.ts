import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Tauri's own watcher owns Rust. Generated dirs churn for no UI reason: `coverage/` alone
      // would hot-reload the live app dozens of times per `test:coverage` run.
      ignored: [
        "**/src-tauri/**",
        "**/coverage/**",
        "**/dist/**",
        "**/.git/**",
        "**/node_modules/**",
      ],
    },
  },
}));
