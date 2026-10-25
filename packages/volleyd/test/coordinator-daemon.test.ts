import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COORDINATOR_TOPIC } from "../src/control";
import {
  type CoordinatorRolePayload,
  coordinatorSession,
  renderCoordinatorScript,
} from "../src/coordinator/role";
import type { RemoteStep } from "../src/fence";
import { eventually } from "./helpers/broker-wait";
import { fakeExec } from "./helpers/fake-exec";
import { type Fleet, PEER, makeFleet } from "./helpers/fleet-env";
import { runCli } from "./helpers/run-cli";
import { schemaErrors } from "./helpers/schema";
import { tempDir } from "./helpers/tmp";

const BANNER = readFileSync(
  new URL("./fixtures/remote-control-banner.txt", import.meta.url),
  "utf-8",
);
const LINK = "https://claude.ai/code/session_01FAKEFAKEFAKEFAKEFAKE0000";
const HOME = "/path/to/home";
const SESSION = coordinatorSession("coord-test");
const LOGIN = `${JSON.stringify({ username: "coordinator", password: "pw-coordinator" })}\n`;

let fleet: Fleet | undefined;
afterEach(async () => {
  await fleet?.close();
  fleet = undefined;
});

/** A fleet whose setup recorded the coordinator `coord-test`, and whose box answers its steps. */
async function coordinatorFleet(o: { exec?: ReturnType<typeof fakeExec>; home?: string } = {}) {
  const f = await makeFleet();
  fleet = f;
  writeFileSync(
    join(f.env.home, "setup.json"),
    JSON.stringify({
      layout: "brew-arm64",
      config: "/path/to/mosquitto.conf",
      state_file: "/path/to/dynamic-security.json",
      auth_dir: "/path/to/auth",
      coordinator: "coord-test",
    }),
  );
  const steps: RemoteStep[] = [];
  f.exec.on(["ssh", "-T"], (_argv, opts) => {
    let out = "";
    for (const s of opts.remote?.steps ?? []) {
      steps.push(s);
      if (s.argv[0] === "printenv" && s.argv[1] === "HOME") out += `${HOME}\n`;
      // The box's tmux: a killed session no longer answers has-session.
      if (s.argv[1] === "kill-session") delete f.box()?.workspaceTitles[SESSION];
    }
    return { stdout: out };
  });
  const options = f.options;
  if (options === undefined) throw new Error("no daemon options");
  options.coordinator = {
    login: () => LOGIN,
    ...(o.exec !== undefined ? { exec: o.exec.exec } : {}),
    ...(o.home !== undefined ? { home: o.home } : {}),
  };
  await f.restart();
  const box = f.box();
  if (box === undefined) throw new Error("no box host");
  // The box's tmux: the coordinator's session answers has-session once launched.
  box.onLaunch = (spec) => {
    box.workspaceTitles[spec.name] = spec.name;
  };
  box.screens = [BANNER];
  const topic = async () =>
    ((await f.env.retained(COORDINATOR_TOPIC)) as { payload: CoordinatorRolePayload } | null)
      ?.payload ?? null;
  const set = (patch: Record<string, unknown>) =>
    f.client.request("config_set", { patch, by: "tester" }, { text: "test config_set" });
  return { f, box, steps, topic, set };
}

