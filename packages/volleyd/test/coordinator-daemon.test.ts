import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { registryTopic } from "volley-mcp/topics";
import type { InboxItem } from "../src/autopilot/inbox";
import { COORDINATOR_TOPIC } from "../src/control";
import {
  type CoordinatorRolePayload,
  coordinatorSession,
  renderCoordinatorScript,
} from "../src/coordinator/role";
import type { RemoteStep } from "../src/fence";
import { eventually } from "./helpers/broker-wait";
import { NS } from "./helpers/daemon-env";
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
const clients: VolleyBroker[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
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

describe("the coordinator role's entry points (SPEC §4.6.25)", () => {
  const opened = (f: Fleet, id: string) =>
    f
      .system()
      .filter((e) => e.type === "inbox_opened" && (e.data.item as InboxItem).id === id)
      .map((e) => e.data.item as InboxItem);
  const answered = (f: Fleet, id: string) =>
    f.system().filter((e) => e.type === "inbox_answered" && e.data.id === id);

  it("a new link opens the owner-only n-coordinator-link notice; the next link supersedes it", async () => {
    const { f, box, topic, set } = await coordinatorFleet();
    expect((await set({ coordinator: { machine: PEER } })).ok).toBe(true);
    await f.tick();
    await f.tick();
    await eventually(async () => (await topic())?.session_url === LINK);
    await eventually(() => opened(f, "n-coordinator-link").length === 1);
    const [first] = opened(f, "n-coordinator-link");
    expect(first).toMatchObject({
      kind: "notice",
      version: 1,
      owner_only: true,
      title: `Coordinator on ${PEER}: open it`,
      question: LINK,
      pointers: { link: LINK },
    });
    // A republish of the same link (a heartbeat-like tick) opens nothing more.
    await f.tick();
    expect(opened(f, "n-coordinator-link")).toHaveLength(1);

    const LINK2 = LINK.replace(/0000$/, "0001");
    box.screens = [BANNER.replaceAll(LINK, LINK2)];
    expect(await f.adminOp({ op: "coordinator_restart" })).toMatchObject({ ok: true });
    await f.tick();
    await eventually(async () => (await topic())?.session_url === LINK2);
    await eventually(() => opened(f, "n-coordinator-link").length === 2);
    expect(answered(f, "n-coordinator-link")).toMatchObject([
      { data: { answer: "superseded", by: "volleyd", where: { kind: "autopilot" }, version: 2 } },
    ]);
    expect(opened(f, "n-coordinator-link")[1]).toMatchObject({
      version: 3,
      pointers: { link: LINK2 },
    });
    expect(f.daemon.inboxItem("n-coordinator-link")?.answered).toBeUndefined();
  });

  it("failed opens n-coordinator-failed with the last error", async () => {
    const { f, box, topic, set } = await coordinatorFleet();
    const r = await set({ coordinator: { machine: PEER, restart_backoff_s: [1, 1, 1] } });
    expect(r.ok).toBe(true);
    await f.tick();
    await f.tick();
    await eventually(async () => (await topic())?.state === "running");
    // Every start dies at once: three quick deaths are failed.
    box.onLaunch = () => {};
    box.screens = ["Error: something broke\n"];
    delete box.workspaceTitles[SESSION];
    for (let i = 0; i < 20 && (await topic())?.state !== "failed"; i++) await f.tick(1000);
    expect((await topic())?.state).toBe("failed");
    await eventually(() => opened(f, "n-coordinator-failed").length === 1);
    expect(opened(f, "n-coordinator-failed")[0]).toMatchObject({
      owner_only: true,
      title: `Coordinator on ${PEER} stopped`,
    });
    expect(opened(f, "n-coordinator-failed")[0]?.question).toContain("volley coordinator restart");
    expect(answered(f, "n-coordinator-link")).toMatchObject([{ data: { answer: "superseded" } }]);
  });

  it("a fresh coordinator session gets the handoff text once; the next names the previous", async () => {
    const { f, topic, set } = await coordinatorFleet();
    expect((await set({ coordinator: { machine: PEER } })).ok).toBe(true);
    await f.tick();
    await f.tick();
    await eventually(async () => (await topic())?.state === "running");
    const dir = (await topic())?.dir as string;
    const texts: Record<string, string[]> = {};
    const session = async (id: string) => {
      const c = new VolleyBroker();
      await c.connect({ url: f.env.broker.url, agentId: id });
      clients.push(c);
      texts[id] = [];
      await c.subscribeStream(`volley/${NS}/${id}/mailbox`, ({ payload }) => {
        const env = parseEnvelope(payload);
        if (env?.type === "steering") texts[id]?.push((env.payload as { text: string }).text);
      });
      const register = () =>
        c.publish(
          registryTopic(id),
          JSON.stringify({
            ...buildEnvelope({
              agentId: id,
              parentId: null,
              channel: "_system/registry",
              type: "registered",
              payload: {
                capabilities: [],
                cwd: dir,
                started_at: new Date().toISOString(),
                coordinator: "coord-test",
                model_source: "harness-hook",
              },
            }),
            namespace: NS,
          }),
          { qos: 1, retain: true },
        );
      return { register };
    };
    const a = await session("coordinator-ab12");
    await a.register();
    await eventually(() => texts["coordinator-ab12"]?.length === 1);
    const first = texts["coordinator-ab12"]?.[0] ?? "";
    expect(first).toContain(
      `You are the coordinator \`coord-test\` of this Volley fleet, running on \`${PEER}\` in \`${dir}\``,
    );
    expect(first).toContain("Open needs-you items: `n-coordinator-link` Coordinator on");
    expect(first).not.toContain("previous coordinator session");
    // The same entry again sends nothing.
    await a.register();
    await f.tick();
    expect(texts["coordinator-ab12"]).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(f.env.home, "coordinator-sessions.json"), "utf-8")),
    ).toEqual({ sessions: ["coordinator-ab12"] });

    const b = await session("coordinator-cd34");
    await b.register();
    await eventually(() => texts["coordinator-cd34"]?.length === 1);
    expect(texts["coordinator-cd34"]?.[0]).toContain(
      "The previous coordinator session was `coordinator-ab12`",
    );
  });

  it("a notice is answered open or dismiss only", async () => {
    const { f, topic, set } = await coordinatorFleet();
    expect((await set({ coordinator: { machine: PEER } })).ok).toBe(true);
    await f.tick();
    await f.tick();
    await eventually(async () => (await topic())?.session_url === LINK);
    await eventually(() => f.daemon.inboxItem("n-coordinator-link") !== undefined);
    const where = { kind: "desk" as const, device: "phone" };
    const bad = await f.daemon.answerInboxItem("n-coordinator-link", {
      version: 1,
      answer: "maybe",
      by: "owner",
      where,
      desk_login: true,
    });
    expect(bad).toEqual({ refused: "a notice is answered open or dismiss, not 'maybe'" });
    const ok = await f.daemon.answerInboxItem("n-coordinator-link", {
      version: 1,
      answer: "dismiss",
      by: "owner",
      where,
      desk_login: true,
    });
    expect("item" in ok && ok.item.answered?.answer).toBe("dismiss");
  });

  it("a notice is the owner's: a wave worker on the mailbox is refused, the coordinator name answers", async () => {
    const { f, topic, set } = await coordinatorFleet();
    expect((await set({ coordinator: { machine: PEER } })).ok).toBe(true);
    await f.tick();
    await f.tick();
    await eventually(async () => (await topic())?.session_url === LINK);
    await eventually(() => f.daemon.inboxItem("n-coordinator-link") !== undefined);
    const where = { kind: "terminal" as const };
    const worker = await f.daemon.answerInboxItem("n-coordinator-link", {
      version: 1,
      answer: "dismiss",
      by: "w1-implementer-1",
      where,
    });
    expect(worker).toEqual({
      refused:
        "inbox item 'n-coordinator-link' is coord-test's own: only its owner answers it, not w1-implementer-1",
    });
    expect(f.daemon.inboxItem("n-coordinator-link")?.answered).toBeUndefined();
    const owner = await f.daemon.answerInboxItem("n-coordinator-link", {
      version: 1,
      answer: "open",
      by: "coord-test",
      where,
    });
    expect("item" in owner && owner.item.answered?.answer).toBe("open");
  });
});
