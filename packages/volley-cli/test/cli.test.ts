import { describe, expect, it } from "vitest";
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
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("with an unknown subcommand, prints an error and exits 2", async () => {
    const r = await runCli({ argv: ["bogus"] });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown subcommand: bogus");
    expect(r.stderr).toContain("Usage: volley");
  });
});
