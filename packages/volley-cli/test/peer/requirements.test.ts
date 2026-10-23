import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { atLeast, requirementsOf } from "../../src/peer/requirements";
import { tempDir } from "../helpers/tmp";

/** A clone root holding `files`. */
function root(files: Record<string, string>): string {
  const dir = tempDir("volley-requirements-");
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
}

describe("a repository's toolchain requirements", () => {
  it("pom.xml needs java and mvn; with mvnw, java only", () => {
    expect(requirementsOf(root({ "pom.xml": "<project/>" }))).toEqual({
      tools: ["java", "mvn"],
      min: {},
    });
    expect(requirementsOf(root({ "pom.xml": "<project/>", mvnw: "#!/bin/sh\n" }))).toEqual({
      tools: ["java"],
      min: {},
    });
  });

  it("package.json with packageManager bun@1.3 needs bun ≥ 1.3; otherwise node", () => {
    expect(
      requirementsOf(root({ "package.json": JSON.stringify({ packageManager: "bun@1.3" }) })),
    ).toEqual({ tools: ["bun"], min: { bun: "1.3" } });
    expect(requirementsOf(root({ "package.json": "{}", "bun.lock": "{}" }))).toEqual({
      tools: ["bun"],
      min: {},
    });
    expect(requirementsOf(root({ "package.json": "{}" }))).toEqual({ tools: ["node"], min: {} });
  });

  it("each other manifest names its tool", () => {
    expect(
      requirementsOf(
        root({
          "build.gradle": "",
          "go.mod": "module example.com/x\n\ngo 1.22\n",
          "Cargo.toml": "",
          "pyproject.toml": "",
          Dockerfile: "FROM scratch\n",
        }),
      ),
    ).toEqual({ tools: ["cargo", "docker", "go", "java", "python3"], min: { go: "1.22" } });
    expect(requirementsOf(root({ "requirements.txt": "", "docker-compose.yml": "" }))).toEqual({
      tools: ["docker", "python3"],
      min: {},
    });
    expect(requirementsOf(root({}))).toEqual({ tools: [], min: {} });
  });

  it(".volley/requirements.yaml adds tools and overrides a minimum", () => {
    expect(
      requirementsOf(
        root({
          "pom.xml": "",
          ".volley/requirements.yaml": 'tools: [docker]\nmin:\n  java: "17"\n',
        }),
      ),
    ).toEqual({ tools: ["docker", "java", "mvn"], min: { java: "17" } });
    // A minimum names a tool the repository needs; a number reads as its version.
    expect(requirementsOf(root({ ".volley/requirements.yaml": "min:\n  node: 20\n" }))).toEqual({
      tools: ["node"],
      min: { node: "20" },
    });
  });

  it("unknown keys and malformed values are a clear error", () => {
    expect(() => requirementsOf(root({ ".volley/requirements.yaml": "toolz: [java]\n" }))).toThrow(
      /\.volley\/requirements\.yaml: unknown key "toolz" \(allowed: tools, min\)/,
    );
    for (const bad of [
      "tools: java\n",
      "tools: ['rm -rf /']\n",
      "min: [java]\n",
      "min:\n  java: latest\n",
      "- java\n",
      "tools: [\n",
    ]) {
      expect(() => requirementsOf(root({ ".volley/requirements.yaml": bad })), bad).toThrow(
        /\.volley\/requirements\.yaml/,
      );
    }
  });

  it("compares versions by number", () => {
    expect(atLeast("17.0.2", "17")).toBe(true);
    expect(atLeast("1.3.2", "1.3")).toBe(true);
    expect(atLeast("1.10.0", "1.9")).toBe(true);
    expect(atLeast("11.0.22", "17")).toBe(false);
    expect(atLeast("1.2.9", "1.3")).toBe(false);
  });
});
