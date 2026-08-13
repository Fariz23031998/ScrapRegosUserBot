import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

declare module "vite" {
  interface UserConfig {
    test?: {
      environment?: "node" | "jsdom" | "happy-dom" | "edge-runtime";
      include?: string[];
    };
  }
}

function shouldFallbackToIndex(url: string) {
  const path = url.split("?")[0];
  if (!path.startsWith("/bot-admin")) return false;
  if (
    path.startsWith("/bot-admin/api") ||
    path.startsWith("/bot-admin/auth") ||
    path.startsWith("/bot-admin/rights-meta")
  ) {
    return false;
  }
  if (path.startsWith("/bot-admin/@")) return false;
  if (path.includes("/node_modules/")) return false;
  if (/\.[a-zA-Z0-9]+$/.test(path)) return false;
  return true;
}

function botAdminSpaFallback(): Plugin {
  return {
    name: "bot-admin-spa-fallback",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        const url = req.url || "";
        if (!shouldFallbackToIndex(url)) return next();
        req.url = "/bot-admin/index.html";
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const BACKEND = (env.VITE_API_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");

  const apiProxy: ProxyOptions = {
    target: BACKEND,
    changeOrigin: true,
    timeout: 0,
    proxyTimeout: 0,
  };

  return {
    base: "/bot-admin/",
    plugins: [react(), botAdminSpaFallback()],
    server: {
      port: 5301,
      host: true,
      allowedHosts: true,
      proxy: {
        "/bot-admin/api": apiProxy,
        "/bot-admin/auth": { target: BACKEND, changeOrigin: true },
        "/bot-admin/rights-meta": { target: BACKEND, changeOrigin: true },
        "/api": { target: BACKEND, changeOrigin: true },
        "/prices": { target: BACKEND, changeOrigin: true },
        "/css": { target: BACKEND, changeOrigin: true },
        "/js": { target: BACKEND, changeOrigin: true },
        "/brand-logo.png": { target: BACKEND, changeOrigin: true },
      },
    },
    test: {
      environment: "node",
      include: ["src/**/*.{test,spec}.ts"],
    },
  };
});
