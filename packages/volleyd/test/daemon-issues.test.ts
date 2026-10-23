import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MERGED_LABEL, mergedMarker, settledMarker } from "../src/autopilot/issues";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { ControlClient } from "../src/control";
import type { Daemon } from "../src/daemon";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { type FakeExec, fakeExec } from "./helpers/fake-exec";
import { fakeHost } from "./helpers/fake-host";
import { runCli } from "./helpers/run-cli";
import { schemaErrors } from "./helpers/schema";

/** volleyd owns a wave's issue lifecycle (#416): labeled at merge, verified once released. */

const WAVE = "w-iss";
const OWNER = "coord-a";
const YAML = `wave: ${WAVE}
repo: example-org/example-repo
release_branch: release/${WAVE}
model: claude-opus-5-5
pipeline: [implement, merge_ready]
tasks:
  T3: { issue: 412 }
  T4: { issue: 413 }
  T5: { issue: 414 }
`;

interface Issue {
  state: "OPEN" | "CLOSED";
  labels: string[];
  comments: string[];
}

/** A GitHub that keeps what gh does to it: issues, the repo's labels, the release PR. */
function fakeGitHub() {
  const issues = new Map<number, Issue>(
    [412, 413, 414].map((n) => [n, { state: "OPEN", labels: [], comments: [] }]),
  );
  const labels: string[] = [];
  let releasePr: number | null = null;
  const fake: FakeExec = fakeExec();
  const issue = (argv: string[]) => issues.get(Number(argv[3])) as Issue;
  fake
    // The release branch is there (run checks it before any spawn).
    .on(["git", "-C"], (argv) =>
      argv.includes("--verify") ? { stdout: `${"1".repeat(40)}\n` } : {},
    )
    .on(["gh", "issue", "view"], (argv) => {
      const i = issue(argv);
      return {
        stdout: JSON.stringify({
          state: i.state,
          labels: i.labels.map((name) => ({ name })),
          comments: i.comments.map((body) => ({ body })),
        }),
      };
    })
    .on(["gh", "issue", "edit"], (argv) => {
      const i = issue(argv);
      if (argv[4] === "--add-label") i.labels.push(argv[5] as string);
      else i.labels = i.labels.filter((l) => l !== argv[5]);
      return {};
    })
    .on(["gh", "issue", "comment"], (argv) => {
      issue(argv).comments.push(argv[5] as string);
      return {};
    })
    .on(["gh", "issue", "close"], (argv) => {
      const i = issue(argv);
      i.state = "CLOSED";
      i.comments.push(argv[5] as string);
      return {};
    })
    .on(["gh", "label", "list"], () => ({
      stdout: JSON.stringify(labels.map((name) => ({ name }))),
    }))
    .on(["gh", "label", "create"], (argv) => {
      labels.push(argv[3] as string);
      return {};
    })
    .on(["gh", "pr", "list"], () => ({
      stdout: JSON.stringify(
        releasePr === null ? [] : [{ number: releasePr, baseRefName: "main" }],
      ),
    }));
  return {
    fake,
    issues,
    labels,
    release: (n: number) => {
      releasePr = n;
    },
  };
}

let t: DaemonEnv;
let clock: FakeClock;
let gh: ReturnType<typeof fakeGitHub>;
let daemon: Daemon;
let client: ControlClient;

const start = () => t.start({ clock, spawner: { host: fakeHost(gh.fake) } });

beforeEach(async () => {
  clock = fakeClock(Date.parse("2026-10-22T09:00:00.000Z"));
  t = await makeDaemonEnv();
  gh = fakeGitHub();
  daemon = await start();
  client = await ControlClient.connect(t.broker.url, NS);
  expect((await client.request("run", { wave_yaml: YAML, owner: OWNER })).error).toBeUndefined();
});
afterEach(async () => {
  await client.close();
  await t.cleanup();
});

const pr = (n: number) => ({
  number: n,
  url: `https://github.com/example-org/example-repo/pull/${n}`,
});

async function merge(task: string, n: number): Promise<void> {
  await daemon.recordEvent(WAVE, {
    type: "artifact_verified",
    task,
    data: { role: "merged", pr: pr(n), head_sha: "a".repeat(40) },
  });
  await daemon.recordEvent(WAVE, {
    type: "stage_entered",
    task,
    data: { stage: "done", merged: true },
  });
}

/** The wave admits nothing (its queued tasks are never spawned); its issue work goes on. */
const pause = async () =>
  expect((await client.request("pause", { wave: WAVE, by: OWNER })).error).toBeUndefined();

