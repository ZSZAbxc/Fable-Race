import { defineConfig } from "vite";

export default defineConfig({
  // host: true → 局域网可访问，朋友同一 WiFi 直接开你的 IP 试玩
  server: { port: 5173, host: true },
  base: "./",  // 相对路径，适配 Capacitor WebView 本地加载
  optimizeDeps: {
    exclude: ["@dimforge/rapier3d-compat"],
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 4000,
  },
});
