import { defineConfig } from "vite";

// Settings follow the Tauri 2 Vite guide: fixed port, and don't clear the
// terminal so Rust errors stay visible during `tauri dev`.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
  },
});
