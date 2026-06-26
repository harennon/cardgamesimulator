import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vueDevTools from "vite-plugin-vue-devtools";
import { resolve } from "node:path";

// https://vite.dev/config/
export default defineConfig({
  define: {
    // enable devtools
    __VUE_PROD_DEVTOOLS__: "true",
  },
  plugins: [vue(), vueDevTools()],
  publicDir: false,
  root: "src/frontend",
  envDir: resolve(__dirname, "."),
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src/frontend"),
      "@shared": resolve(__dirname, "./src/shared"),
    },
  },
  build: {
    outDir: resolve(__dirname, "./build/frontend"),
    emptyOutDir: true,
  },
  assetsInclude: ["**/*.cert"],
  server: {
    host: true,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/socket.io": {
        target: "http://localhost:3000",
        ws: true,
      },
    },
  },
});
