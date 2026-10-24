import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { runAgent } from "../src/agent";
import { readWorld } from "../src/world";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { git, makeRepo } from "./helpers/repo";
import { tempDir } from "./helpers/tmp";

const PASSWORD = "agent-secret";

let dir: string;
let home: string;
let broker: TestBroker | undefined;
let watcher: VolleyBroker | undefined;
let seen: { topic: string; type: string; payload: Record<string, unknown> }[];
let stop: (() => Promise<void>) | undefined;

/** A worktree on `branch` (cut from main) with the identity volleyd writes for `role`. */
function worktree(work: string, branch: string, id: string, role: string, brief: string) {
  git(work, "checkout", "-b", branch, "origin/main");
  mkdirSync(join(work, ".volley"));
  writeFileSync(
    join(work, ".volley", "agent.json"),
    JSON.stringify({
      agent_id: id,
      namespace: "default",
      parent_id: "volleyd",
      wave: "w1",
      task: "T1",
      role,
      broker_url: (broker as TestBroker).url,
      broker: { username: id, password: PASSWORD },
    }),
  );
  writeFileSync(join(work, ".volley", "brief.md"), brief);
}

const env = () => ({ VOLLEY_SIM_HOME: home, VOLLEY_SIMULATED: "1" });

beforeEach(async () => {
  dir = tempDir("volley-sim-agent-");
  home = join(dir, "sim");
  seen = [];
});

afterEach(async () => {
  await stop?.();
  await watcher?.disconnect();
  await broker?.close();
  stop = undefined;
  watcher = undefined;
  broker = undefined;
});

/** Start a broker that accepts only `id`'s login, and watch everything `id` publishes. */
async function watch(id: string) {
  const b = await startTestBroker({ credentials: { username: id, password: PASSWORD } });
  broker = b;
  const w = new VolleyBroker();
  watcher = w;
  await w.connect({ url: b.url, agentId: "watcher", username: id, password: PASSWORD });
  stop = await w.subscribeStream(`volley/default/${id}/#`, (m) => {
    const e = JSON.parse(m.payload) as { type: string; payload: Record<string, unknown> };
    seen.push({ topic: m.topic, type: e.type, payload: e.payload });
  });
}

const statuses = () => seen.filter((m) => m.topic.endsWith("/status")).map((m) => m.type);
/** The watcher has seen the terminal status (delivery trails the agent's publish). */
const settled = () => vi.waitFor(() => expect(statuses().at(-1)).toBe("done"), { timeout: 5000 });

describe("the simulated agent", () => {
  it("an implementer registers with its login, commits, pushes, opens the PR and reports done", async () => {
    const id = "w1-t1-implementer-1";
    await watch(id);
    const { work, origin } = makeRepo(dir);
    worktree(
      work,
      "w1/T1-implementer-1",
      id,
      "implementer",
      "# Implement T1\n\nWhen your gates are green, push `w1/T1-implementer-1` and open a pull request against `main`; do not merge it.\n",
    );
    const code = await runAgent({ cwd: work, env: env(), argv: ["--model", "m"], linger: false });
    expect(code).toBe(0);
    await settled();
    // The real broker refused every other login: these came over the identity's.
    expect(statuses()).toEqual(["spawning", "working", "done"]);
    const commits = git(origin, "rev-list", "main..w1/T1-implementer-1").split("\n");
    expect(commits).toHaveLength(1);
    expect(git(origin, "show", "w1/T1-implementer-1:src/t1.ts")).toContain("T1");
    const prs = readWorld(home).prs.filter((p) => p.state === "OPEN");
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ headRefName: "w1/T1-implementer-1", baseRefName: "main" });
    const done = seen.find((m) => m.type === "done");
    expect(done?.payload).toMatchObject({ pr_url: prs[0]?.url, worktree: work });
    // The SessionStart heartbeat the hooks would have sent.
    expect(seen.some((m) => m.type === "heartbeat")).toBe(true);
  }, 30000);

  it("a reviewer publishes a `result` (approve) and done", async () => {
    const id = "w1-t1-quality_reviewer-1";
    await watch(id);
    const { work } = makeRepo(dir);
    worktree(work, "w1/T1-quality_reviewer-1", id, "quality_reviewer", "# Review\n");
    expect(await runAgent({ cwd: work, env: env(), argv: [], linger: false })).toBe(0);
    await settled();
    const result = seen.find((m) => m.topic.endsWith("/result"));
    expect(result).toMatchObject({
      type: "review",
      payload: { verdict: "approve", findings: [] },
    });
    expect(statuses()).toEqual(["spawning", "working", "done"]);
  }, 30000);

  it("a fixup commits on top and pushes to the PR branch `.volley/findings.md` names", async () => {
    const id = "w1-t1-fixup-1";
    await watch(id);
    const { work, origin } = makeRepo(dir);
    git(work, "push", "origin", "main:w1/T1-implementer-1");
    worktree(work, "w1/T1-fixup-1", id, "fixup", "# Fix-up\n");
    writeFileSync(
      join(work, ".volley", "findings.md"),
      "Publish with `git push origin HEAD:w1/T1-implementer-1`.\n",
    );
    expect(await runAgent({ cwd: work, env: env(), argv: [], linger: false })).toBe(0);
    await settled();
    expect(git(origin, "rev-list", "main..w1/T1-implementer-1").split("\n")).toHaveLength(1);
    expect(seen.find((m) => m.topic.endsWith("/result"))?.type).toBe("fixup");
    expect(statuses().at(-1)).toBe("done");
  }, 30000);
});
