import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnAgent } from "../src/spawn";
import { isRepoTrusted, recordRepoTrust, trustDecisionId } from "../src/trust";
import { type SpawnEnv, makeSpawnEnv } from "./helpers/fake-host";

describe("isRepoTrusted", () => {
  it("is true only when the repo root (or a parent) has hasTrustDialogAccepted: true", () => {
    const cfg = {
      projects: {
        "/w/repo": { hasTrustDialogAccepted: true },
        "/w/other": { hasTrustDialogAccepted: false },
        "/home/me": { hasTrustDialogAccepted: true },
      },
    };
    expect(isRepoTrusted(cfg, "/w/repo")).toBe(true);
    expect(isRepoTrusted(cfg, "/w/other")).toBe(false);
    expect(isRepoTrusted(cfg, "/w/missing")).toBe(false);
    expect(isRepoTrusted(cfg, "/home/me/src/x")).toBe(true);
    expect(isRepoTrusted(null, "/w/repo")).toBe(false);
    expect(isRepoTrusted({ projects: "nope" }, "/w/repo")).toBe(false);
  });
});

describe("recordRepoTrust", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "volleyd-trust-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
    expect(out.decisionId).toBe(trustDecisionId(env.repo));
    const opened = env.events.filter((e) => e.type === "decision_opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.data).toMatchObject({
      decision_id: trustDecisionId(env.repo),
      kind: "repo_untrusted",
      question: `Needs you: trust ${env.repo} for dispatch?`,
      options: ["trust", "cancel"],
    });
    expect(env.host.launches).toEqual([]);
    expect(env.host.worktrees).toEqual([]);
    const progs = env.host.fake.calls.map((c) => c.argv.slice(0, 2).join(" "));
    expect(progs.some((p) => p.startsWith("claude") || p === "cmux new-workspace")).toBe(false);
    expect(progs.some((p) => p === "volley auth")).toBe(false);
  });

  it("does not re-open the decision while it is open (the wave stays parked)", async () => {
    env = await makeSpawnEnv({ trusted: false });
    env.openDecisions.push(trustDecisionId(env.repo));
    const out = await spawnAgent(env.request(), env.deps);
    expect(out).toMatchObject({ kind: "decision", decision: "repo_untrusted", opened: false });
    expect(env.events.filter((e) => e.type === "decision_opened")).toEqual([]);
  });

  it("a trusted repo root proceeds to launch", async () => {
    env = await makeSpawnEnv({ trusted: true });
    const out = await spawnAgent(env.request(), env.deps);
    expect(out.kind).toBe("launched");
    expect(env.host.launches).toHaveLength(1);
  });

  it("trust accepted after the decision opened resolves it and proceeds", async () => {
    env = await makeSpawnEnv({ trusted: true });
    env.openDecisions.push(trustDecisionId(env.repo));
    const out = await spawnAgent(env.request(), env.deps);
    expect(out.kind).toBe("launched");
    const resolved = env.events.find((e) => e.type === "decision_resolved");
    expect(resolved?.data).toMatchObject({
      decision_id: trustDecisionId(env.repo),
      answer: "trusted",
    });
  });
});
