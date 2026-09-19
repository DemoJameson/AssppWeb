import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  // VITE_ALLOWED_HOSTS (comma-separated, in .env.local) lets each developer
  // expose the dev server under their own reverse-proxy domain without
  // committing it — the repo stays domain-free.
  const env = loadEnv(mode, process.cwd(), "");
  const allowedHosts = (env.VITE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);

  return {
    plugins: [react(), tailwindcss()],
    // The SAP signer worker dynamically imports the emscripten module, which
    // requires ES-module workers (code splitting is unsupported under iife).
    worker: {
      format: "es",
    },
    server: {
      host: "0.0.0.0",
      allowedHosts,
      proxy: {
        "/api": "http://localhost:8080",
        "/wisp": { target: "ws://localhost:8080", ws: true },
      },
    },
  };
});
