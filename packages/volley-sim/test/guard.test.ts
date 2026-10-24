import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The fakes must never reach a real install: their bin directory is never on the services' stable
 * PATH (`stableServicePath`, volley-cli's setup/service-path.ts) and never linked by the installer
 * (install.sh, packaging/). Only a request puts it on a PATH: `volley sim env` a shell's, and a
 * `volley setup` run simulated (`--simulated`, or `VOLLEY_SIMULATED=1`) the services' it writes
 * (`withSimulator`, setup/first-wave.ts; a run without the simulator writes them without it).
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const NEEDLE = /volley-sim/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const offenders = (paths: string[]) =>
  paths.flatMap((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .flatMap((line, i) => (NEEDLE.test(line) ? [`${relative(ROOT, f)}:${i + 1}`] : [])),
  );

describe("the simulator never reaches a real install", () => {
  it("stableServicePath (setup/service-path.ts) never names volley-sim", () => {
    const servicePath = join(ROOT, "packages", "volley-cli", "src", "setup", "service-path.ts");
    expect(existsSync(servicePath)).toBe(true);
    expect(offenders([servicePath])).toEqual([]);
  });

  it("the installer (install.sh, packaging/) never links volley-sim", () => {
    const installer = [join(ROOT, "install.sh"), ...files(join(ROOT, "packaging"))].filter(
      existsSync,
    );
    expect(installer.length).toBeGreaterThan(1);
    expect(offenders(installer)).toEqual([]);
  });
});
