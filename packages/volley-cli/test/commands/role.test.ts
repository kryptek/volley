import { constants, createPublicKey, publicEncrypt } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { runRole } from "../../src/commands/role";
import { makeBufferIO } from "../../src/io";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";
import { runCli } from "../helpers/run-cli";
import { tempDir } from "../helpers/tmp";

const RECORD = {
  broker: {
    machine: "box-a",
    address: { ssh: "owner@box-a.lan", mqtt_port: 1883, ws_port: 9001 },
    lan: true,
  },
  supervisor: { machine: "mac" },
  desk: { machine: "mac", url: "http://192.0.2.20:5199" },
  version: 2,
  updated_at: "2026-10-24T09:00:00.000Z",
  updated_by: "admin-1",
};

describe("volley role status", () => {
  let tb: TestBroker;
  let pub: VolleyBroker;
  const publishRoles = (agentId = "volleyd", payload: unknown = RECORD) =>
    pub.publish(
      "volley/_system/roles",
      JSON.stringify(
        buildEnvelope({
          agentId,
          parentId: null,
          channel: "_system/roles",
          type: "roles",
          payload,
        }),
      ),
      { qos: 1, retain: true },
    );
  const run = (...extra: string[]) =>
    runCli({ argv: ["role", "status", "--broker-url", tb.url, "--timeout", "1", ...extra] });

  beforeEach(async () => {
    tb = await startTestBroker();
    pub = new VolleyBroker();
    await pub.connect({ url: tb.url, agentId: "volleyd" });
  });
  afterEach(async () => {
    await pub.disconnect();
    await tb.close();
  });

  it("prints one line per role from the retained record", async () => {
    await publishRoles();
    const r = await run();
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      [
        "broker      on box-a",
        "supervisor  on mac",
        "desk        on mac (http://192.0.2.20:5199)",
        "",
      ].join("\n"),
    );
  });

  it("--json prints the record's payload", async () => {
    await publishRoles();
    const r = await run("--json");
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(RECORD);
  });

  it("no record: exit 1, is volleyd running?", async () => {
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("volley role: no roles record: is volleyd running?\n");
  });

  it("a record not published by volleyd is no record", async () => {
    await publishRoles("someone-else");
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("volley role: no roles record: is volleyd running?\n");
  });

  it("a malformed record is reported as such", async () => {
    await publishRoles("volleyd", { broker: { machine: "box-a" } });
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("volley role: malformed roles record\n");
  });

  it("an unknown verb is a usage error", async () => {
    const r = await runCli({ argv: ["role", "shuffle"] });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("volley role: unknown verb: shuffle");
  });
});

/** A plan as volleyd's `role_plan` answers it (planWire). */
const plan = (over: Record<string, unknown> = {}) => ({
  role: "desk",
  from: "mac",
  to: "box-a",
  plan_id: "p-1",
  steps: [
    { id: "install", title: "Install the Desk on box-a", where: "box-a" },
    { id: "check", title: "Check the new Desk answers", where: "box-a" },
    { id: "record", title: "Record the Desk on box-a", where: "mac" },
  ],
  blocked: [],
  warnings: [],
  terminal: [],
  after: ["sign in again at http://box-a.lan:5199"],
  ...over,
});

type Op = { op: string; fields: Record<string, unknown> };
type Reply = { ok: boolean; error?: string; result?: unknown; sealed?: string } | null;

/**
 * A volleyd as the role ops see it (SPEC §4.6.24): live status, answers each admin op on its
 * reply topic with `answer(op)` (null: no answer), and publishes moves through `publishMove`.
 */
