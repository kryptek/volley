import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUG_DEFAULTS } from "../../src/bug/gather";
import { type BugCommandDeps, runBug } from "../../src/commands/bug";
import { EXIT } from "../../src/exit-codes";
import { makeBufferIO } from "../../src/io";
import { BUG_NOW, bugMachine, ok } from "../helpers/bug-machine";
import { runCli } from "../helpers/run-cli";
import { tempDir } from "../helpers/tmp";

const STAMP = "20261025-120000";

function machine(opts: { tty?: boolean; answers?: (string | null)[]; ghSignedIn?: boolean } = {}) {
  const home = tempDir("volley-bug-cmd-");
  const cwd = join(home, "cwd");
  const m = bugMachine(home, { isTTY: opts.tty ?? false });
  m.write(join(cwd, ".keep"), "");
  const w = join(m.vhome, "waves", "wave-a");
  m.write(
    join(w, "journal.jsonl"),
    `${Array.from({ length: 50 }, (_, i) => JSON.stringify({ seq: i, repo: "canaryorg/canaryrepo" })).join("\n")}\n`,
  );
  m.write(
    join(m.vhome, "volleyd.log"),
    `${Array.from({ length: 20 }, (_, i) => `log ${i}`).join("\n")}\n`,
  );
  if (opts.ghSignedIn === true) {
    m.execs.set("gh auth status", ok("✓ Logged in to github.com account canary-gh (keyring)\n"));
  }
  const asked: string[] = [];
  const opened: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const deps: BugCommandDeps = {
    ...m.deps,
    cwd,
    ask: async (q) => {
      asked.push(q);
      return answers.shift() ?? null;
    },
    open: async (url) => {
      opened.push(url);
      return true;
    },
  };
  const run = async (argv: string[]) => {
    const io = makeBufferIO({ now: () => BUG_NOW });
    const code = await runBug({ argv, env: m.deps.env, io }, deps);
    return { code, stdout: io.readStdout(), stderr: io.readStderr() };
  };
  const issueCreates = () => m.calls.filter((a) => a[0] === "gh" && a[1] === "issue");
  return { m, cwd, asked, opened, run, issueCreates };
}

describe("volley bug", () => {
  it("--help prints the usage, through the CLI", async () => {
    const r = await runCli({ argv: ["bug", "--help"] });
    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.stdout).toContain("Usage: volley bug");
    expect(r.stdout).toContain("--keep-repos");
    const top = await runCli({ argv: ["--help"] });
    expect(top.stdout).toContain(
      "bug      Report a problem: gather diagnostics, redact them, show them, then open a GitHub issue or write a file",
    );
  });

  it("an unknown option is a usage error", async () => {
    const { run } = machine();
    expect((await run(["--nope"])).code).toBe(EXIT.USAGE);
  });

  it("non-TTY: prints the report, writes volley-bug-<stamp>.md, asks nothing, sends nothing", async () => {
    const { run, cwd, asked, opened, issueCreates } = machine();
    const r = await run(["-m", "first wave never started"]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toContain("## What happened\n\nfirst wave never started");
    const file = join(cwd, `volley-bug-${STAMP}.md`);
    expect(readFileSync(file, "utf-8")).toBe(r.stdout.slice(0, readFileSync(file, "utf-8").length));
    expect(r.stdout).toContain(file);
    expect(asked).toEqual([]);
    expect(opened).toEqual([]);
    expect(issueCreates()).toEqual([]);
  });

  it("TTY answering n: the file is written, nothing sent", async () => {
    const { run, cwd, asked, opened, issueCreates } = machine({
      tty: true,
      answers: ["it broke", "n"],
      ghSignedIn: true,
    });
    const r = await run([]);
    expect(r.code).toBe(EXIT.OK);
    expect(asked[1]).toContain("Open a GitHub issue with exactly this text? [y/N]");
    expect(r.stdout).toContain("gh is signed in as canary-gh");
    expect(existsSync(join(cwd, `volley-bug-${STAMP}.md`))).toBe(true);
    expect(opened).toEqual([]);
    expect(issueCreates()).toEqual([]);
  });

  it("TTY answering y with gh signed in: gh issue create with exactly the text shown", async () => {
    const { m, run, opened, issueCreates } = machine({
      tty: true,
      answers: ["y"],
      ghSignedIn: true,
    });
    let body = "";
    m.onExec = (argv) => {
      if (argv[0] !== "gh" || argv[1] !== "issue") return undefined;
      body = readFileSync(argv[argv.indexOf("--body-file") + 1] as string, "utf-8");
      return ok("https://github.com/kryptek/volley/issues/999\n");
    };
    const r = await run(["-m", "first wave never started"]);
    expect(r.code).toBe(EXIT.OK);
    const create = issueCreates()[0] as string[];
    expect(create.slice(0, 10)).toEqual([
      "gh",
      "issue",
      "create",
      "--repo",
      "kryptek/volley",
      "--label",
      "bug",
      "--title",
      "bug: first wave never started",
      "--body-file",
    ]);
    expect(body).toContain("## Diagnostics");
    expect(r.stdout.startsWith(body)).toBe(true);
    expect(r.stdout).toContain("https://github.com/kryptek/volley/issues/999");
    expect(opened).toEqual([]);
  });

  it("TTY answering y without gh: the file is written and the bug form opened, under 6 000 characters", async () => {
    const { run, cwd, opened, issueCreates } = machine({ tty: true, answers: ["", "y"] });
    const r = await run([]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toContain("gh is not signed in");
    expect(existsSync(join(cwd, `volley-bug-${STAMP}.md`))).toBe(true);
    expect(issueCreates()).toEqual([]);
    expect(opened).toHaveLength(1);
    expect((opened[0] as string).length).toBeLessThanOrEqual(BUG_DEFAULTS.url_max);
    expect(opened[0]).toContain("template=bug.yml");
    expect(new URL(opened[0] as string).searchParams.get("report")).toContain(
      `volley-bug-${STAMP}.md`,
    );
  });

  it("--file out.md never asks, even on a TTY", async () => {
    const { run, cwd, asked, opened } = machine({ tty: true, ghSignedIn: true });
    const out = join(cwd, "out.md");
    const r = await run(["--file", out]);
    expect(r.code).toBe(EXIT.OK);
    expect(asked).toEqual([]);
    expect(opened).toEqual([]);
    expect(readFileSync(out, "utf-8")).toContain("## Diagnostics");
    expect(readdirSync(cwd).filter((f) => f.startsWith("volley-bug-"))).toEqual([]);
  });

  it("--file without a path writes the default name", async () => {
    const { run, cwd, asked } = machine({ tty: true });
    expect((await run(["--file"])).code).toBe(EXIT.OK);
    expect(asked).toEqual([]);
    expect(existsSync(join(cwd, `volley-bug-${STAMP}.md`))).toBe(true);
  });

  it("--events and --lines bound the sections; repositories are redacted unless --keep-repos", async () => {
    const { run } = machine();
    const r = await run(["--events", "5", "--lines", "3"]);
    expect(r.stdout).toContain('{"seq":49,"repo":"[repo-1]"}');
    expect(r.stdout).not.toContain('"seq":44,');
    expect(r.stdout).toContain("log 19");
    expect(r.stdout).not.toContain("log 16");
    expect(r.stdout).not.toContain("canaryorg/canaryrepo");
    const kept = await run(["--keep-repos"]);
    expect(kept.stdout).toContain("canaryorg/canaryrepo");
    expect(kept.stdout).toContain("redacted: tokens, e-mails, user, host, ips\n");
  });
});