const tick = async () => {
  await daemon.tick();
  await daemon.settled();
};

const ofType = (type: string) => daemon.journalEvents(WAVE).filter((e) => e.type === type);

describe("the issue lifecycle in the daemon (#416)", () => {
  it("a task merging into the release branch: labeled and commented once, idempotent across restarts", async () => {
    await pause();
    await merge("T3", 418);
    await tick();
    const i412 = gh.issues.get(412) as Issue;
    expect(gh.labels).toEqual([MERGED_LABEL]);
    expect(i412.labels).toEqual([MERGED_LABEL]);
    expect(i412.comments).toEqual([
      `Merged into \`release/${WAVE}\` in PR #418; closes when the release reaches main.\n\n${mergedMarker(WAVE, 418)}`,
    ]);
    expect(ofType("issue_labeled").map((e) => e.data)).toEqual([
      { issue: 412, label: MERGED_LABEL, pr: 418 },
    ]);
    expect(ofType("issue_commented").map((e) => e.data)).toEqual([
      { issue: 412, marker: mergedMarker(WAVE, 418) },
    ]);
    for (const e of [...ofType("issue_labeled"), ...ofType("issue_commented")])
      expect(
        schemaErrors("wave-event.schema.json", {
          schema_version: "0.1",
          agent_id: "volleyd",
          wall_time: e.at,
          channel: "_waves/events",
          type: e.type,
          payload: { wave: WAVE, seq: e.seq, at: e.at, task: e.task, data: e.data },
        }),
      ).toEqual([]);

    // Again, and after a restart: nothing more is written.
    await tick();
    await daemon.stop();
    daemon = await start();
    await tick();
    expect(gh.fake.argvs(["gh", "issue", "edit"])).toHaveLength(1);
    expect(gh.fake.argvs(["gh", "issue", "comment"])).toHaveLength(1);
    expect(gh.fake.argvs(["gh", "label", "create"])).toHaveLength(1);
    expect(i412.comments).toHaveLength(1);
  });

  it("the release reaching main closes a straggler, removes the label and leaves a cancelled task's issue open", async () => {
    await merge("T3", 418);
    await merge("T5", 420);
    await daemon.recordEvent(WAVE, {
      type: "task_cancelled",
      task: "T4",
      data: { by: OWNER, why: "superseded by T3" },
    });
    await tick();
    expect(daemon.record(WAVE)?.state?.status).toBe("complete");
    // Not released yet: nothing is closed.
    expect(gh.fake.argvs(["gh", "issue", "close"])).toEqual([]);
    expect(gh.fake.argvs(["gh", "pr", "list"])).toHaveLength(1);

    // The release PR merged; T5's issue was closed by its Closes line, T3's was not.
    gh.release(431);
    (gh.issues.get(414) as Issue).state = "CLOSED";
    await tick();
    // Looked for again only after release_merge_poll_ms.
    expect(gh.fake.argvs(["gh", "pr", "list"])).toHaveLength(1);
    await clock.advance(DAEMON_DEFAULTS.release_merge_poll_ms);
    await tick();

    const [i412, i413, i414] = [412, 413, 414].map((n) => gh.issues.get(n) as Issue);
    expect(i412?.state).toBe("CLOSED");
    expect(i412?.comments.at(-1)).toBe(
      `closed by the release PR #431 (wave ${WAVE})\n\n${settledMarker(WAVE, "closed")}`,
    );
    expect(i412?.labels).toEqual([]);
    expect(i414?.labels).toEqual([]);
    expect(gh.fake.argvs(["gh", "issue", "close"]).map((a) => a[3])).toEqual(["412"]);
    expect(i413?.state).toBe("OPEN");
    expect(i413?.comments).toEqual([
      `cancelled in wave ${WAVE}: superseded by T3\n\n${settledMarker(WAVE, "cancelled")}`,
    ]);
    expect(ofType("issues_verified").map((e) => e.data)).toEqual([
      { release_pr: 431, closed: [412], left_open: [413] },
    ]);

    // Verified once: no further looks or writes.
    const lifecycle = () =>
      gh.fake.calls.filter((c) => ["issue", "label", "pr"].includes(c.argv[1] ?? "")).length;
    const calls = lifecycle();
    await clock.advance(DAEMON_DEFAULTS.release_merge_poll_ms);
    await tick();
    expect(lifecycle()).toBe(calls);

    // `volleyd issues <wave>`: one line per task.
    const r = await runCli(["issues", WAVE], t.env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      [
        `${WAVE} (release/${WAVE}): released in PR #431`,
        "T3 #412 closed (PR #418)",
        "T4 #413 cancelled: superseded by T3",
        "T5 #414 closed (PR #420)",
        "",
      ].join("\n"),
    );
  });

  it("a write that failed at the release is retried after ci_poll_ms, not release_merge_poll_ms", async () => {
    await merge("T3", 418);
    await merge("T5", 420);
    await daemon.recordEvent(WAVE, {
      type: "task_cancelled",
      task: "T4",
      data: { by: OWNER, why: "superseded by T3" },
    });
    gh.release(431);
    let fail = true;
    gh.fake.on(["gh", "issue", "close"], (argv) => {
      if (fail) {
        fail = false;
        return { code: 1, stderr: "HTTP 502" };
      }
      const i = gh.issues.get(Number(argv[3])) as Issue;
      i.state = "CLOSED";
      i.comments.push(argv[5] as string);
      return {};
    });
    await tick();
    expect((gh.issues.get(412) as Issue).state).toBe("OPEN");
    expect(ofType("issues_verified")).toEqual([]);
    await clock.advance(DAEMON_DEFAULTS.ci_poll_ms);
    await tick();
    expect(ofType("issues_verified")).toHaveLength(1);
    expect((gh.issues.get(412) as Issue).state).toBe("CLOSED");
  });

  it("an issue gh can never read does not hold the release check back for the others", async () => {
    gh.fake.on(["gh", "issue", "view"], (argv) => {
      if (argv[3] === "413") return { code: 1, stderr: "Could not resolve to an issue" };
      const i = gh.issues.get(Number(argv[3])) as Issue;
      return {
        stdout: JSON.stringify({
          state: i.state,
          labels: i.labels.map((name) => ({ name })),
          comments: i.comments.map((body) => ({ body })),
        }),
      };
    });
    await merge("T3", 418);
    await merge("T4", 419);
    await merge("T5", 420);
    gh.release(431);
    await tick();
    expect(daemon.record(WAVE)?.state?.status).toBe("complete");
    // #413's merged-to-release write failed (not read), yet the others were released.
    expect((gh.issues.get(412) as Issue).state).toBe("CLOSED");
    expect((gh.issues.get(414) as Issue).state).toBe("CLOSED");
    expect((gh.issues.get(412) as Issue).labels).toEqual([]);
    expect(ofType("issues_verified")).toEqual([]);
  });

  it("issues --verify: the check for a release merged by hand, owner only, on a complete wave", async () => {
    await merge("T3", 418);
    const refused = await client.request("issues", { wave: WAVE, verify: true, by: "someone" });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("owned by coord-a");
    // Not complete: tasks still in flight are not settled as if the release had reached main.
    const early = await client.request("issues", { wave: WAVE, verify: true, by: OWNER, pr: 77 });
    expect(early.ok).toBe(false);
    expect(early.error).toContain("not complete");
    expect(ofType("issues_verified")).toEqual([]);

    await merge("T5", 420);
    await daemon.recordEvent(WAVE, {
      type: "task_cancelled",
      task: "T4",
      data: { by: OWNER, why: "superseded by T3" },
    });
    await tick();
    expect(daemon.record(WAVE)?.state?.status).toBe("complete");
    const r = await runCli(["issues", WAVE, "--verify", "--pr", "77", "--by", OWNER], t.env);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`${WAVE} (release/${WAVE}): released in PR #77`);
    expect(r.stdout).toContain("T3 #412 closed (PR #418)");
    expect(r.stdout).toContain("T4 #413 cancelled: superseded by T3");
    expect((gh.issues.get(413) as Issue).comments).toEqual([
      `cancelled in wave ${WAVE}: superseded by T3\n\n${settledMarker(WAVE, "cancelled")}`,
    ]);
    expect((gh.issues.get(413) as Issue).state).toBe("OPEN");
    expect(ofType("issues_verified").map((e) => e.data)).toEqual([
      { release_pr: 77, closed: [412, 414], left_open: [413] },
    ]);
  });

  it("issues: unknown wave; --pr without --verify is a usage error", async () => {
    expect((await client.request("issues", { wave: "nope" })).error).toContain("unknown wave");
    const r = await runCli(["issues", WAVE, "--pr", "3"], t.env);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("--pr goes with --verify");
  });
});
