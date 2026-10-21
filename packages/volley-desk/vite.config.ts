import path from "node:path";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";
import pkg from "./package.json";

/**
 * `dist/version.json` (`{ "version": "<package.json version>" }`): the bundle's version for
 * `volley desk serve`'s staleness warning and `volley deploy`'s checks, without parsing a hashed
 * asset.
 */
export function versionJson(version: string = pkg.version): Plugin {
  return {
    name: "volley-version-json",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: `${JSON.stringify({ version })}\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), versionJson()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5174,
    strictPort: false,
  },
});
