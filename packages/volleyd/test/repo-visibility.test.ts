import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readJournalFile } from "../src/journal";
import { HYGIENE_CHECK, hygieneText } from "../src/reviews";
import type { JournalEvent, WaveState } from "../src/types";
import { type DaemonEnv, makeDaemonEnv } from "./helpers/daemon-env";
import { fakeClock } from "./helpers/fake-clock";
import { memoryCredentials } from "./helpers/fake-dynsec";
import { type FakeExec, fakeExec } from "./helpers/fake-exec";
import { FIXTURES, type FakeHost, fakeHost } from "./helpers/fake-host";
import { journalWait } from "./helpers/journal-wait";
import { runCli } from "./helpers/run-cli";

const P3_RULE = hygieneText("p3").rule;

describe("public hygiene: the repository's visibility, read at submit", () => {
  let env: DaemonEnv;
  let fake: FakeExec;
  let host: FakeHost;
  let repo: string;

  const journal = (): JournalEvent[] =>
    readJournalFile(join(env.home, "waves", "w1", "journal.jsonl"));

  /**
   * A daemon on fakes, wave w1 submitted (`config` lines go into the wave's `config:`), then a
   * spec reviewer spawned by hand; returns that reviewer's brief.
   */
  async function submitAndReview(o: {
    repoView?: string | { code: number };
    config?: string;
  }): Promise<string> {
    env = await makeDaemonEnv();
    repo = join(realpathSync(env.home), "repo");
    mkdirSync(repo);
    const claudeJson = join(env.home, "claude.json");
    writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
    );
    fake = fakeExec()
      .on(["git", "-C", repo, "rev-parse", "--show-toplevel"], { stdout: `${repo}\n` })
      .on(["git", "-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/release/w1"], {
        stdout: `${"1".repeat(40)}\n`,
      })
      .on(["gh", "issue", "view"], {
        stdout: readFileSync(join(FIXTURES, "gh-issue-42.json"), "utf-8"),
      });
    if (typeof o.repoView === "string") {
      fake.on(["gh", "repo", "view"], {
        stdout: readFileSync(join(FIXTURES, o.repoView), "utf-8"),
      });
    } else if (o.repoView !== undefined) fake.on(["gh", "repo", "view"], o.repoView);
    host = fakeHost(fake);
    const daemon = await env.start({
      clock: fakeClock(Date.now()),
      spawner: {
        host,
        claudeJsonPath: claudeJson,
        hooksDir: "/opt/volley-hooks",
        credentials: memoryCredentials(),
      },
    });
    const waits = journalWait(env.home, () => daemon);
    const wave = join(env.home, "w1.yaml");
    writeFileSync(
      wave,
      `wave: w1\nrepo: ${repo}\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement]\ntasks:\n  T1: { issue: 42 }\nconfig: { worktree_root: ${join(env.home, "wt")}${o.config !== undefined ? `, ${o.config}` : ""} }\n`,
    );
    expect((await runCli(["run", wave], env.env)).exitCode).toBe(0);
    await waits.event("w1", "agent_spawned");
    const r = await runCli(["spawn", "w1", "T1", "--role", "spec_reviewer", "--json"], env.env);
    expect(r.exitCode).toBe(0);
    await waits.settled();
    const wt = host.worktrees.find((w) => w.path.includes("spec_reviewer"));
    return readFileSync(join(wt?.path as string, ".volley", "brief.md"), "utf-8");
  }

  const detected = () => journal().filter((e) => e.type === "repo_visibility_detected");
  const state = async () =>
    ((await env.retained("volley/_waves/w1/state")) as { payload: WaveState }).payload;
  const repoViews = () => fake.argvs(["gh", "repo", "view"]);

  afterEach(async () => {
    await env.cleanup();
  });

  it("auto on a private repository: journaled once, P3 wording, state shows it", async () => {
    const brief = await submitAndReview({ repoView: "gh-repo-view-private.json" });
    expect(repoViews()).toEqual([["gh", "repo", "view", "--json", "visibility"]]);
    expect(fake.calls.find((c) => c.argv[1] === "repo")?.opts.cwd).toBe(repo);
    expect(detected().map((e) => e.data)).toEqual([
      { visibility: "private", source: "gh", public_hygiene: "auto" },
    ]);
    expect(await state()).toMatchObject({ repo_visibility: "private", hygiene_level: "p3" });
    expect(brief).toContain(P3_RULE);
    expect(brief).not.toContain(HYGIENE_CHECK);
    const status = await runCli(["status", "w1"], env.env);
    expect(status.stdout).toContain("hygiene: P3 (private)");
  });

  it("auto on a public repository: the P1 line", async () => {
    const brief = await submitAndReview({ repoView: "gh-repo-view-public.json" });
    expect(detected().map((e) => e.data.visibility)).toEqual(["public"]);
    expect(await state()).toMatchObject({ repo_visibility: "public", hygiene_level: "p1" });
    expect(brief).toContain(HYGIENE_CHECK);
    expect(brief).toContain('"hygiene": { "checked": true, "findings": [] }');
    expect((await runCli(["status", "w1"], env.env)).stdout).toContain("hygiene: P1 (public)");
  });

  it("public_hygiene: on never runs gh and forces P1 on a private repository", async () => {
    const brief = await submitAndReview({
      repoView: "gh-repo-view-private.json",
      config: "public_hygiene: on",
    });
    expect(repoViews()).toEqual([]);
    expect(detected().map((e) => e.data)).toEqual([
      { visibility: null, source: "config", public_hygiene: "on" },
    ]);
    expect(brief).toContain(HYGIENE_CHECK);
  });

  it("public_hygiene: off writes neither the rule nor the block", async () => {
    const brief = await submitAndReview({
      repoView: "gh-repo-view-public.json",
      config: "public_hygiene: off",
    });
    expect(repoViews()).toEqual([]);
    expect(await state()).toMatchObject({ repo_visibility: null, hygiene_level: "off" });
    expect(brief).not.toContain(HYGIENE_CHECK);
    expect(brief).not.toContain(P3_RULE);
    expect(brief).not.toContain('"hygiene":');
    expect((await runCli(["status", "w1"], env.env)).stdout).toContain("hygiene: off");
  });

  it("a new wave version records its own visibility (here: off, from its config)", async () => {
    await submitAndReview({ repoView: "gh-repo-view-private.json" });
    const wave = join(env.home, "w1.yaml");
    writeFileSync(
      wave,
      `wave: w1\nrepo: ${repo}\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement]\ntasks:\n  T1: { issue: 42 }\nconfig: { worktree_root: ${join(env.home, "wt")}, public_hygiene: off }\n`,
    );
    const r = await runCli(["run", wave], env.env);
    expect(r.exitCode).toBe(0);
    expect(detected().map((e) => [e.data.visibility, e.data.source])).toEqual([
      ["private", "gh"],
      [null, "config"],
    ]);
    expect(repoViews()).toHaveLength(1);
    expect(await state()).toMatchObject({
      version: 2,
      repo_visibility: null,
      hygiene_level: "off",
    });
  });

  it("a failed gh is unknown, raises repo_visibility_unknown and is treated as public", async () => {
    const brief = await submitAndReview({ repoView: { code: 1 } });
    expect(detected().map((e) => e.data)).toEqual([
      { visibility: "unknown", source: "gh", public_hygiene: "auto" },
    ]);
    expect(
      journal().some(
        (e) => e.type === "alarm_raised" && e.data.alarm === "repo_visibility_unknown",
      ),
    ).toBe(true);
    expect(await state()).toMatchObject({ repo_visibility: "unknown", hygiene_level: "p1" });
    expect(brief).toContain(HYGIENE_CHECK);
  });
});
