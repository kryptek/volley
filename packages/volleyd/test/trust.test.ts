import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preconditionKey } from "../src/decisions";
import { spawnAgent } from "../src/spawn";
import {
  isRepoTrusted,
  recordRepoTrust,
  trustCancelHelp,
  trustDecisionId,
  trustQuestion,
} from "../src/trust";
import { type SpawnEnv, makeSpawnEnv } from "./helpers/fake-host";
import { tempDir } from "./helpers/tmp";

describe("isRepoTrusted", () => {
  it("is true only when the repo root (or a parent) has hasTrustDialogAccepted: true", () => {
    const cfg = {
      projects: {
        "/w/repo": { hasTrustDialogAccepted: true },
        "/w/other": { hasTrustDialogAccepted: false },
        "/path/to/home": { hasTrustDialogAccepted: true },
      },
    };
    expect(isRepoTrusted(cfg, "/w/repo")).toBe(true);
    expect(isRepoTrusted(cfg, "/w/other")).toBe(false);
    expect(isRepoTrusted(cfg, "/w/missing")).toBe(false);
    expect(isRepoTrusted(cfg, "/path/to/home/src/x")).toBe(true);
    expect(isRepoTrusted(null, "/w/repo")).toBe(false);
    expect(isRepoTrusted({ projects: "nope" }, "/w/repo")).toBe(false);
  });
});

describe("recordRepoTrust", () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir("volleyd-trust-");
  });

  it("writes exactly projects[root].hasTrustDialogAccepted and nothing else", () => {
    const path = join(dir, "claude.json");
    const before = {
      numStartups: 7,
      oauthAccount: { accountUuid: "x" },
      projects: {
        "/w/other": { hasTrustDialogAccepted: true, allowedTools: ["Bash"] },
        "/w/repo": {
          allowedTools: [],
          history: [{ display: "hi" }],
          hasTrustDialogAccepted: false,
        },
      },
    };
    writeFileSync(path, JSON.stringify(before, null, 2));
    recordRepoTrust(path, "/w/repo");
    const after = JSON.parse(readFileSync(path, "utf-8"));
    const expected = structuredClone(before);
    expected.projects["/w/repo"].hasTrustDialogAccepted = true;
    expect(after).toEqual(expected);
  });

  it("does not drop a concurrent write by Claude Code: re-reads and retries", () => {
    const path = join(dir, "claude.json");
    writeFileSync(path, JSON.stringify({ projects: {}, numStartups: 1 }));
    let raced = false;
    recordRepoTrust(path, "/w/repo", {
      beforeRename: () => {
        if (raced) return;
        raced = true;
        // Claude Code rewrites the file between our read and our rename (a larger file).
        writeFileSync(path, JSON.stringify({ projects: {}, numStartups: 2, tipsHistory: {} }));
      },
    });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      projects: { "/w/repo": { hasTrustDialogAccepted: true } },
      numStartups: 2,
      tipsHistory: {},
    });
  });

  it("creates the project entry when the root has none", () => {
    const path = join(dir, "claude.json");
    writeFileSync(path, JSON.stringify({ projects: {} }));
    recordRepoTrust(path, "/w/new");
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      projects: { "/w/new": { hasTrustDialogAccepted: true } },
    });
  });
});