async function fakeVolleyd(url: string, answer: (o: Op, f: FakeVolleyd) => Promise<Reply>) {
  const b = new VolleyBroker();
  await b.connect({ url, agentId: "volleyd" });
  const send = (topic: string, channel: string, type: string, payload: unknown, retain = false) =>
    b.publish(
      topic,
      JSON.stringify(buildEnvelope({ agentId: "volleyd", parentId: null, channel, type, payload })),
      { qos: 1, retain },
    );
  await send("volley/default/volleyd/status", "status", "working", {}, true);
  const ops: Op[] = [];
  const f: FakeVolleyd = {
    ops,
    publishMove: (m) =>
      send(`volley/_system/roles/moves/${m.move_id}`, "_system/roles/moves", "role_move", m, true),
    stop: () => b.disconnect(),
  };
  await b.subscribeStream("volley/_system/auth/ops/+", ({ payload }) => {
    const e = parseEnvelope(payload);
    if (e === null || e.type !== "query") return;
    const { op, ...fields } = e.payload as { op: string };
    const o = { op, fields };
    ops.push(o);
    void answer(o, f).then((r) => {
      if (r === null) return;
      return b.publish(
        `volley/_system/auth/replies/${e.correlation_id}`,
        JSON.stringify(
          buildEnvelope({
            agentId: "volleyd",
            parentId: null,
            channel: "_system/auth",
            type: "ack",
            correlationId: e.correlation_id ?? "",
            payload: r,
          }),
        ),
        { qos: 1, retain: false },
      );
    });
  });
  return f;
}

interface FakeVolleyd {
  ops: Op[];
  publishMove: (m: Record<string, unknown>) => Promise<void>;
  stop: () => Promise<void>;
}

