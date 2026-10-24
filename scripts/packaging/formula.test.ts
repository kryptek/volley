import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/tmp";
import { FORMULA, TAP_FORMULA, renderFormula } from "./formula";

/**
 * The Homebrew formula (packaging/homebrew/volley.rb), the release tarball it downloads
 * (scripts/packaging/tarball.sh) and the release workflow that ties them together.
 */

const ROOT = join(import.meta.dir, "..", "..");
const TARBALL = join(import.meta.dir, "tarball.sh");
const template = readFileSync(FORMULA, "utf-8");
const SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("the formula", () => {
  test("depends on bun, mosquitto, gh, git and tmux (bun from its own tap, as install.sh)", () => {
    const deps = [...template.matchAll(/^\s*depends_on "([^"]+)"$/gm)].map((m) => m[1]);
    expect(deps).toEqual(["gh", "git", "mosquitto", "oven-sh/bun/bun", "tmux"]);
    expect(readFileSync(join(ROOT, "install.sh"), "utf-8")).toContain("oven-sh/bun/bun");
  });

  test("installs the checkout into libexec", () => {
    expect(template).toMatch(/^\s*libexec\.install Dir\["\*"\]$/m);
  });

  test("bin/volley and bin/volleyd exec bun on the two CLIs in libexec", () => {
    expect(template).toContain('exec "#{bun}" "#{opt_libexec}/packages/#{pkg}/src/cli.ts" "$@"');
    expect(template).toContain('[["volley", "volley-cli"], ["volleyd", "volleyd"]].each');
    expect(template).toContain('bun = formula_opt_bin("oven-sh/bun/bun")/"bun"');
    for (const pkg of ["volley-cli", "volleyd"]) {
      expect(existsSync(join(ROOT, "packages", pkg, "src", "cli.ts"))).toBe(true);
    }
  });

  test("the caveats say to run volley setup", () => {
    const caveats = template.match(/def caveats\n([\s\S]*?)\n {2}end\n/)?.[1] ?? "";
    expect(caveats).toContain("volley setup");
    expect(caveats).toMatch(/after\s+(each|every)\s+`brew\s+upgrade/);
  });

  test("rendered for a version: the release asset's url and its sha256, no token left", () => {
    const rb = renderFormula("0.11.0", SHA);
    expect(rb).toContain(
      'url "https://github.com/kryptek/volley/releases/download/v0.11.0/volley-0.11.0.tar.gz"',
    );
    expect(rb).toContain(`sha256 "${SHA}"`);
    expect(rb).not.toMatch(/@[A-Z0-9]+@/);
    expect(renderFormula("v0.11.0", SHA.toUpperCase())).toBe(rb);
  });

  test("rendering refuses a version or a sha256 that is not one", () => {
    expect(() => renderFormula("0.11", SHA)).toThrow(/version/);
    expect(() => renderFormula("0.11.0; rm -rf /", SHA)).toThrow(/version/);
    expect(() => renderFormula("0.11.0", "abc")).toThrow(/sha256/);
  });

  test("the tap formula install.sh asks Homebrew for is this one", () => {
    expect(TAP_FORMULA).toBe("kryptek/volley/volley");
    expect(readFileSync(join(ROOT, "install.sh"), "utf-8")).toContain(`TAP_FORMULA=${TAP_FORMULA}`);
  });

  test("rendered, it is valid Ruby (when ruby is on PATH)", () => {
    const ruby = Bun.which("ruby");
    if (ruby === null) return;
    const dir = tempDir("volley-formula-");
    const file = join(dir, "volley.rb");
    writeFileSync(file, renderFormula("0.11.0", SHA));
    const r = Bun.spawnSync([ruby, "-c", file], { stdout: "pipe", stderr: "pipe" });
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
  });

  // CI's macOS job sets VOLLEY_BREW_STYLE=1 so a missing brew fails instead of skipping.
  test("rendered, brew style passes (where Homebrew is installed)", () => {
    const brew = Bun.which("brew");
    if (brew === null) {
      if (process.env.VOLLEY_BREW_STYLE === "1") throw new Error("VOLLEY_BREW_STYLE=1 needs brew");
      return;
    }
    // Homebrew rejects a formula outside a tap, so the test stages one under its Taps directory
    // (a name no real tap uses) and removes it afterwards.
    const env = { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1" };
    const repo = Bun.spawnSync([brew, "--repository"], { stdout: "pipe", env }).stdout.toString();
    const user = join(repo.trim(), "Library", "Taps", `volley-style-${process.pid}`);
    const dir = join(user, "homebrew-volley", "Formula");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "volley.rb"), renderFormula("0.11.0", SHA));
      const r = Bun.spawnSync([brew, "style", "--formula", join(dir, "volley.rb")], {
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
      const out = `${r.stdout}${r.stderr}`;
      expect(out).not.toMatch(/\d+ offenses? detected|requires formulae to be in a tap/);
      expect({ exitCode: r.exitCode, out }).toEqual({ exitCode: 0, out });
    } finally {
      rmSync(user, { recursive: true, force: true });
    }
  }, 300_000);
});

/** GNU tar is what the release workflow runs (ubuntu-latest); a Mac without gtar skips. */
const gnuTar = (() => {
  for (const name of ["gtar", "tar"]) {
    const bin = Bun.which(name);
    if (bin === null) continue;
    const v = Bun.spawnSync([bin, "--version"], { stdout: "pipe" }).stdout.toString();
    if (v.includes("GNU tar")) return bin;
  }
  return null;
})();

/** A checkout with node_modules, a .git, a workspace symlink and a hardlink (bun's backend). */
function checkout(dir: string, order: "forward" | "reverse") {
  const files: [string, string][] = [
    ["package.json", '{"name":"volley"}\n'],
    ["README.md", "# Volley\n"],
    ["packages/volley-cli/src/cli.ts", "console.log('volley');\n"],
    ["packages/volleyd/src/cli.ts", "console.log('volleyd');\n"],
    ["node_modules/mqtt/package.json", '{"name":"mqtt"}\n'],
    ["node_modules/mqtt/build/index.js", "module.exports = {};\n"],
    ["node_modules/.bin/placeholder", "x\n"],
    [".git/HEAD", "ref: refs/heads/main\n"],
    [".git/objects/ab/cdef", "blob\n"],
    ["packages/volleyd/.git", "gitdir: elsewhere\n"],
  ];
  for (const [path, body] of order === "forward" ? files : [...files].reverse()) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  chmodSync(join(dir, "packages/volley-cli/src/cli.ts"), 0o755);
  symlinkSync("../packages/volley-cli", join(dir, "node_modules", "volley-cli"));
  linkSync(join(dir, "node_modules/mqtt/package.json"), join(dir, "node_modules/mqtt/copy.json"));
  const when = order === "forward" ? new Date("2026-01-02T03:04:05Z") : new Date();
  utimesSync(join(dir, "README.md"), when, when);
}

function tarball(src: string, out: string, version = "v0.11.0", epoch = "1761264000") {
  const r = Bun.spawnSync(["/bin/sh", TARBALL, version, src, out], {
    env: { ...process.env, SOURCE_DATE_EPOCH: epoch, ...(gnuTar ? { TAR: gnuTar } : {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function listing(file: string): string[] {
  const r = Bun.spawnSync(
    [gnuTar as string, "--list", "--verbose", "--full-time", "--utc", "-zf", file],
    { stdout: "pipe" },
  );
  return r.stdout.toString().split("\n").filter(Boolean);
}

describe.skipIf(gnuTar === null)("the release tarball", () => {
  test("is reproducible: the same bytes from two checkouts made in different orders", () => {
    const dir = tempDir("volley-tarball-");
    for (const [name, order] of [
      ["a", "forward"],
      ["b", "reverse"],
    ] as const) {
      mkdirSync(join(dir, name, "src"), { recursive: true });
      checkout(join(dir, name, "src"), order);
      const r = tarball(join(dir, name, "src"), join(dir, name, "out"));
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
    }
    const a = readFileSync(join(dir, "a", "out", "volley-0.11.0.tar.gz"));
    const b = readFileSync(join(dir, "b", "out", "volley-0.11.0.tar.gz"));
    expect(Buffer.compare(a, b)).toBe(0);
  });

  test("sorted entries under volley-<version>/, fixed mtimes and owners, no .git", () => {
    const dir = tempDir("volley-tarball-");
    checkout(join(dir, "src"), "reverse");
    expect(tarball(join(dir, "src"), join(dir, "out")).code).toBe(0);
    const lines = listing(join(dir, "out", "volley-0.11.0.tar.gz"));
    const names = lines.map((l) => l.split(/\s+/)[5] as string);
    expect(names).toEqual([
      "volley-0.11.0/",
      "volley-0.11.0/README.md",
      "volley-0.11.0/node_modules/",
      "volley-0.11.0/node_modules/.bin/",
      "volley-0.11.0/node_modules/.bin/placeholder",
      "volley-0.11.0/node_modules/mqtt/",
      "volley-0.11.0/node_modules/mqtt/build/",
      "volley-0.11.0/node_modules/mqtt/build/index.js",
      "volley-0.11.0/node_modules/mqtt/copy.json",
      "volley-0.11.0/node_modules/mqtt/package.json",
      "volley-0.11.0/node_modules/volley-cli",
      "volley-0.11.0/package.json",
      "volley-0.11.0/packages/",
      "volley-0.11.0/packages/volley-cli/",
      "volley-0.11.0/packages/volley-cli/src/",
      "volley-0.11.0/packages/volley-cli/src/cli.ts",
      "volley-0.11.0/packages/volleyd/",
      "volley-0.11.0/packages/volleyd/src/",
      "volley-0.11.0/packages/volleyd/src/cli.ts",
    ]);
    for (const l of lines) {
      const [mode, owner, , day, time] = l.split(/\s+/);
      expect(owner).toBe("0/0");
      expect(`${day} ${time}`).toBe("2025-10-24 00:00:00");
      // A hardlink is stored as its own file, so a moved libexec never depends on link order.
      expect(mode?.[0]).not.toBe("h");
    }
    const link = lines.find((l) => l.includes("node_modules/volley-cli"));
    expect(link).toContain("-> ../packages/volley-cli");
    const cli = lines.find((l) => l.endsWith("volley-cli/src/cli.ts"));
    expect(cli?.startsWith("-rwxr-xr-x")).toBe(true);
  });

  test("writes the sha256 next to it, and prints it; the test recomputes it", () => {
    const dir = tempDir("volley-tarball-");
    checkout(join(dir, "src"), "forward");
    const r = tarball(join(dir, "src"), join(dir, "out"), "0.11.0");
    expect(r.code).toBe(0);
    const bytes = readFileSync(join(dir, "out", "volley-0.11.0.tar.gz"));
    const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    expect(readFileSync(join(dir, "out", "volley-0.11.0.tar.gz.sha256"), "utf-8")).toBe(
      `${sha}  volley-0.11.0.tar.gz\n`,
    );
    expect(r.out).toContain(`sha256=${sha}`);
    expect(r.out).toContain(`file=${join(dir, "out", "volley-0.11.0.tar.gz")}`);
  });

  test("refuses a checkout without node_modules (no network at install), or a bad version", () => {
    const dir = tempDir("volley-tarball-");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "package.json"), "{}\n");
    const bare = tarball(join(dir, "src"), join(dir, "out"));
    expect(bare.code).toBe(1);
    expect(bare.err).toContain("node_modules");
    cpSync(join(dir, "src"), join(dir, "src2"), { recursive: true });
    mkdirSync(join(dir, "src2", "node_modules"));
    const bad = tarball(join(dir, "src2"), join(dir, "out"), "latest");
    expect(bad.code).toBe(2);
    expect(existsSync(join(dir, "out"))).toBe(false);
  });
});

describe("the release workflow", () => {
  const yml = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf-8");

  test("runs on a v* tag", () => {
    expect(yml).toMatch(/on:\n {2}push:\n {4}tags: \["v\*"\]\n/);
  });

  test("refuses a tag that is not the root package.json's version (the formula's test reads it)", () => {
    expect(yml).toContain(`[ "$(jq -r .version package.json)" = "\${GITHUB_REF_NAME#v}" ]`);
  });

  test("installs the lockfile's tree with macOS's natives, tars it and uploads both assets", () => {
    expect(yml).toContain("bun install --frozen-lockfile --os darwin --cpu '*'");
    expect(yml).toContain("scripts/packaging/tarball.sh");
    expect(yml).toContain("gh release upload");
    expect(yml).toContain(".tar.gz.sha256");
  });

  test("brew style runs on the rendered formula on macos-latest", () => {
    expect(yml).toContain("runs-on: macos-latest");
    expect(yml).toContain("bun scripts/packaging/formula.ts render");
    expect(yml).toMatch(/brew style/);
    // Homebrew rejects a formula outside a tap: the step stages it under brew's Taps directory.
    expect(yml).toContain('"$(brew --repository)/Library/Taps/');
  });

  test("the tap push is guarded by the token secret's presence, so forks skip it", () => {
    expect(yml).toContain("HOMEBREW_TAP_TOKEN: ${{ secrets.HOMEBREW_TAP_TOKEN }}");
    expect(yml).toContain("if: env.HOMEBREW_TAP_TOKEN != ''");
    expect(yml).toContain("if: env.HOMEBREW_TAP_TOKEN == ''");
    // The token reaches git through its credential, never a command line that is echoed.
    expect(yml).not.toMatch(/x-access-token:\$\{\{/);
  });

  test("CI runs this file on macOS with brew style required", () => {
    const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf-8");
    expect(ci).toContain("VOLLEY_BREW_STYLE: 1");
    expect(ci).toContain("bun test scripts/packaging/formula.test.ts");
  });
});
