import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 24700,
    proxy: {
      "/api": "http://localhost:24710",
      "/ws": {
        target: "http://localhost:24710",
        ws: true,
      },
    },
  },
});
