import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import { runCli } from "./helpers/run-cli";

describe("cli", () => {
  it("with no args, prints usage to stderr and exits 2", async () => {
    const r = await runCli({ argv: [] });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Usage: volley");
    expect(r.stderr).toContain("pub");
    expect(r.stderr).toContain("sub");
    expect(r.stderr).toContain("wait");
    expect(r.stderr).toContain("list");
    expect(r.stderr).toMatch(/^ {2}deploy {3}Deploy a release tag/m);
    expect(r.stdout).toBe("");
  });

  it("with --help, prints usage to stdout and exits 0", async () => {
    const r = await runCli({ argv: ["--help"] });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage: volley");
    expect(r.stderr).toBe("");
  });

  it("with --version, prints the package version and exits 0", async () => {
    const r = await runCli({ argv: ["--version"] });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  it("every workspace package and the root share one release version", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const read = (p: string) =>
      (JSON.parse(readFileSync(p, "utf-8")) as { version: string }).version;
    const versions: Record<string, string> = { root: read(join(root, "package.json")) };
    for (const d of readdirSync(join(root, "packages"))) {
      const p = join(root, "packages", d, "package.json");
      if (existsSync(p)) versions[d] = read(p);
    }
    expect(Object.keys(versions).length).toBeGreaterThan(5);
    for (const [name, v] of Object.entries(versions))
      expect(`${name}@${v}`).toBe(`${name}@${pkg.version}`);
  });

  it("the CHANGELOG's newest section and bun.lock's workspaces carry that version", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf-8");
    // An `## Unreleased` section (changes landed on a release branch) sits above the newest one.
    expect(changelog.match(/^## (?!Unreleased$)(\S+)/m)?.[1]).toBe(pkg.version);
    const lock = readFileSync(join(root, "bun.lock"), "utf-8");
    const workspaces = [
      ...lock.matchAll(/"packages\/[^"]+": \{\s*"name": "([^"]+)",\s*"version": "([^"]+)"/g),
    ];
    expect(workspaces.length).toBeGreaterThan(5);
    for (const [, name, v] of workspaces) expect(`${name}@${v}`).toBe(`${name}@${pkg.version}`);
  });

  it("with an unknown subcommand, prints an error and exits 2", async () => {
    const r = await runCli({ argv: ["bogus"] });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown subcommand: bogus");
    expect(r.stderr).toContain("Usage: volley");
  });
});
