import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发代理：浏览器同源（cookie SameSite=Strict 直接生效）
const apiTarget = process.env.API_TARGET || "http://localhost:8000";
const proxied = [
  "/auth",
  "/admin",
  "/documents",
  "/search",
  "/github",
  "/chat",
  "/secrets",
  "/audit",
  "/dify",
  "/notifications",
  "/healthz",
];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      proxied.map((p) => [p, { target: apiTarget, changeOrigin: false }]),
    ),
  },
  build: { outDir: "dist", sourcemap: false },
});