describe("spawn: repo trust check", () => {
  let env: SpawnEnv;
  afterEach(() => env.cleanup());

  it("an untrusted repo root opens repo_untrusted and no launch argv reaches exec", async () => {
    env = await makeSpawnEnv({ trusted: false });
    const out = await spawnAgent(env.request(), env.deps);
    expect(out.kind).toBe("decision");
    if (out.kind !== "decision") return;
    expect(out.decision).toBe("repo_untrusted");
    expect(out.decisionId).toBe(trustDecisionId("w1", env.repo));
    const opened = env.events.filter((e) => e.type === "decision_opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.data).toMatchObject({
      decision_id: trustDecisionId("w1", env.repo),
      kind: "repo_untrusted",
      question: `Needs you: trust ${env.repo} for dispatch? 1 task is waiting: T1.`,
      options: ["trust", "cancel"],
      waiting: ["T1"],
    });
    expect(env.host.launches).toEqual([]);
    expect(env.host.worktrees).toEqual([]);
    const progs = env.host.fake.calls.map((c) => c.argv.slice(0, 2).join(" "));
    expect(progs.some((p) => p.startsWith("claude") || p === "cmux new-workspace")).toBe(false);
    expect(progs.some((p) => p === "volley auth")).toBe(false);
  });

  it("the decision id is unique per wave: two waves on one repo never share it", () => {
    // `volleyd resolve <id>` without --wave answers the first wave that has the id.
    const a = trustDecisionId("w1", "/repo");
    expect(a).toMatch(/^repo_untrusted-[0-9a-f]{12}$/);
    expect(trustDecisionId("w2", "/repo")).not.toBe(a);
    expect(trustDecisionId("w2", "/repo", { machine: "dev@box" })).not.toBe(
      trustDecisionId("w1", "/repo", { machine: "dev@box" }),
    );
    expect(trustDecisionId("w1", "/repo")).toBe(a);
  });

  it("the id is keyed by (machine, profile, repo root), never the task or attempt (#418)", () => {
    const both = trustDecisionId("w1", "/repo", { machine: "dev@box", profile: "/p/acct" });
    expect(trustDecisionId("w1", "/repo", { machine: "dev@box", profile: "/p/acct" })).toBe(both);
    expect(trustDecisionId("w1", "/repo", { machine: "dev@box" })).not.toBe(both);
    expect(trustDecisionId("w1", "/repo", { profile: "/p/acct" })).not.toBe(both);
    expect(trustDecisionId("w2", "/repo", { machine: "dev@box", profile: "/p/acct" })).not.toBe(
      both,
    );
    expect(trustDecisionId("w1", "/other", { machine: "dev@box", profile: "/p/acct" })).not.toBe(
      both,
    );
    // The key takes neither a task nor an attempt: two of either share it.
    expect(preconditionKey({ machine: "dev@box", profile: "/p/acct", root: "/repo" })).toBe(
      preconditionKey({ profile: "/p/acct", machine: "dev@box", root: "/repo" }),
    );
    expect(preconditionKey({ root: "/repo" })).not.toBe(
      preconditionKey({ machine: "dev@box", root: "/repo" }),
    );
  });

  it("the question names the machine and account once and lists the waiting tasks", () => {
    expect(trustQuestion("/repo", undefined, undefined, ["T1"])).toBe(
      "Needs you: trust /repo for dispatch? 1 task is waiting: T1.",
    );
    expect(trustQuestion("/repo", "box", "work", ["T1", "T2", "T3"])).toBe(
      "Needs you: trust /repo on box in Claude account work for dispatch? 3 tasks are waiting: T1, T2, T3.",
    );
    const twelve = ["i392", "i416", "i400", "i403", "i397", "i399", "a", "b", "c", "d", "e", "f"];
    expect(trustQuestion("/repo", "box", "work", twelve)).toBe(
      "Needs you: trust /repo on box in Claude account work for dispatch? 12 tasks are waiting: i392, i416, i400, i403, i397, i399, … (12 tasks).",
    );
    expect(trustCancelHelp(1)).toBe(
      "Cancels only the waiting launch; the tasks keep their other work. Trusting the repo later resumes them.",
    );
    expect(trustCancelHelp(12)).toContain("Cancels only the 12 waiting launches");
  });

  it("does not re-open the decision while it is open (the wave stays parked)", async () => {
    env = await makeSpawnEnv({ trusted: false });
    env.openDecisions.push(trustDecisionId("w1", env.repo));
    const out = await spawnAgent(env.request(), env.deps);
    expect(out).toMatchObject({ kind: "decision", decision: "repo_untrusted", opened: false });
    expect(env.events.filter((e) => e.type === "decision_opened")).toEqual([]);
  });

  it("a launch that finds the decision open joins it: its task waits on it (#418)", async () => {
    env = await makeSpawnEnv({ trusted: false });
    const id = trustDecisionId("w1", env.repo);
    env.openDecisions.push(id);
    const joins: unknown[] = [];
    env.deps.joinDecision = async (j) => {
      joins.push(j);
    };
    const out = await spawnAgent({ ...env.request(), task: "T1", role: "spec_reviewer" }, env.deps);
    expect(out).toMatchObject({ kind: "decision", decisionId: id, opened: false });
    expect(joins).toEqual([{ id, task: "T1", role: "spec_reviewer" }]);
    expect(env.events.filter((e) => e.type === "decision_opened")).toEqual([]);
    expect(env.host.launches).toEqual([]);
  });

  it("a trusted repo root proceeds to launch", async () => {
    env = await makeSpawnEnv({ trusted: true });
    const out = await spawnAgent(env.request(), env.deps);
    expect(out.kind).toBe("launched");
    expect(env.host.launches).toHaveLength(1);
  });

  it("trust accepted after the decision opened resolves it and proceeds", async () => {
    env = await makeSpawnEnv({ trusted: true });
    env.openDecisions.push(trustDecisionId("w1", env.repo));
    const out = await spawnAgent(env.request(), env.deps);
    expect(out.kind).toBe("launched");
    const resolved = env.events.find((e) => e.type === "decision_resolved");
    expect(resolved?.data).toMatchObject({
      decision_id: trustDecisionId("w1", env.repo),
      answer: "trusted",
    });
  });
});
