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
import { memoryCredentials } from "./helpers/fake-dynsec";
import { fakeHost } from "./helpers/fake-host";
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

  it("refuses an unknown slug, naming volley repo add", async () => {
    const r = await client.request("run", { wave_yaml: yaml("w-unknown", "someone/else") });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(
      "repo: no clone of someone/else on control: add it (Settings → Repositories, or volley repo add someone/else --machine control)",
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
