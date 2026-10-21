// @vitest-environment node
//
// The build's dist/version.json: what `volley desk serve` and `volley deploy` read to learn the
// bundle's version without parsing a hashed asset.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import { versionJson } from "../vite.config";
import { tempDir } from "./helpers/tmp";

describe("the Desk build's version.json", () => {
  it("is emitted into the outDir with package.json's version", async () => {
    const root = tempDir("volley-desk-version-");
    writeFileSync(join(root, "index.html"), "<!doctype html><title>t</title>");
    const outDir = join(root, "dist");
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [versionJson()],
      build: { outDir, emptyOutDir: true },
    });
    expect(JSON.parse(readFileSync(join(outDir, "version.json"), "utf-8"))).toEqual({
      version: pkg.version,
    });
  });
});
