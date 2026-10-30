import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MachineRepo } from "../src/machines";
import { eventually } from "./helpers/broker-wait";
import { GREEN_DOCTOR } from "./helpers/fake-host";
import { type Fleet, LOCAL, PEER, VERSION, makeFleet } from "./helpers/fleet-env";
import { tempDir } from "./helpers/tmp";

/**
 * A paired machine silent past the bound (#638): the box holds a clone of a running wave's
 * repository and goes down; the wave carries on on the supervisor, and the owner is told once.
 */

const A = "a/a";
const view = (slug: string) =>
  JSON.stringify({ nameWithOwner: slug, url: `https://github.com/${slug}`, visibility: "PUBLIC" });
const ID = `n-machine-down-${PEER}`;

let f: Fleet | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

describe("a silent paired machine (#638)", () => {
  it("opens exactly one owner-only notice past the bound, clears it on the next heartbeat, reopens at the next version", async () => {
    const base = realpathSync(tempDir("volleyd-machine-silent-"));
    const repoRoot = join(base, "managed");
    const localA = join(repoRoot, "a", "a");
    mkdirSync(localA, { recursive: true });
    const fleet = await makeFleet({
      repoRoot,
      boxRepo: null,
      localDoctor: (repo) =>
        repo !== null ? { ...GREEN_DOCTOR, repo: { path: repo, exists: true } } : GREEN_DOCTOR,
    });
    f = fleet;
    fleet.exec
      .on(["gh", "repo", "view", A], { stdout: view(A) })
      .on(["gh", "repo", "view", "--json"], { stdout: view(A) })
      .on(["git", "-C", localA, "rev-parse", "--show-toplevel"], { stdout: `${localA}\n` })
      .on(["git", "-C", localA, "rev-parse", "--verify"], { stdout: `${"1".repeat(40)}\n` })
      .on(["git", "-C", localA, "fetch"], {});
    const clone: MachineRepo = {
      slug: A,
      path: localA,
      exists: true,
      managed: true,
      fetched_at: null,
      toolchain: { ok: true, missing: [], outdated: [] },
    };
    const box = fleet.box();
    if (box !== undefined)
      box.answers.doctor = {
        ...GREEN_DOCTOR,
        versions: { peer: VERSION, volley: VERSION, bun: "1.3.1", git: "2.43.0" },
        repos: [clone],
      };
    expect(await fleet.adminOp({ op: "repo_add", slug: A })).toMatchObject({
      ok: true,
      result: { slug: A, machines: [LOCAL, PEER] },
    });
    await fleet.beat({ repos: [clone] });
    // The wave runs on the supervisor; the box holds its repository.
    await fleet.submit(
      "w1",
      "placement: auto\n",
      "  T1: { issue: 42, host: local }\n",
      undefined,
      A,
    );

    const opened = () =>
      fleet
        .system()
        .filter(
          (e) =>
            e.type === "inbox_opened" && (e.data.item as { id?: string } | undefined)?.id === ID,
        );
    const alarms = (type: string) =>
      fleet.system().filter((e) => e.type === type && e.data.alarm === "machine_silent");

    await fleet.lwt();
    await fleet.tick(60_000);
    expect(opened()).toHaveLength(0);
    for (let i = 0; i < 5; i++) await fleet.tick(60_000);
    await eventually(async () => {
      await fleet.tick(0);
      return opened().length === 1;
    });
    const item = (await fleet.env.retained(`volley/_inbox/${ID}`)) as {
      payload: { owner_only: boolean; title: string; question: string; version: number };
    } | null;
    expect(item?.payload).toMatchObject({ owner_only: true, version: 1 });
    expect(item?.payload.title).toContain(PEER);
    expect(item?.payload.question).toContain("systemctl --user restart volley-peer.service");
    expect(item?.payload.question).toContain("w1");
    expect(alarms("alarm_raised")).toHaveLength(1);
    expect(alarms("alarm_raised")[0]?.data).toMatchObject({ host: PEER, waves: ["w1"] });

    // Further ticks open nothing.
    for (let i = 0; i < 3; i++) await fleet.tick(60_000);
    expect(opened()).toHaveLength(1);
    expect(alarms("alarm_raised")).toHaveLength(1);

    // The heartbeat resumes: superseded, alarm cleared.
    await fleet.beat({ repos: [clone] });
    await eventually(async () => {
      await fleet.tick(0);
      return alarms("alarm_cleared").length === 1;
    });
    const answered = fleet.system().filter((e) => e.type === "inbox_answered" && e.data.id === ID);
    expect(answered).toHaveLength(1);
    expect(answered[0]?.data).toMatchObject({ answer: "superseded" });
    expect(alarms("alarm_cleared")[0]?.data.message).toBe(`${PEER} is back`);

    // A second outage past the bound: the same id at the version after the answered one.
    await fleet.lwt();
    for (let i = 0; i < 6; i++) await fleet.tick(60_000);
    await eventually(async () => {
      await fleet.tick(0);
      return opened().length === 2;
    });
    const again = (await fleet.env.retained(`volley/_inbox/${ID}`)) as {
      type: string;
      payload: { version: number; answered?: unknown };
    } | null;
    expect(again?.type).toBe("inbox_item");
    expect(again?.payload.answered).toBeUndefined();
    expect(again?.payload.version).toBe((answered[0]?.data.version as number) + 1);
    expect(alarms("alarm_raised")).toHaveLength(2);
  });
});
