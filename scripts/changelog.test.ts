import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Fragment, TYPES, assemble, insertSection, main, parseFragment } from "./changelog";
import { tempDir } from "./helpers/tmp";

const ROOT = join(import.meta.dir, "..");

describe("parseFragment", () => {
  test("reads the issue and type from the name and keeps the bullets", () => {
    const f = parseFragment(
      "changes/194.fixed.md",
      "- volleyd: a retire ends the session. (#194)\n",
    );
    expect(f).toMatchObject({ issue: 194, pr: null, type: "fixed", slug: null });
    expect(f.bullets).toEqual(["- volleyd: a retire ends the session. (#194)"]);
  });

  test("appends the issue reference to a bullet that lacks it, and only to that one", () => {
    const f = parseFragment("changes/194.fixed.md", "- volleyd: one.\n- volleyd: two. (#194)\n");
    expect(f.bullets).toEqual(["- volleyd: one. (#194)", "- volleyd: two. (#194)"]);
  });

  test("keeps a bullet's continuation lines verbatim; the reference goes on its last line", () => {
    const text = "- **volleyd: a headline.** Some detail\n  that wraps `here`.\n";
    expect(parseFragment("changes/194.fixed.md", text).bullets).toEqual([
      "- **volleyd: a headline.** Some detail\n  that wraps `here`. (#194)",
    ]);
  });

  test("a slug names a second fragment for the same issue and type", () => {
    expect(parseFragment("changes/195.fixed.merged.md", "- x.")).toMatchObject({
      issue: 195,
      type: "fixed",
      slug: "merged",
    });
  });

  test("front matter that agrees with the name parses; one that disagrees throws naming the path", () => {
    const ok = parseFragment("changes/194.fixed.md", "---\nissue: 194\ntype: fixed\n---\n- x.\n");
    expect(ok.bullets).toEqual(["- x. (#194)"]);
    expect(() =>
      parseFragment("changes/194.fixed.md", "---\nissue: 194\ntype: added\n---\n- x.\n"),
    ).toThrow(/changes\/194\.fixed\.md/);
    expect(() => parseFragment("changes/194.fixed.md", "---\nissue: 195\n---\n- x.\n")).toThrow(
      /changes\/194\.fixed\.md/,
    );
  });

  test("a pr fragment carries the PR number", () => {
    expect(parseFragment("changes/pr123.docs.md", "- docs: a fix.")).toMatchObject({
      issue: null,
      pr: 123,
      type: "docs",
      bullets: ["- docs: a fix. (#123)"],
    });
  });

  test("a bad name throws naming the allowed types", () => {
    for (const name of ["changes/foo.md", "changes/194.bugfix.md", "changes/194.fixed.Bad.md"])
      expect(() => parseFragment(name, "- x.")).toThrow(
        /added \| changed \| fixed \| removed \| docs/,
      );
  });

  test("a fragment with no bullet, or prose outside a bullet, throws naming the path", () => {
    expect(() => parseFragment("changes/1.fixed.md", "\n\n")).toThrow(/changes\/1\.fixed\.md/);
    expect(() => parseFragment("changes/1.fixed.md", "prose\n- x.")).toThrow(
      /changes\/1\.fixed\.md/,
    );
  });
});

describe("assemble", () => {
  const frag = (path: string, text: string): Fragment => parseFragment(path, text);
  const six = [
    frag("changes/pr12.fixed.md", "- volley-desk: a pr fix."),
    frag("changes/196.fixed.md", "- volleyd: blocked is decided."),
    frag("changes/195.fixed.merged.md", "- volleyd: merged noticed."),
    frag("changes/195.fixed.md", "- volleyd: head moved.\n  More."),
    frag("changes/220.added.md", "- volley-desk: two rows."),
    frag("changes/7.docs.md", "- docs: a guide."),
  ];

  test("pins the section for six fragments: fixed type order, issues ascending, pr last", () => {
    expect(TYPES).toEqual(["added", "changed", "fixed", "removed", "docs"]);
    expect(assemble(six, { version: "0.5.0", date: "2026-10-27" })).toBe(
      [
        "## 0.5.0 — 2026-10-27",
        "",
        "### Added",
        "",
        "- volley-desk: two rows. (#220)",
        "",
        "### Fixed",
        "",
        "- volleyd: head moved.",
        "  More. (#195)",
        "- volleyd: merged noticed. (#195)",
        "- volleyd: blocked is decided. (#196)",
        "- volley-desk: a pr fix. (#12)",
        "",
        "### Docs",
        "",
        "- docs: a guide. (#7)",
        "",
      ].join("\n"),
    );
  });

  test("no fragments assemble to nothing", () => {
    expect(assemble([], { version: "0.5.0", date: "2026-10-27" })).toBe("");
  });
});

