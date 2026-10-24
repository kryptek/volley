import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { ControlClient } from "../src/control";
import { readJournalFile } from "../src/journal";
import { MACHINE_CHANNEL, type MachineRecord, machineTopic } from "../src/machines";
import { SYSTEM_WAVE } from "../src/types";
import { eventually } from "./helpers/broker-wait";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { fakeClock } from "./helpers/fake-clock";
import { memoryCredentials } from "./helpers/fake-dynsec";
import { fakeExec } from "./helpers/fake-exec";
import { fakeHost } from "./helpers/fake-host";
import { runCli } from "./helpers/run-cli";
import { tempDir } from "./helpers/tmp";

const yaml = (wave: string, repo: string) => `wave: ${wave}
repo: ${repo}
release_branch: release/${wave}
model: claude-opus-5-5
pipeline: [implement, merge_ready]
tasks:
  A: { issue: 1 }
`;

describe("a wave file's repo: as an owner/name slug (D9)", () => {
  let env: DaemonEnv;
  let client: ControlClient;
  let root: string;

  beforeEach(async () => {
    env = await makeDaemonEnv();
    root = tempDir("volleyd-repo-root-");
    writeFileSync(
      join(env.home, "config.yaml"),
      `fleet:\n  local_name: control\n  repo_root: ${root}\nrepos:\n  Example-Org/Widgets: { machines: all }\n`,
    );
    await env.start();
    client = await ControlClient.connect(env.broker.url, NS);
  });
  afterEach(async () => {
    await client.close();
    await env.cleanup();
  });

  it("submits with repo = the supervisor's managed clone", async () => {
    const r = await client.request("run", { wave_yaml: yaml("w-slug", "example-org/widgets") });
    expect(r.error).toBeUndefined();
    await eventually(async () => {
      const s = (await env.retained("volley/_waves/w-slug/state")) as {
        payload?: { repo?: string };
      } | null;
      return s?.payload?.repo !== undefined;
    });
    const s = (await env.retained("volley/_waves/w-slug/state")) as { payload: { repo: string } };
    expect(s.payload.repo).toBe(join(root, "Example-Org/Widgets"));
  });

  it("volleyd run prints the repo: line naming the clone", async () => {
    const file = join(env.home, "w-cli.yaml");
    writeFileSync(file, yaml("w-cli", "example-org/widgets"));
    const r = await runCli(["run", file], env.env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      `repo: example-org/widgets → ${join(root, "Example-Org/Widgets")} (this machine's clone)\n`,
    );
  });

  it("refuses an unknown slug, naming volley repo add", async () => {
    const r = await client.request("run", { wave_yaml: yaml("w-unknown", "someone/else") });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(
      "repo: no clone of someone/else on any machine: add it to one (Settings → Repositories, or volley repo add someone/else --machine control)",
    );
  });
});

/** A paired box, the only machine config gives b/b. */
const BOX_ONLY =
  "fleet:\n  local_name: control\nhosts:\n  box:\n    target: dev@box\n    volley_dir: /opt/volley\n    tunnel: { remote_port: 21883, supervise: false }\nrepos:\n  b/b: { machines: [box] }\n";

