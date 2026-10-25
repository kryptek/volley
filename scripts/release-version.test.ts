import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/tmp";
import { main } from "./release-version";

const ROOT = join(import.meta.dir, "..");

const LOCK = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "volley",
      "devDependencies": {
        "volley-cli": "workspace:*",
      },
    },
    "packages/volley-cli": {
      "name": "volley-cli",
      "version": "0.13.2",
      "bin": {
        "volley": "./src/cli.ts",
      },
    },
    "packages/volley-issues": {
      "name": "volley-issues",
      "version": "0.13.2",
    },
  },
  "packages": {
    "foo": ["foo@1.0.0", "", {}, "sha512-x"],
  }
}
`;

const SKILL = `---
name: volley-issues
version: 0.13
---

# Volley issues

**This skill is current.** This file declares \`version: 0.13\` in its frontmatter.
`;

/** A fixture workspace at 0.13.2: the root, two packages, bun.lock and the skill. */
function fixture(): string {
  const dir = tempDir("volley-release-version-");
  const pkg = (path: string, name: string, extra: Record<string, unknown> = {}) => {
    mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(
      join(dir, path, "package.json"),
      `${JSON.stringify({ name, version: "0.13.2", ...extra }, null, 2)}\n`,
    );
  };
  pkg(".", "volley", { private: true, workspaces: ["packages/*"] });
  pkg("packages/volley-cli", "volley-cli");
  pkg("packages/volley-issues", "volley-issues");
  writeFileSync(join(dir, "bun.lock"), LOCK);
  writeFileSync(join(dir, "packages", "volley-issues", "SKILL.md"), SKILL);
  return dir;
}

function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

describe("release-version --set", () => {
  test("rewrites the root, every package, bun.lock's workspaces and the skill's major.minor", () => {
    const dir = fixture();
    expect(run(["--root", dir, "--set", "0.14.0"]).code).toBe(0);
    for (const p of ["", "packages/volley-cli/", "packages/volley-issues/"])
      expect(JSON.parse(read(dir, `${p}package.json`)).version).toBe("0.14.0");
    const lock = read(dir, "bun.lock");
    expect(lock.match(/"version": "0\.14\.0"/g)).toHaveLength(2);
    // Only the workspace entries: the rest of the lockfile is left byte for byte.
    expect(lock).toBe(LOCK.replaceAll('"version": "0.13.2"', '"version": "0.14.0"'));
    const skill = read(dir, "packages/volley-issues/SKILL.md");
    expect(skill).toContain("\nversion: 0.14\n");
    expect(skill).toContain("declares `version: 0.14` in its frontmatter");
    expect(skill).not.toContain("0.13");
  });

  test("keeps each package.json's formatting and other fields", () => {
    const dir = fixture();
    run(["--root", dir, "--set", "0.13.3"]);
    expect(read(dir, "package.json")).toBe(
      `${JSON.stringify({ name: "volley", version: "0.13.3", private: true, workspaces: ["packages/*"] }, null, 2)}\n`,
    );
  });

  test("is idempotent", () => {
    const dir = fixture();
    run(["--root", dir, "--set", "0.13.3"]);
    const before = ["package.json", "bun.lock", "packages/volley-issues/SKILL.md"].map((p) =>
      read(dir, p),
    );
    expect(run(["--root", dir, "--set", "0.13.3"]).code).toBe(0);
    expect(
      ["package.json", "bun.lock", "packages/volley-issues/SKILL.md"].map((p) => read(dir, p)),
    ).toEqual(before);
  });

  test("refuses a version that is not X.Y.Z (exit 2)", () => {
    const dir = fixture();
    expect(run(["--root", dir, "--set", "v0.14"]).code).toBe(2);
    expect(run(["--root", dir]).code).toBe(2);
    expect(JSON.parse(read(dir, "package.json")).version).toBe("0.13.2");
  });
});

describe("release-version --check", () => {
  test("exits 0 when every file agrees with the root", () => {
    expect(run(["--root", fixture(), "--check"]).code).toBe(0);
  });

  test("exits 1 naming each file that disagrees, and 0 again after --set", () => {
    const dir = fixture();
    const p = join(dir, "packages", "volley-cli", "package.json");
    writeFileSync(p, read(dir, "packages/volley-cli/package.json").replace("0.13.2", "0.13.1"));
    const r = run(["--root", dir, "--check"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("packages/volley-cli/package.json: 0.13.1 (want 0.13.2)");
    expect(run(["--root", dir, "--set", "0.13.2"]).code).toBe(0);
    expect(run(["--root", dir, "--check"]).code).toBe(0);
  });

  test("names a bun.lock workspace entry and the skill's version when they disagree", () => {
    const dir = fixture();
    writeFileSync(join(dir, "bun.lock"), LOCK.replace('"0.13.2"', '"0.12.0"'));
    writeFileSync(
      join(dir, "packages", "volley-issues", "SKILL.md"),
      SKILL.replace("\nversion: 0.13\n", "\nversion: 0.12\n"),
    );
    const r = run(["--root", dir, "--check"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("bun.lock packages/volley-cli: 0.12.0 (want 0.13.2)");
    expect(r.err).toContain("packages/volley-issues/SKILL.md: version 0.12 (want 0.13)");
  });

  test("this repository agrees", () => {
    expect(run(["--root", ROOT, "--check"])).toMatchObject({ code: 0 });
  });
});
