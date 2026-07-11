import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vueDevTools from "vite-plugin-vue-devtools";
import { resolve } from "node:path";

// https://vite.dev/config/
// Async factory so we can conditionally load @sentry/vite-plugin only when
// SENTRY_AUTH_TOKEN is present (a normal `vite build` without the token still
// succeeds and skips upload).
export default defineConfig(async () => {
  const sentryPlugins = [];
  if (
    process.env.SENTRY_AUTH_TOKEN &&
    process.env.SENTRY_ORG &&
    process.env.SENTRY_PROJECT
  ) {
    const { sentryVitePlugin } = await import("@sentry/vite-plugin");
    sentryPlugins.push(
      sentryVitePlugin({
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        sourcemaps: {
          // Upload then delete maps so source is never served to clients (E9).
          filesToDeleteAfterUpload: ["**/*.map"],
        },
      }),
    );
  }

  // Only generate source maps when Sentry will upload-and-delete them (E9).
  // Without the token the maps would be built but not cleaned up, exposing
  // source code in the shipped bundle directory.
  const hasSentryToken = Boolean(
    process.env.SENTRY_AUTH_TOKEN &&
    process.env.SENTRY_ORG &&
    process.env.SENTRY_PROJECT,
  );

  return {
    define: {
      // enable devtools
      __VUE_PROD_DEVTOOLS__: "true",
    },
    plugins: [vue(), vueDevTools(), ...sentryPlugins],
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
      // "hidden" generates maps without sourceMappingURL comment in JS;
      // the Sentry plugin then uploads and deletes them (E9).
      // When Sentry is not configured we skip map generation entirely so
      // no .map files land in build/frontend.
      sourcemap: hasSentryToken ? "hidden" : false,
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
  };
});
