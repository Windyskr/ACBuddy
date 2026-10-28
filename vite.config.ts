import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("src/data/problems.json")) return "problems-data";
          if (/node_modules[/\\](react|react-dom|scheduler)[/\\]/.test(id)) return "react-vendor";
          return undefined;
        },
      },
    },
  },
});