describe("the coordinator role in the daemon (SPEC §4.6.25)", () => {
  it("off by default: nothing runs, the topic is empty", async () => {
    const { f, box, topic } = await coordinatorFleet();
    await f.tick();
    expect(box.launches).toEqual([]);
    expect(await topic()).toBeNull();
  });

  it("coordinator.machine: box — prepared, launched, running with its link; status line; ops; null clears", async () => {
    const { f, box, steps, topic, set } = await coordinatorFleet();
    const r = await set({ coordinator: { machine: PEER } });
    expect(r.ok).toBe(true);
    await f.tick();
    const dir = `${HOME}/.volley/coordinator`;
    const script = steps.find((s) => s.stdout === `${dir}/.volley/coordinator.sh`);
    expect(Buffer.from(script?.stdin ?? "", "base64").toString("utf-8")).toBe(
      renderCoordinatorScript({
        dir,
        name: "coord-test",
        namespace: "volleyd-test",
        brokerPort: 21883,
        hooksDir: "/opt/volley/packages/volley-hooks",
        binDir: `${HOME}/.volley/bin`,
        capacity: 4,
        permissionMode: "acceptEdits",
        continueGraceS: 10,
      }),
    );
    expect(box.launches.map((l) => [l.name, l.cwd, l.command])).toEqual([
      [SESSION, dir, "bash .volley/coordinator.sh"],
    ]);
    expect(box.launches[0]?.coordinator).toBeDefined();
    // starting (published at the launch), then running once its screen shows the link.
    await f.tick();
    await eventually(async () => (await topic())?.state === "running");
    const p = await topic();
    expect(p).toMatchObject({ machine: PEER, name: "coord-test", session_url: LINK, restarts: 0 });
    expect(
      schemaErrors("coordinator-role.schema.json", await f.env.retained(COORDINATOR_TOPIC)),
    ).toEqual([]);

    const status = await runCli(["status"], f.env.env);
    expect(status.stdout).toContain(`coordinator: coord-test on ${PEER}: running since`);
    expect(status.stdout).toContain(LINK);

    // The read on the mailbox; restart is an admin op only.
    const read = await f.client.request("coordinator_status", {});
    expect(read.result).toMatchObject({ state: "running" });
    const mailbox = await f.client.request("coordinator_restart", {});
    expect(mailbox.ok).toBe(false);
    const restart = await f.adminOp({ op: "coordinator_restart" });
    expect(restart).toMatchObject({ ok: true });
    expect(steps.filter((s) => s.argv[1] === "kill-session")).toHaveLength(1);
    expect(box.launches).toHaveLength(2);

    expect((await set({ coordinator: { machine: null } })).ok).toBe(true);
    await f.tick();
    expect(steps.filter((s) => s.argv[1] === "kill-session")).toHaveLength(2);
    await eventually(async () => (await topic()) === null);
  });

  it("a laptop is refused unless allow_laptop", async () => {
    const { f, set } = await coordinatorFleet();
    await f.beat({ laptop: true });
    const refused = await set({ coordinator: { machine: PEER } });
    expect(refused.ok).toBe(false);
    expect(refused.rejected).toEqual([
      {
        path: "coordinator.machine",
        reason: `${PEER} is a laptop: it sleeps and travels; set coordinator.allow_laptop: true to host the coordinator there anyway`,
      },
    ]);
    const allowed = await set({ coordinator: { machine: PEER, allow_laptop: true } });
    expect(allowed.ok).toBe(true);
  });

  it("machine: local runs through the local tmux adapter under the same fence shapes", async () => {
    const home = realpathSync(tempDir("volleyd-coord-home-"));
    let alive = false;
    const exec = fakeExec()
      .on(["tmux", "new-session"], () => {
        alive = true;
        return {};
      })
      .on(["tmux", "has-session"], () => (alive ? {} : { code: 1 }))
      .on(["tmux", "capture-pane"], { stdout: BANNER });
    const { f, topic, set } = await coordinatorFleet({ exec, home });
    expect((await set({ coordinator: { machine: "local" } })).ok).toBe(true);
    await f.tick();
    const dir = join(home, ".volley", "coordinator");
    expect(exec.argvs(["tmux", "new-session"])).toEqual([
      ["tmux", "new-session", "-d", "-s", SESSION, "-c", dir, "bash .volley/coordinator.sh"],
    ]);
    await f.tick();
    await eventually(async () => (await topic())?.session_url === LINK);
    expect(await topic()).toMatchObject({ machine: "local", state: "running", dir });
  });
});
