/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/bot-admin/",
  plugins: [react()],
  server: {
    port: 5301,
    host: true,
    proxy: {
      "/bot-admin/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/bot-admin/auth": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/bot-admin/rights-meta": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
  },
});
