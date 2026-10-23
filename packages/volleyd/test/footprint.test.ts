import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ExecFn, ExecResult } from "../src/exec";
import { type Tree, footprintOf, readTree, treeFromLsTree } from "../src/footprint";
import { parseFilesSection } from "../src/overlap";

const fixture = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");

/** A token shaped like `a.b` with no `/`: an identifier (or an unrebased bare name), not a path. */
const IDENTIFIER = /^[A-Za-z_][\w]*\.[A-Za-z_][\w.*]*$/;

describe("footprintOf: the dogfood replay", () => {
  const issues = JSON.parse(fixture("replay/dogfood-26.json")) as {
    id: string;
    files: string[];
  }[];
  const tree = JSON.parse(fixture("replay/tree.json")) as Tree;
  // The fixture's `files` are the parser's raw output: replay them as each issue's Files list.
  const bodyOf = (files: string[]) => `## Files\n\n${files.map((f) => `- \`${f}\``).join("\n")}\n`;
  const prints = issues.map((i) => ({
    id: i.id,
    raw: i.files,
    fp: footprintOf(bodyOf(i.files), tree),
  }));

  it("before: the raw lists carry identifiers and bare names", () => {
    const raw = issues.flatMap((i) => i.files);
    expect(raw).toContain("github.slug");
    expect(raw).toContain("types.ts");
    expect(raw).toContain("lease_pools.*.match");
  });

  it("after: 26/26 resolve to listed or resolved", () => {
    expect(prints).toHaveLength(26);
    for (const p of prints) expect(["listed", "resolved"]).toContain(p.fp.confidence);
  });

  it("no files entry is an identifier (a root file such as package.json is a tree path)", () => {
    for (const p of prints) {
      for (const f of p.fp.files) if (!Object.hasOwn(tree, f)) expect(f).not.toMatch(IDENTIFIER);
    }
    const raw = issues
      .flatMap((i) => i.files)
      .filter((f) => IDENTIFIER.test(f) && !Object.hasOwn(tree, f));
    expect(raw.length).toBeGreaterThan(0);
    for (const p of prints) for (const f of p.fp.files) expect(raw).not.toContain(f);
  });

  it("the bare types.ts entries land on packages/volleyd/src/types.ts", () => {
    const withTypes = prints.filter((p) => p.raw.includes("types.ts"));
    expect(withTypes.length).toBeGreaterThan(0);
    for (const p of withTypes) {
      expect(p.fp.files).toContain("packages/volleyd/src/types.ts");
      expect(p.fp.unresolved).not.toContain("types.ts");
    }
  });

  it("every resolved file is a tree path, a glob, or new; bytes sum the tree paths", () => {
    for (const p of prints) {
      const inTree = p.fp.files.filter((f) => Object.hasOwn(tree, f));
      expect(p.fp.bytes).toBe(inTree.reduce((n, f) => n + (tree[f] ?? 0), 0));
    }
  });
});

describe("footprintOf: the rules (delta.md)", () => {
  const tree: Tree = {
    "packages/alpha/src/config.ts": 200,
    "packages/alpha/src/types.ts": 100,
    "packages/alpha/src/commands/run.ts": 11,
    "packages/alpha/src/pressure/run.ts": 12,
    "packages/alpha/src/dock/panel.ts": 3,
    "packages/alpha/test/helpers/harness.ts": 40,
    "packages/beta/src/types.ts": 50,
    "packages/beta/src/only-beta.ts": 30,
    "packages/beta/src/main.ts": 9,
    "spec/schemas/a.schema.json": 5,
    "spec/schemas/b.schema.json": 7,
    "docs/guide/one.md": 1,
    "docs/guide/two.md": 2,
  };
  const delta = fixture("issue-bodies/delta.md");

  it("resolves bare names, fragments, globs and new files; drops identifiers; sums bytes", () => {
    expect(footprintOf(delta, tree)).toEqual({
      files: [
        "packages/alpha/src/config.ts",
        "packages/alpha/src/types.ts",
        "packages/beta/src/only-beta.ts",
        "packages/alpha/src/footprint.ts",
        "packages/alpha/test/helpers/harness.ts",
        "packages/alpha/src/dock/*",
        "packages/alpha/src/dock/panel.ts",
        "spec/schemas/*",
        "spec/schemas/a.schema.json",
        "spec/schemas/b.schema.json",
        "changes/999.added.md",
      ],
      confidence: "resolved",
      unresolved: ["run.ts"],
      bytes: 200 + 100 + 30 + 40 + 3 + 5 + 7,
    });
  });

  it("a bare name resolves inside the previous entry's package before repo-wide", () => {
    const fp = footprintOf("## Files\n\n- `packages/beta/src/main.ts`\n- `types.ts`\n", tree);
    expect(fp.files).toEqual(["packages/beta/src/main.ts", "packages/beta/src/types.ts"]);
    expect(fp.confidence).toBe("listed");
  });

  it("an ambiguous bare name with no package to narrow it is unresolved", () => {
    const fp = footprintOf("## Files\n\n- `spec/schemas/a.schema.json`\n- `types.ts`\n", tree);
    expect(fp.files).toEqual(["spec/schemas/a.schema.json"]);
    expect(fp.unresolved).toEqual(["types.ts"]);
    expect(fp.confidence).toBe("resolved");
  });

  it("a directory resolves to the paths under it, and is kept for overlap matching", () => {
    const fp = footprintOf("Files: `docs/guide/`\n", tree);
    expect(fp.files).toEqual(["docs/guide/", "docs/guide/one.md", "docs/guide/two.md"]);
    expect(fp).toMatchObject({ confidence: "listed", bytes: 3 });
  });

  it("every entry resolved or new → listed", () => {
    const fp = footprintOf(
      "## Files\n\n- `packages/beta/src/main.ts`, `src/fresh.ts` (new)\n- `changes/1.fixed.md`\n",
      tree,
    );
    expect(fp).toEqual({
      files: ["packages/beta/src/main.ts", "packages/beta/src/fresh.ts", "changes/1.fixed.md"],
      confidence: "listed",
      unresolved: [],
      bytes: 9,
    });
  });

  it("no Files section → guessed from the body's backticked tree paths, de-duplicated", () => {
    const body =
      "# Title\n\nTouches `packages/alpha/src/config.ts`, `spec/schemas/a.schema.json` and `nope.ts`;" +
      " see `packages/alpha/src/config.ts` again.\n";
    expect(footprintOf(body, tree)).toEqual({
      files: ["packages/alpha/src/config.ts", "spec/schemas/a.schema.json"],
      confidence: "guessed",
      unresolved: [],
      bytes: 205,
    });
  });

  it("an empty body → none", () => {
    expect(footprintOf("", tree)).toEqual({
      files: [],
      confidence: "none",
      unresolved: [],
      bytes: 0,
    });
  });

  it("a Files section whose entries all fail to resolve falls back to the guess, else none", () => {
    expect(footprintOf("## Files\n\n- `nowhere.ts`\n", tree)).toEqual({
      files: [],
      confidence: "none",
      unresolved: ["nowhere.ts"],
      bytes: 0,
    });
  });
});

describe("parseFilesSection: the package-relative rebase of a bare name", () => {
  it("types.ts after packages/volleyd/src/config-defaults.ts → packages/volleyd/src/types.ts", () => {
    expect(
      parseFilesSection("## Files\n\n- `packages/volleyd/src/config-defaults.ts`, `types.ts`\n"),
    ).toEqual(["packages/volleyd/src/config-defaults.ts", "packages/volleyd/src/types.ts"]);
  });

  it("an identifier is never rebased", () => {
    expect(parseFilesSection("## Files\n\n- `packages/x/src/a.ts`, `github.slug`\n")).toEqual([
      "packages/x/src/a.ts",
      "github.slug",
    ]);
  });
});

describe("treeFromLsTree / readTree", () => {
  const LS =
    "100644 blob 1111111111111111111111111111111111111111     605\t.gitignore\n" +
    "100644 blob 2222222222222222222222222222222222222222   12257\tpackages/a/src/x y.ts\n" +
    "160000 commit 3333333333333333333333333333333333333333       -\tvendor/sub\n" +
    "120000 blob 4444444444444444444444444444444444444444      12\tlink\n" +
    '100644 blob 5555555555555555555555555555555555555555       3\t"docs/\\303\\251t\\303\\251.md"\n';

  it("maps each blob to its size, skipping submodules and unquoting C-quoted paths", () => {
    expect(treeFromLsTree(LS)).toEqual({
      ".gitignore": 605,
      "packages/a/src/x y.ts": 12257,
      link: 12,
      "docs/été.md": 3,
    });
  });

  it("readTree runs git ls-tree -r -l --full-tree <ref> in the repository", async () => {
    const calls: { argv: readonly string[]; cwd: string | undefined }[] = [];
    const fake: ExecFn = async (argv, opts) => {
      calls.push({ argv, cwd: opts?.cwd });
      return { code: 0, stdout: LS, stderr: "", timedOut: false };
    };
    expect(await readTree(fake, "/path/to/repo", "origin/release/w1")).toMatchObject({ link: 12 });
    expect(calls).toEqual([
      {
        argv: ["git", "ls-tree", "-r", "-l", "--full-tree", "origin/release/w1"],
        cwd: "/path/to/repo",
      },
    ]);
  });

  it("readTree is null when git fails, times out or is cut short", async () => {
    const r =
      (o: Partial<ExecResult>): ExecFn =>
      async () => ({ code: 0, stdout: LS, stderr: "", timedOut: false, ...o });
    expect(await readTree(r({ code: 128 }), "/path/to/repo", "x")).toBeNull();
    expect(await readTree(r({ timedOut: true }), "/path/to/repo", "x")).toBeNull();
    expect(await readTree(r({ truncated: true }), "/path/to/repo", "x")).toBeNull();
  });
});
