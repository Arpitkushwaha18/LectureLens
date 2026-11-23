import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { readSupabaseBrowserConfig } from "./src/lib/supabase-env";

export default defineConfig(({ mode }) => {
  if (readSupabaseBrowserConfig(loadEnv(mode, import.meta.dirname, "VITE_")).status === "invalid") {
    throw new Error(
      "Invalid public Supabase configuration. Check frontend/.env.local; never use a secret/service-role key in VITE variables.",
    );
  }
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
      },
    },
    server: {
      port: 5173,
      strictPort: true,
    },
    preview: {
      port: 4173,
      strictPort: true,
    },
  };
});