describe("insertSection", () => {
  const changelog =
    "# Changelog\n\nAll packages share one version.\n\n## 0.4.0 — 2026-10-20\n\nOld.\n";
  const section = "## 0.5.0 — 2026-10-27\n\n### Fixed\n\n- x. (#1)\n";

  test("goes after the intro, above the previous newest section", () => {
    expect(insertSection(changelog, section)).toBe(
      "# Changelog\n\nAll packages share one version.\n\n## 0.5.0 — 2026-10-27\n\n### Fixed\n\n- x. (#1)\n\n## 0.4.0 — 2026-10-20\n\nOld.\n",
    );
  });

  test("throws ALREADY_RELEASED when the version is there and fragments remain", () => {
    const released = insertSection(changelog, section);
    expect(() => insertSection(released, section)).toThrow(/ALREADY_RELEASED/);
  });

  test("an empty section leaves the changelog as it is", () => {
    expect(insertSection(changelog, "")).toBe(changelog);
  });
});

describe("main", () => {
  const CHANGELOG = "# Changelog\n\nIntro.\n\n## 0.4.0 — 2026-10-20\n\nOld.\n";

  function repo(fragments: Record<string, string>) {
    const root = tempDir("volley-changelog-");
    mkdirSync(join(root, "changes"));
    writeFileSync(join(root, "CHANGELOG.md"), CHANGELOG);
    writeFileSync(join(root, "changes", "README.md"), "# changes\n");
    for (const [name, text] of Object.entries(fragments))
      writeFileSync(join(root, "changes", name), text);
    return root;
  }

  function run(argv: string[], root: string, git?: string) {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(argv, {
      root,
      ...(git ? { git } : {}),
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  const ARGS = ["--version", "0.5.0", "--date", "2026-10-27"];

  test("writes the section, deletes every fragment but the README; a second run changes nothing", () => {
    const root = repo({ "194.fixed.md": "- volleyd: x.\n", "220.added.md": "- desk: y.\n" });
    expect(run(ARGS, root).code).toBe(0);
    const written = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    expect(written).toBe(
      "# Changelog\n\nIntro.\n\n## 0.5.0 — 2026-10-27\n\n### Added\n\n- desk: y. (#220)\n\n### Fixed\n\n- volleyd: x. (#194)\n\n## 0.4.0 — 2026-10-20\n\nOld.\n",
    );
    expect(readdirSync(join(root, "changes"))).toEqual(["README.md"]);
    expect(run(ARGS, root).code).toBe(0);
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(written);
  });

  test("refuses a half-done release: the version's section exists and fragments remain", () => {
    const root = repo({ "194.fixed.md": "- volleyd: x.\n" });
    expect(run(ARGS, root).code).toBe(0);
    writeFileSync(join(root, "changes", "195.fixed.md"), "- volleyd: late.\n");
    const r = run(ARGS, root);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/ALREADY_RELEASED/);
    expect(existsSync(join(root, "changes", "195.fixed.md"))).toBe(true);
  });

  test("--check prints the section and writes nothing", () => {
    const root = repo({ "194.fixed.md": "- volleyd: x.\n" });
    const r = run(["--check", ...ARGS], root);
    expect(r.code).toBe(0);
    expect(r.out).toContain("## 0.5.0 — 2026-10-27");
    expect(r.out).toContain("- volleyd: x. (#194)");
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(CHANGELOG);
    expect(existsSync(join(root, "changes", "194.fixed.md"))).toBe(true);
  });

  test("--check exits 1 on a malformed fragment, naming its path", () => {
    const root = repo({ "194.bugfix.md": "- x.\n" });
    const r = run(["--check", ...ARGS], root);
    expect(r.code).toBe(1);
    expect(r.err).toContain("changes/194.bugfix.md");
  });

  test("a missing --version or a bad --date exits 2 with usage", () => {
    const root = repo({});
    for (const argv of [
      ["--date", "2026-10-27"],
      ["--version", "0.5.0", "--date", "27-10-2026"],
      ["--version", "0.5.0"],
      ["--bogus", ...ARGS],
    ]) {
      const r = run(argv, root);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/usage: bun run changelog/);
    }
  });

  test("--commit stages CHANGELOG.md and changes/ and commits as a release commit", () => {
    const root = repo({ "194.fixed.md": "- volleyd: x.\n" });
    const log = join(root, "git.log");
    const git = join(root, "git-recorder.sh");
    writeFileSync(git, `#!/bin/sh\necho "$@" >> "${log}"\n`);
    chmodSync(git, 0o755);
    expect(run(["--commit", ...ARGS], root, git).code).toBe(0);
    expect(readFileSync(log, "utf8")).toBe(
      "add CHANGELOG.md changes\ncommit -m release: changelog for 0.5.0\n",
    );
  });

  test("--commit with nothing to assemble commits nothing", () => {
    const root = repo({});
    const log = join(root, "git.log");
    const git = join(root, "git-recorder.sh");
    writeFileSync(git, `#!/bin/sh\necho "$@" >> "${log}"\n`);
    chmodSync(git, 0o755);
    expect(run(["--commit", ...ARGS], root, git).code).toBe(0);
    expect(existsSync(log)).toBe(false);
  });
});

describe("the repository", () => {
  test("the repo's CHANGELOG.md has no Unreleased section and every fragment in changes/ parses", () => {
    expect(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8")).not.toMatch(/^## Unreleased/m);
    const names = readdirSync(join(ROOT, "changes")).filter((n) => n !== "README.md");
    for (const name of names)
      parseFragment(`changes/${name}`, readFileSync(join(ROOT, "changes", name), "utf8"));
    expect(readdirSync(join(ROOT, "changes"))).toContain("README.md");
  });
});