/** The moves topic's payload with `steps` ok up to `okUntil` (the rest pending). */
function movePayload(
  id: string,
  role: string,
  to: string,
  status: string,
  steps: { id: string; title: string; where: string }[],
  okUntil: number,
  extra: Record<string, unknown> = {},
) {
  return {
    move_id: id,
    role,
    from: "mac",
    to,
    status,
    since: new Date().toISOString(),
    steps: steps.map((s, i) => ({ ...s, status: i < okUntil ? "ok" : "pending" })),
    ...extra,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ADMIN = { VOLLEY_AUTH_USERNAME: "admin-1", VOLLEY_AUTH_PASSWORD: "pw" };

describe("volley role move | rollback", () => {
  let tb: TestBroker;
  let fv: FakeVolleyd | null = null;

  beforeEach(async () => {
    tb = await startTestBroker();
  });
  afterEach(async () => {
    await fv?.stop();
    fv = null;
    await tb.close();
  });

  const run = (argv: string[], env: Record<string, string> = ADMIN, confirm = false) => {
    const io = makeBufferIO();
    return runRole(
      { argv: [...argv, "--broker-url", tb.url], env, io },
      { confirm: async () => confirm },
    ).then((exitCode) => ({ exitCode, stdout: io.readStdout(), stderr: io.readStderr() }));
  };

  it("move desk --dry-run prints the sheet from the plan and exits 0, sending role_plan only", async () => {
    fv = await fakeVolleyd(tb.url, async () => ({ ok: true, result: plan() }));
    const r = await run(["move", "desk", "--to", "box-a", "--port", "5200", "--dry-run"]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(fv.ops).toEqual([
      { op: "role_plan", fields: { role: "desk", to: "box-a", port: 5200 } },
    ]);
    expect(r.stdout).toContain("Move the desk from mac to box-a (plan p-1)");
    expect(r.stdout).toContain("  1. on box-a: Install the Desk on box-a");
    expect(r.stdout).toContain("  3. on mac: Record the Desk on box-a");
    expect(r.stdout).toContain("  · sign in again at http://box-a.lan:5199");
  });

  it("--dry-run with a blocker prints it with its fix and exits 1", async () => {
    fv = await fakeVolleyd(tb.url, async () => ({
      ok: true,
      result: plan({
        blocked: [{ why: "box-a is down", fix: "volley peer doctor box-a" }],
        terminal: [
          { where: "box-a", reason: "needs root", command: "sudo volley broker receive b" },
        ],
        warnings: ["the broker leaves the supervisor's machine"],
      }),
    }));
    const r = await run(["move", "desk", "--to", "box-a", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("  ✗ box-a is down\n    fix: volley peer doctor box-a");
    expect(r.stdout).toContain("  on box-a (needs root):\n    sudo volley broker receive b");
    expect(r.stdout).toContain("  ! the broker leaves the supervisor's machine");
  });

  it("move broker --yes: role_plan, then role_move with the plan_id, each step streamed, then the undo line", async () => {
    const steps = [
      { id: "stop", title: "Stop the broker on mac", where: "mac" },
      { id: "receive", title: "Receive the broker on box-a", where: "box-a" },
      { id: "record", title: "Record the broker on box-a", where: "mac" },
    ];
    fv = await fakeVolleyd(tb.url, async ({ op }, f) => {
      if (op === "role_plan") return { ok: true, result: plan({ role: "broker", steps }) };
      // The move: each step published as it ends, answered once done.
      for (let i = 1; i <= steps.length; i++) {
        await f.publishMove(movePayload("m-1", "broker", "box-a", "running", steps, i));
        await sleep(20);
      }
      await f.publishMove(movePayload("m-1", "broker", "box-a", "done", steps, 3));
      return { ok: true, result: { move_id: "m-1", status: "done" } };
    });
    const r = await run([
      "move",
      "broker",
      "--to",
      "box-a",
      "--address",
      "owner@box-a.lan",
      "--lan",
      "--yes",
    ]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(fv.ops.map((o) => o.op)).toEqual(["role_plan", "role_move"]);
    expect(fv.ops[0]?.fields).toEqual({
      role: "broker",
      to: "box-a",
      address: "owner@box-a.lan",
      lan: true,
    });
    expect(fv.ops[1]?.fields).toMatchObject({
      role: "broker",
      to: "box-a",
      address: "owner@box-a.lan",
      lan: true,
      plan_id: "p-1",
    });
    expect(fv.ops[1]?.fields.reply_key).toBeDefined();
    const lines = r.stdout.split("\n");
    const ticks = lines.filter((l) => l.startsWith("✓ "));
    expect(ticks).toEqual([
      "✓ Stop the broker on mac (mac)",
      "✓ Receive the broker on box-a (box-a)",
      "✓ Record the broker on box-a (mac)",
    ]);
    expect(r.stdout).toContain("the broker runs on box-a (undo: volley role rollback m-1)");
  });

  it("without --yes it asks once; a no sends no role_move", async () => {
    fv = await fakeVolleyd(tb.url, async () => ({ ok: true, result: plan() }));
    const r = await run(["move", "desk", "--to", "box-a"], ADMIN, false);
    expect(r.exitCode).toBe(1);
    expect(fv.ops.map((o) => o.op)).toEqual(["role_plan"]);
    expect(r.stderr).toContain("not moved");
  });

  it("a desk move's sealed sign-in link is printed", async () => {
    fv = await fakeVolleyd(tb.url, async ({ op, fields }, f) => {
      if (op === "role_plan") return { ok: true, result: plan() };
      await f.publishMove(movePayload("m-2", "desk", "box-a", "done", plan().steps, 3));
      const key = createPublicKey({ key: fields.reply_key as never, format: "jwk" });
      const sealed = publicEncrypt(
        { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        Buffer.from(JSON.stringify({ link: "http://box-a.lan:5199/#signin=tok" })),
      ).toString("base64url");
      return { ok: true, result: { move_id: "m-2", status: "done" }, sealed };
    });
    const r = await run(["move", "desk", "--to", "box-a", "--yes"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("the desk runs on box-a (undo: volley role rollback m-2)");
    expect(r.stdout).toContain("http://box-a.lan:5199/#signin=tok");
  });

  it("a plan changed answer exits 1 with its text", async () => {
    fv = await fakeVolleyd(tb.url, async ({ op }) =>
      op === "role_plan"
        ? { ok: true, result: plan() }
        : { ok: false, error: "plan changed: moving the desk to box-a would now run other steps" },
    );
    const r = await run(["move", "desk", "--to", "box-a", "--yes"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("plan changed: moving the desk to box-a would now run other steps");
  });

  it("a failed move prints the failed step and that it was rolled back, exit 1", async () => {
    fv = await fakeVolleyd(tb.url, async ({ op }, f) => {
      if (op === "role_plan") return { ok: true, result: plan() };
      const steps = plan().steps;
      const m = movePayload("m-3", "desk", "box-a", "failed", steps, 1, {
        error: "the Desk did not answer",
      });
      m.steps[1] = { ...m.steps[1], status: "failed", line: "no answer" } as never;
      await f.publishMove(m);
      return {
        ok: false,
        error: "the Desk did not answer",
        result: { move_id: "m-3", status: "failed", step: "check", rolled_back: true },
      };
    });
    const r = await run(["move", "desk", "--to", "box-a", "--yes"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("✗ Check the new Desk answers (box-a): no answer");
    expect(r.stderr).toContain("volley role move: the Desk did not answer");
    expect(r.stdout).toContain("the desk stays on mac: every step done was undone");
  });

  it("a supervisor move's handing_over answer keeps streaming until the retained topic reads done", async () => {
    const steps = [
      { id: "bundle", title: "Bundle the supervisor", where: "mac" },
      { id: "receive", title: "Receive it on box-a", where: "box-a" },
      { id: "repair", title: "Re-pair mac", where: "box-a" },
    ];
    fv = await fakeVolleyd(tb.url, async ({ op }, f) => {
      if (op === "role_plan") return { ok: true, result: plan({ role: "supervisor", steps }) };
      void (async () => {
        await sleep(50);
        await f.publishMove(movePayload("m-4", "supervisor", "box-a", "running", steps, 2));
        // The old daemon is gone; the new one continues the same retained topic.
        await sleep(50);
        await f.publishMove(movePayload("m-4", "supervisor", "box-a", "done", steps, 3));
      })();
      return { ok: true, result: { move_id: "m-4", status: "running", handing_over: true } };
    });
    const r = await run(["move", "supervisor", "--to", "box-a", "--drain", "--yes"]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(fv.ops[1]?.fields).toMatchObject({ role: "supervisor", drain: true, plan_id: "p-1" });
    expect(r.stdout).toContain("✓ Re-pair mac (box-a)");
    expect(r.stdout).toContain("the supervisor runs on box-a (undo: volley role rollback m-4)");
  });

  it("rollback sends role_rollback and streams the new move", async () => {
    fv = await fakeVolleyd(tb.url, async (_o, f) => {
      await f.publishMove(movePayload("m-5", "desk", "mac", "done", plan().steps, 3));
      return { ok: true, result: { move_id: "m-5", rolls_back: "m-1" } };
    });
    const r = await run(["rollback", "m-1"]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(fv.ops).toEqual([{ op: "role_rollback", fields: { move_id: "m-1" } }]);
    expect(r.stdout).toContain("m-1 rolled back: the desk runs on mac");
  });

  it("a non-admin login this machine knows is refused before connecting", async () => {
    const dir = tempDir("volley-role-");
    writeFileSync(
      join(dir, "accounts.json"),
      JSON.stringify({
        accounts: [
          { name: "steer-1", role: "steer", kind: "device", created: "2026-10-19T00:00:00.000Z" },
        ],
      }),
    );
    const r = await run(["move", "desk", "--to", "box-a", "--dry-run"], {
      VOLLEY_AUTH_USERNAME: "steer-1",
      VOLLEY_AUTH_PASSWORD: "pw",
      VOLLEY_AUTH_DIR: dir,
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("steer-1 is a steer account, not an admin one");
    expect(r.stderr).toContain("role moves are admin ops");
  });

  it("no answer within the timeout exits 124", async () => {
    fv = await fakeVolleyd(tb.url, async () => null);
    const r = await run(["move", "desk", "--to", "box-a", "--dry-run", "--timeout", "1"]);
    expect(r.exitCode).toBe(124);
    expect(r.stderr).toContain("did not answer within 1 s");
  });

  it("a move whose topic never ends within the timeout exits 124", async () => {
    fv = await fakeVolleyd(tb.url, async ({ op }) =>
      op === "role_plan"
        ? { ok: true, result: plan({ role: "supervisor" }) }
        : { ok: true, result: { move_id: "m-6", status: "running", handing_over: true } },
    );
    const r = await run(["move", "supervisor", "--to", "box-a", "--yes", "--timeout", "1"]);
    expect(r.exitCode).toBe(124);
    expect(r.stderr).toContain("m-6");
  });

  it("flags of another role are usage errors", async () => {
    const r1 = await run(["move", "desk", "--to", "box-a", "--address", "x@y"]);
    expect(r1.exitCode).toBe(2);
    expect(r1.stderr).toContain("--address is an option of a broker move only");
    const r2 = await run(["move", "broker", "--to", "box-a", "--port", "5199"]);
    expect(r2.exitCode).toBe(2);
    const r3 = await run(["move", "broker"]);
    expect(r3.exitCode).toBe(2);
    expect(r3.stderr).toContain("--to");
    const r4 = await run(["move", "desk", "--to", "box-a", "--drain"]);
    expect(r4.exitCode).toBe(2);
  });
});
