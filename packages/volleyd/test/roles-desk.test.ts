import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecOptions } from "../src/exec";
import type { RolesRecord } from "../src/roles/record";
import { type Fleet, PEER, makeFleet } from "./helpers/fleet-env";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const REPLY_KEY = publicKey.export({ format: "jwk" });
const unseal = (sealed: unknown) =>
  JSON.parse(
    privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(sealed as string, "base64url"),
    ).toString(),
  ) as Record<string, string>;

interface Plan {
  role: string;
  from: string;
  to: string;
  plan_id: string;
  steps: { id: string; title: string; where: string }[];
  blocked: { why: string; fix?: string }[];
  after: string[];
}

describe("the Desk move (#466, SPEC §4.6.24)", () => {
  let fleet: Fleet;
  /** What the box answers each remote script with (by its steps, joined), else exit 0. */
  let onBox: (lines: string[]) => { code?: number; stdout?: string; stderr?: string } | undefined;

  beforeEach(async () => {
    fleet = await makeFleet();
    onBox = (lines) =>
      // Nothing listens on the Desk's port there.
      lines.some((l) => l.startsWith("nc -z")) ? { code: 1 } : undefined;
    fleet.exec.on(["ssh", "-T"], (_argv, opts: ExecOptions) => {
      const lines = (opts.remote?.steps ?? []).map((s) => s.argv.join(" "));
      return onBox(lines) ?? {};
    });
  });
  afterEach(async () => {
    await fleet.close();
  });

  const boxScripts = () =>
    fleet.exec.calls
      .filter((c) => c.argv[0] === "ssh" && c.opts.remote !== undefined)
      .map((c) => (c.opts.remote?.steps ?? []).map((s) => s.argv.join(" ")).join(" && "));
  const local = () =>
    fleet.auth.calls.map((c) => c.argv.join(" ")).filter((l) => !l.includes("auth list"));
  const plan = async (extra: Record<string, unknown> = {}) => {
    const a = await fleet.adminOp({ op: "role_plan", role: "desk", to: PEER, ...extra });
    expect(a?.error).toBeUndefined();
    return a?.result as Plan;
  };
  const roles = () =>
    JSON.parse(readFileSync(join(fleet.env.home, "roles.json"), "utf-8")) as RolesRecord;
  /** Keep the fake clock moving (health-check retries sleep on it) until `p` settles. */
  async function settle<T>(p: Promise<T>): Promise<T> {
    let done = false;
    void p.finally(() => {
      done = true;
    });
    while (!done) {
      await fleet.clock.advance(5_000);
      // broker round-trip: the move's answer comes back over MQTT
      await new Promise((r) => setTimeout(r, 10));
    }
    return p;
  }
  const move = (plan_id: string) =>
    settle(
      fleet.adminOp({ op: "role_move", role: "desk", to: PEER, plan_id, reply_key: REPLY_KEY }),
    );

  it("role_plan lists the five steps, each with where it runs, and a plan_id; nothing runs", async () => {
    const p = await plan();
    expect(p).toMatchObject({ role: "desk", from: "control", to: PEER, blocked: [] });
    expect(p.plan_id).toMatch(/^desk-[0-9a-f]{16}$/);
    expect(p.steps.map((s) => `${s.id}@${s.where}`)).toEqual([
      `install@${PEER}`,
      `check@${PEER}`,
      "record@control",
      "signin@control",
      "unload@control",
    ]);
    expect(p.after.join(" ")).toMatch(/signs in again/);
    expect(boxScripts().some((s) => s.includes("desk install"))).toBe(false);
    expect(roles().desk.machine).toBe("control");
  });

  it("blocks on a busy port, a version behind the supervisor's, and a down machine", async () => {
    onBox = (lines) =>
      lines.some((l) => l.startsWith("nc -z 127.0.0.1 5199")) ? { code: 0 } : undefined;
    expect((await plan()).blocked.map((b) => b.why)).toEqual([`port 5199 is taken on ${PEER}`]);
    onBox = (lines) => (lines.some((l) => l.startsWith("nc -z")) ? { code: 1 } : undefined);
    await fleet.beat({ versions: { peer: "0.3.0", volley: "0.3.0", bun: "1.3.1", git: "2.43.0" } });
    expect((await plan()).blocked.map((b) => b.why)).toEqual([
      `${PEER} runs volley 0.3.0, behind the supervisor's 0.4.0`,
    ]);
    await fleet.lwt();
    const down = await plan();
    expect(down.blocked.map((b) => b.why)).toEqual([`${PEER} is down`]);
    // A blocked plan does not move.
    const a = await fleet.adminOp({
      op: "role_move",
      role: "desk",
      to: PEER,
      plan_id: down.plan_id,
      reply_key: REPLY_KEY,
    });
    expect(a?.error).toMatch(/^the move is blocked: box is down/);
  });

  it("refuses a stale plan_id with `plan changed`, an unknown machine and the Desk's own machine", async () => {
    const a = await fleet.adminOp({
      op: "role_move",
      role: "desk",
      to: PEER,
      plan_id: "desk-0000000000000000",
      reply_key: REPLY_KEY,
    });
    expect(a?.error).toMatch(/^plan changed/);
    expect((await fleet.adminOp({ op: "role_plan", role: "desk", to: "nope" }))?.error).toMatch(
      /^unknown machine "nope"/,
    );
    expect((await fleet.adminOp({ op: "role_plan", role: "desk", to: "control" }))?.error).toBe(
      "desk already runs on control",
    );
  });

  it("a non-admin is refused up front", async () => {
    const a = await fleet.adminOp({ op: "role_plan", role: "desk", to: PEER }, PEER);
    expect(a?.ok).toBe(false);
    expect(a?.error).toMatch(/account ops need the admin role/);
  });

  it("moves the Desk: install and check there, record, a sealed sign-in link, the old unit unloaded last", async () => {
    const p = await plan();
    const a = await move(p.plan_id);
    expect(a?.error).toBeUndefined();
    expect(a?.result).toMatchObject({ status: "done" });
    const scripts = boxScripts().filter((s) => s.includes("volley desk"));
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toMatch(/^volley desk install --port 5199 --broker-host \S+$/);
    expect(scripts[1]).toBe("volley desk check --url http://127.0.0.1:5199 --version 0.4.0");
    const r = roles();
    expect(r.desk).toEqual({ machine: PEER, url: `http://${PEER}:5199` });
    expect(r.version).toBe(2);
    expect(r.updated_by).toBe("admin-1");
    // The sign-in link for the new origin, sealed to the requester.
    expect(unseal(a?.sealed).link).toBe(
      `http://${PEER}:5199/#signin=vly_signin_0123abcd_${"0".repeat(32)}`,
    );
    // The old Desk's unit is unloaded here, and last.
    const steps = local();
    const unload = steps.findIndex(
      (l) => l === "systemctl --user stop volley-desk.service" || l.startsWith("launchctl bootout"),
    );
    expect(unload).toBe(steps.length - 1);
    expect(steps.some((l) => l.startsWith("volley auth signin-link --role steer"))).toBe(true);
    // The moves topic ends done; the journal tells the story.
    const topic = (await fleet.env.retained(
      `volley/_system/roles/moves/${(a?.result as { move_id: string }).move_id}`,
    )) as {
      payload: { status: string; steps: { status: string }[] };
    };
    expect(topic.payload.status).toBe("done");
    expect(topic.payload.steps.every((s) => s.status === "ok")).toBe(true);
    const types = fleet.system().map((e) => e.type);
    expect(types).toContain("role_move_started");
    expect(types).toContain("role_move_completed");
    expect(
      fleet
        .system()
        .filter((e) => e.type === "roles_changed")
        .at(-1)?.data,
    ).toMatchObject({
      by: "admin-1",
    });
  });

  it("a failing health check undoes the install and answers ok: false, rolled_back: true", async () => {
    onBox = (lines) =>
      lines.some((l) => l.startsWith("nc -z"))
        ? { code: 1 }
        : lines.some((l) => l.startsWith("volley desk check"))
          ? { code: 1, stderr: "volley desk check: / answered 502" }
          : undefined;
    const p = await plan();
    const a = await move(p.plan_id);
    expect(a?.ok).toBe(false);
    expect(a?.result).toMatchObject({ status: "failed", step: "check", rolled_back: true });
    expect(a?.error).toMatch(/answered 502/);
    expect(boxScripts().filter((s) => s.startsWith("volley desk check"))).toHaveLength(6);
    expect(boxScripts().at(-1)).toBe("volley desk uninstall");
    // The record and the old Desk are untouched.
    expect(roles().desk.machine).toBe("control");
    expect(
      local().some((l) => l.includes("volley-desk.service") || l.includes("systems.volley.desk")),
    ).toBe(false);
    expect(fleet.system().find((e) => e.type === "role_move_failed")?.data).toMatchObject({
      step: "check",
      rolled_back: true,
    });
  });

  it("role_rollback undoes a done move from its kept record: the old Desk back, the new one removed", async () => {
    const a = await move((await plan()).plan_id);
    const moved = (a?.result as { move_id: string }).move_id;
    const b = await settle(fleet.adminOp({ op: "role_rollback", move_id: moved }));
    expect(b?.error).toBeUndefined();
    expect(b?.result).toMatchObject({ rolls_back: moved });
    expect(roles().desk).toEqual({ machine: "control", url: "http://localhost:5199" });
    expect(local()).toContain("systemctl --user start volley-desk.service");
    expect(local()).toContain("volley desk check --url http://127.0.0.1:5199 --version 0.4.0");
    expect(boxScripts().at(-1)).toBe("volley desk uninstall");
    const topic = (await fleet.env.retained(`volley/_system/roles/moves/${moved}`)) as {
      payload: { status: string };
    };
    expect(topic.payload.status).toBe("rolled_back");
    // Only a done move is rolled back.
    expect((await fleet.adminOp({ op: "role_rollback", move_id: moved }))?.error).toMatch(
      /is rolled_back: only a done move/,
    );
    expect((await fleet.adminOp({ op: "role_rollback", move_id: "nope" }))?.error).toMatch(
      /^no kept move/,
    );
  });
});
