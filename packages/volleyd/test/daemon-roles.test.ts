import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROLES_TOPIC } from "../src/control";
import type { Daemon } from "../src/daemon";
import { readJournalFile } from "../src/journal";
import { type RolesRecord, rolesFile } from "../src/roles/record";
import { SYSTEM_WAVE } from "../src/types";
import { type DaemonEnv, makeDaemonEnv } from "./helpers/daemon-env";
import { schemaErrors } from "./helpers/schema";

const CONFIG =
  "fleet:\n  local_name: mac\nhosts:\n  box-a:\n    target: dev@box-a\n    volley_dir: /opt/volley\n    tunnel: { remote_port: 21883, supervise: false }\n";

describe("volleyd publishes the machine roles record (SPEC §4.6.24)", () => {
  let env: DaemonEnv;
  let daemon: Daemon;
  const logs: string[] = [];
  const start = async () => {
    daemon = await env.start({ log: (l) => logs.push(l) });
  };
  const restart = async () => {
    await daemon.stop();
    await start();
  };
  const rolesEvents = () =>
    readJournalFile(join(env.home, "waves", SYSTEM_WAVE, "journal.jsonl")).filter(
      (e) => e.type === "roles_changed",
    );
  const retainedRoles = async () =>
    (await env.retained(ROLES_TOPIC)) as { agent_id: string; payload: RolesRecord } | null;

  beforeEach(async () => {
    logs.length = 0;
    env = await makeDaemonEnv();
    writeFileSync(join(env.home, "config.yaml"), CONFIG);
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("on first start: the retained record validates and names local_name for all three roles", async () => {
    await start();
    const env1 = await retainedRoles();
    expect(env1).not.toBeNull();
    expect(schemaErrors("roles.schema.json", env1)).toEqual([]);
    const r = env1?.payload as RolesRecord;
    expect([r.broker.machine, r.supervisor.machine, r.desk.machine]).toEqual(["mac", "mac", "mac"]);
    expect(r.broker.address).toEqual({
      ssh: null,
      mqtt_port: Number(new URL(env.broker.url).port),
      ws_port: 9001,
    });
    expect(r.broker.lan).toBe(false);
    expect(r.desk.url).toBe("http://localhost:5199");
    expect(r.updated_by).toBe("volleyd-defaults");
    // Written to $VOLLEYD_HOME/roles.json, and journaled once in _system.
    expect(JSON.parse(readFileSync(rolesFile(env.home), "utf8"))).toEqual(r);
    expect(rolesEvents().map((e) => e.data)).toEqual([{ by: "volleyd-defaults", roles: r }]);
  });

  it("lan and the Desk's address come from setup.json", async () => {
    writeFileSync(
      join(env.home, "setup.json"),
      JSON.stringify({
        layout: "snap",
        config: "/path/to/mosquitto.conf",
        state_file: "/path/to/dynamic-security.json",
        auth_dir: "/path/to/auth",
        desk_host: "192.0.2.20",
        desk_port: 5200,
        lan: true,
      }),
    );
    await start();
    const r = (await retainedRoles())?.payload as RolesRecord;
    expect(r.broker.lan).toBe(true);
    expect(r.desk.url).toBe("http://192.0.2.20:5200");
  });

  it("an already-bracketed IPv6 desk_host is not bracketed again", async () => {
    writeFileSync(
      join(env.home, "setup.json"),
      JSON.stringify({
        layout: "snap",
        config: "/path/to/mosquitto.conf",
        state_file: "/path/to/dynamic-security.json",
        auth_dir: "/path/to/auth",
        desk_host: "[2001:db8::20]",
        desk_port: 5200,
        lan: true,
      }),
    );
    await start();
    const r = (await retainedRoles())?.payload as RolesRecord;
    expect(r.desk.url).toBe("http://[2001:db8::20]:5200");
  });

  it("a restart republishes the same record and journals nothing new", async () => {
    await start();
    const first = await retainedRoles();
    await restart();
    const again = await retainedRoles();
    expect(again?.payload).toEqual(first?.payload);
    expect(rolesEvents()).toHaveLength(1);
  });

  it("a record that differs from the last journaled one is journaled at start", async () => {
    await start();
    const r = (await retainedRoles())?.payload as RolesRecord;
    const moved: RolesRecord = {
      ...r,
      desk: { machine: "box-a", url: "http://box-a:5199" },
      version: 2,
      updated_by: "admin-1",
    };
    writeFileSync(rolesFile(env.home), JSON.stringify(moved));
    await restart();
    expect((await retainedRoles())?.payload).toEqual(moved);
    expect(rolesEvents().map((e) => e.data)).toEqual([
      { by: "volleyd-defaults", roles: r },
      { by: "admin-1", roles: moved },
    ]);
  });

  it("an invalid roles.json is logged with its path; the last journaled record is published", async () => {
    await start();
    const r = (await retainedRoles())?.payload as RolesRecord;
    writeFileSync(rolesFile(env.home), JSON.stringify({ ...r, supervisor: { machine: "box-z" } }));
    await restart();
    expect(logs.some((l) => l.includes('roles.json: supervisor.machine: "box-z" is neither'))).toBe(
      true,
    );
    expect((await retainedRoles())?.payload).toEqual(r);
    expect(rolesEvents()).toHaveLength(1);
  });
});
