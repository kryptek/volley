import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { COORDINATOR_TOPIC } from "volleyd/coordinator/role";
import {
  type CoordinatorDeps,
  realCoordinatorDeps,
  runCoordinator,
} from "../../src/commands/coordinator";
import type { Answer } from "../../src/commands/peer";
import { EXIT } from "../../src/exit-codes";
import { makeBufferIO } from "../../src/io";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";
import { tempDir } from "../helpers/tmp";

/** `volley coordinator` (SPEC §4.6.25): the retained topic read, and the admin ops. */

const LINK = "https://claude.ai/code/session_01FAKEFAKEFAKEFAKEFAKE0000";
const RUNNING = {
  machine: "box-a",
  name: "coord-test",
  state: "running",
  since: "2026-10-24T12:00:05.000Z",
  session_url: LINK,
  restarts: 0,
  dir: "/path/to/home/.volley/coordinator",
};

let tb: TestBroker;
beforeEach(async () => {
  tb = await startTestBroker();
});
afterEach(async () => {
  await tb.close();
});

async function retain(payload: Record<string, unknown> | null) {
  const b = new VolleyBroker();
  await b.connect({ url: tb.url, agentId: "volleyd" });
  await b.publish(
    COORDINATOR_TOPIC,
    payload === null
      ? ""
      : JSON.stringify(
          buildEnvelope({
            agentId: "volleyd",
            parentId: null,
            channel: "_system/federation",
            type: "coordinator",
            payload,
          }),
        ),
    { qos: 1, retain: true },
  );
  await b.disconnect();
}

/** The real topic read against the test broker; the ops answered by a fake volleyd. */
function deps(answer: (op: string) => Answer | number = () => ({ ok: true, result: RUNNING })) {
  const asked: { op: string; admin: boolean }[] = [];
  const opened: string[] = [];
  const d: CoordinatorDeps = {
    ...realCoordinatorDeps(),
    ask: async (_cmd, op, _fields, _v, _env, _io, admin) => {
      asked.push({ op, admin });
      return answer(op) as Answer;
    },
    open: async (url) => {
      opened.push(url);
      return true;
    },
  };
  return { d, asked, opened };
}

async function run(argv: string[], d: CoordinatorDeps) {
  const io = makeBufferIO();
  const exitCode = await runCoordinator({ argv, env: { VOLLEY_BROKER_URL: tb.url }, io }, d);
  return { exitCode, stdout: io.readStdout(), stderr: io.readStderr() };
}

describe("volley coordinator", () => {
  it("status prints where it runs, its state, since when and its link", async () => {
    await retain(RUNNING);
    const r = await run(["status"], deps().d);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.stdout).toBe(
      `coord-test on box-a: running since 2026-10-24T12:00:05.000Z · ${LINK}\n`,
    );
    const j = await run(["status", "--json"], deps().d);
    expect(JSON.parse(j.stdout)).toEqual(RUNNING);
  });

  it("status with the role off says so", async () => {
    const r = await run(["status"], deps().d);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.stdout).toContain("the coordinator role is off");
  });

  it("open prints the link (exit 0); --browser opens it", async () => {
    await retain(RUNNING);
    const { d, opened } = deps();
    const r = await run(["open"], d);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.stdout).toBe(`${LINK}\n`);
    expect(opened).toEqual([]);
    const b = await run(["open", "--browser"], d);
    expect(b.exitCode).toBe(EXIT.OK);
    expect(opened).toEqual([LINK]);
  });

  it("open with no link yet: the Claude-app line, exit 1", async () => {
    const { session_url: _u, ...noLink } = RUNNING;
    await retain(noLink);
    const r = await run(["open"], deps().d);
    expect(r.exitCode).toBe(EXIT.ERROR);
    expect(r.stderr).toBe('no link yet: open the Claude app and pick "coord-test"\n');
  });

  it("restart and stop are admin ops", async () => {
    const { d, asked } = deps((op) => ({
      ok: true,
      result: { ...RUNNING, state: op === "coordinator_stop" ? "stopped" : "starting" },
    }));
    const r = await run(["restart"], d);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.stdout).toContain("coord-test on box-a: starting since");
    const s = await run(["stop"], d);
    expect(s.exitCode).toBe(EXIT.OK);
    expect(s.stdout).toContain("stopped");
    expect(asked).toEqual([
      { op: "coordinator_restart", admin: true },
      { op: "coordinator_stop", admin: true },
    ]);
  });

  it("an unknown verb is a usage error", async () => {
    const r = await run(["move"], deps().d);
    expect(r.exitCode).toBe(EXIT.USAGE);
  });

  it("a dead broker: the unreachable diagnosis and exit 69, not the old BROKER_DOWN", async () => {
    const root = tempDir("volley-coord-reach-");
    const io = makeBufferIO();
    const exitCode = await runCoordinator(
      {
        argv: ["status"],
        env: {
          VOLLEY_BROKER_URL: "mqtt://127.0.0.1:1",
          HOME: join(root, "home"),
          VOLLEYD_HOME: join(root, "volleyd"),
        },
        io,
      },
      deps().d,
    );
    expect(exitCode).toBe(EXIT.SUPERVISOR_UNREACHABLE);
    expect(io.readStderr()).toMatch(
      /^volley coordinator: supervisor unreachable \(no_broker_here\): /,
    );
  });

  it("status --json with a dead broker: the SUPERVISOR_UNREACHABLE object on stdout", async () => {
    const root = tempDir("volley-coord-reach-");
    const io = makeBufferIO();
    const exitCode = await runCoordinator(
      {
        argv: ["status", "--json"],
        env: {
          VOLLEY_BROKER_URL: "mqtt://127.0.0.1:1",
          HOME: join(root, "home"),
          VOLLEYD_HOME: join(root, "volleyd"),
        },
        io,
      },
      deps().d,
    );
    expect(exitCode).toBe(EXIT.SUPERVISOR_UNREACHABLE);
    expect(JSON.parse(io.readStdout())).toMatchObject({ error: "SUPERVISOR_UNREACHABLE" });
  });
});