describe("a wave file's repo: naming a repository only paired machines hold (#448)", () => {
  let env: DaemonEnv;
  let client: ControlClient;

  beforeEach(async () => {
    env = await makeDaemonEnv();
    writeFileSync(join(env.home, "config.yaml"), BOX_ONLY);
    await env.start();
    client = await ControlClient.connect(env.broker.url, NS);
  });
  afterEach(async () => {
    await client.close();
    await env.cleanup();
  });

  const autoYaml = (wave: string, repo: string, task = "{ issue: 1 }") =>
    yaml(wave, repo).replace(
      "tasks:\n  A: { issue: 1 }\n",
      `placement: auto\ntasks:\n  A: ${task}\n`,
    );

  it("accepts it, keeping repo as the owner/name", async () => {
    const r = await client.request("run", { wave_yaml: autoYaml("w-box", "b/b") });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    await eventually(async () => {
      const s = (await env.retained("volley/_waves/w-box/state")) as {
        payload?: { repo?: string };
      } | null;
      return s?.payload?.repo !== undefined;
    });
    const s = (await env.retained("volley/_waves/w-box/state")) as { payload: { repo: string } };
    expect(s.payload.repo).toBe("b/b");
  });

  it("volleyd run prints the repo: line", async () => {
    const file = join(env.home, "w-cli.yaml");
    writeFileSync(file, autoYaml("w-cli", "b/b"));
    const r = await runCli(["run", file], env.env);
    expect(r.stderr).not.toContain("volleyd run:");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "repo: b/b (no clone on this machine; its tasks run on the machines that hold it)\n",
    );
  });

  it("refuses a slug no machine holds, naming the paired machine", async () => {
    const r = await client.request("run", { wave_yaml: autoYaml("w-else", "someone/else") });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(
      "repo: no clone of someone/else on any machine: add it to one (Settings → Repositories, or volley repo add someone/else --machine box)",
    );
  });

  it("refuses a task pinned to the supervisor's machine, with placement: auto first", async () => {
    const r = await client.request("run", {
      wave_yaml: autoYaml("w-pinned", "b/b", "{ issue: 1, host: local }"),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(
      "tasks.A.host: no clone of b/b on control: set placement: auto so it runs on box, or add the clone (volley repo add b/b --machine control)",
    );
  });
});

describe("the legacy hosts.<name>.repo migrates when its record reports the origin (D10)", () => {
  let env: DaemonEnv;
  let peer: VolleyBroker;
  const CONFIG =
    "fleet:\n  local_name: control\nhosts:\n  box:\n    target: dev@box\n    repo: /srv/work/widgets\n    volley_dir: /opt/volley\n    tunnel: { remote_port: 21883, supervise: false }\n";
  const record = (repo?: MachineRecord["repo"]): MachineRecord => ({
    name: "box",
    os: "linux",
    cores: 8,
    tunnel: "up",
    load: [0.5, 0.4, 0.3],
    agents: 0,
    last_seen: "2026-10-19T09:00:00.000Z",
    ...(repo !== undefined ? { repo } : {}),
  });
  const beat = (r: MachineRecord) =>
    peer.publish(
      machineTopic("box"),
      JSON.stringify(
        buildEnvelope({
          agentId: "box",
          parentId: null,
          channel: MACHINE_CHANNEL,
          type: "machine",
          payload: r,
        }),
      ),
      { qos: 1, retain: true },
    );
  const changes = () =>
    readJournalFile(join(env.home, "waves", SYSTEM_WAVE, "journal.jsonl")).filter(
      (e) => e.type === "config_changed",
    );
  const configYaml = () => readFileSync(join(env.home, "config.yaml"), "utf-8");

  beforeEach(async () => {
    env = await makeDaemonEnv();
    writeFileSync(join(env.home, "config.yaml"), CONFIG);
    await env.start({ spawner: { host: fakeHost(), credentials: memoryCredentials() } });
    peer = new VolleyBroker();
    await peer.connect({ url: env.broker.url, agentId: "box" });
  });
  afterEach(async () => {
    await peer.disconnect();
    await env.cleanup();
  });

  it("a record with the clone's origin migrates once; later beats change nothing", async () => {
    await beat(
      record({ path: "/srv/work/widgets", exists: true, origin: "github.com/example-org/widgets" }),
    );
    await eventually(async () => changes().length === 1);
    expect(configYaml()).not.toMatch(/^\s+repo: /m);
    expect(configYaml()).toContain("example-org/widgets: /srv/work/widgets");
    await beat({
      ...record({
        path: "/srv/work/widgets",
        exists: true,
        origin: "github.com/example-org/widgets",
      }),
      last_seen: "2026-10-19T09:01:00.000Z",
    });
    // The second beat is folded (its readiness republished) without another change.
    await eventually(async () => {
      const r = (await env.retained(`${machineTopic("box")}/readiness`)) as unknown;
      return r !== null;
    });
    expect(changes()).toHaveLength(1);
  });

  it("a record without an origin, or for another path, leaves the host alone", async () => {
    await beat(record());
    await beat({
      ...record({ path: "/elsewhere", exists: true, origin: "github.com/o/r" }),
      last_seen: "2026-10-19T09:02:00.000Z",
    });
    await eventually(async () => {
      const r = (await env.retained(`${machineTopic("box")}/readiness`)) as unknown;
      return r !== null;
    });
    expect(changes()).toHaveLength(0);
    expect(configYaml()).toBe(CONFIG);
  });
});

describe("a wave the supervisor holds no clone of runs its gh work with --repo (#448)", () => {
  let env: DaemonEnv;
  let client: ControlClient;
  afterEach(async () => {
    await client.close();
    await env.cleanup();
  });

  it("the issue lifecycle's reads and writes name the repository; none runs in a checkout", async () => {
    env = await makeDaemonEnv();
    writeFileSync(join(env.home, "config.yaml"), BOX_ONLY);
    const labels: string[] = [];
    const fake = fakeExec()
      .on(["gh", "repo", "view", "b/b"], {
        stdout: JSON.stringify({
          nameWithOwner: "b/b",
          url: "https://github.com/b/b",
          visibility: "PRIVATE",
        }),
      })
      .on(["gh", "issue", "view"], {
        stdout: JSON.stringify({ state: "OPEN", labels: [], comments: [] }),
      })
      .on(["gh", "label", "list"], () => ({
        stdout: JSON.stringify(labels.map((name) => ({ name }))),
      }))
      .on(["gh", "label", "create"], (argv) => {
        labels.push(argv[3] as string);
        return {};
      })
      .on(["gh", "issue", "edit"], {})
      .on(["gh", "issue", "comment"], {});
    const daemon = await env.start({
      clock: fakeClock(Date.parse("2026-10-24T09:00:00.000Z")),
      spawner: { host: fakeHost(fake) },
    });
    client = await ControlClient.connect(env.broker.url, NS);
    const wave = yaml("w-gh", "b/b").replace("tasks:", "placement: auto\ntasks:");
    expect((await client.request("run", { wave_yaml: wave, owner: "coord-a" })).error).toBe(
      undefined,
    );
    expect((await client.request("pause", { wave: "w-gh", by: "coord-a" })).error).toBeUndefined();
    await daemon.recordEvent("w-gh", {
      type: "artifact_verified",
      task: "A",
      data: {
        role: "merged",
        pr: { number: 7, url: "https://github.com/b/b/pull/7" },
        head_sha: "a".repeat(40),
      },
    });
    await daemon.recordEvent("w-gh", {
      type: "stage_entered",
      task: "A",
      data: { stage: "done", merged: true },
    });
    await daemon.tick();
    await daemon.settled();

    const ghCalls = fake.calls.filter((c) => c.argv[0] === "gh");
    for (const verb of [
      ["gh", "issue", "view", "1"],
      ["gh", "label", "list"],
      ["gh", "label", "create"],
      ["gh", "issue", "edit", "1"],
      ["gh", "issue", "comment", "1"],
    ]) {
      const c = ghCalls.find((x) => verb.every((v, i) => x.argv[i] === v));
      expect(c?.argv.slice(-2), verb.join(" ")).toEqual(["--repo", "b/b"]);
      expect(c?.opts?.cwd, verb.join(" ")).toBeUndefined();
    }
    // Its visibility was read by name: the state names the repository, no alarm.
    expect(fake.argvs(["gh", "repo", "view", "--json"])).toEqual([]);
    const events = readJournalFile(join(env.home, "waves", "w-gh", "journal.jsonl"));
    expect(events.some((e) => e.data?.alarm === "repo_visibility_unknown")).toBe(false);
    expect(events.find((e) => e.type === "repo_visibility_detected")?.data).toMatchObject({
      visibility: "private",
      github: { slug: "b/b" },
    });
  });
});
