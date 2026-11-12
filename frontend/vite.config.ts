import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

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
  plugins: [
    react(),
    {
      // 构建结束时写入版本号；前端启动时比对，检测到新版本提示用户强刷
      // （SPA 旧标签页会一直跑旧 JS，用户感知不到已部署新版本）
      name: "emit-build-id",
      closeBundle() {
        fs.writeFileSync(
          path.resolve(__dirname, "dist/version.txt"),
          String(Date.now()),
        );
      },
    },
  ],
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      proxied.map((p) => [p, { target: apiTarget, changeOrigin: false }]),
    ),
  },
  build: { outDir: "dist", sourcemap: false },
});
