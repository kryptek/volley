import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULTS_BY,
  type RolesDefaults,
  type RolesRecord,
  defaultRoles,
  readRoles,
  rolesFile,
  sameRoles,
  validateRoles,
  writeRoles,
} from "../src/roles/record";
import { schemaErrors } from "./helpers/schema";
import { tempDir } from "./helpers/tmp";

const NOW = "2026-10-24T09:00:00.000Z";
const DEFAULTS: RolesDefaults = {
  machine: "mac",
  mqttPort: 1883,
  wsPort: 9001,
  lan: true,
  deskUrl: "http://192.168.1.20:5199",
  now: NOW,
};
const KNOWN = { localName: "mac", hosts: ["box-a"] };

const payload = (r: RolesRecord) => ({
  schema_version: "0.1",
  agent_id: "volleyd",
  parent_id: null,
  wall_time: NOW,
  channel: "_system/roles",
  type: "roles",
  correlation_id: null,
  payload: r,
});

describe("the roles record (SPEC §4.6.24)", () => {
  let home: string;
  beforeEach(() => {
    home = tempDir("volleyd-roles-");
  });

  it("the default names the supervisor's machine for all three roles, by volleyd-defaults", () => {
    const r = defaultRoles(DEFAULTS);
    expect(r).toEqual({
      broker: { machine: "mac", address: { ssh: null, mqtt_port: 1883, ws_port: 9001 }, lan: true },
      supervisor: { machine: "mac" },
      desk: { machine: "mac", url: "http://192.168.1.20:5199" },
      version: 1,
      updated_at: NOW,
      updated_by: DEFAULTS_BY,
    });
    expect(DEFAULTS_BY).toBe("volleyd-defaults");
    expect(schemaErrors("roles.schema.json", payload(r))).toEqual([]);
  });

  it("a missing file yields the default, written so a restart reads the same record", () => {
    const first = readRoles(home, KNOWN, DEFAULTS);
    expect(first).toEqual({ ok: true, record: defaultRoles(DEFAULTS), created: true });
    expect(existsSync(rolesFile(home))).toBe(true);
    const again = readRoles(home, KNOWN, { ...DEFAULTS, now: "2026-10-25T00:00:00.000Z" });
    expect(again).toEqual({ ok: true, record: defaultRoles(DEFAULTS), created: false });
  });

  it("a record naming a configured host is accepted", () => {
    const r = { ...defaultRoles(DEFAULTS), desk: { machine: "box-a", url: "http://box-a:5199" } };
    expect(validateRoles(r, KNOWN)).toEqual({ ok: true, record: r });
  });

  it("a machine that is neither fleet.local_name nor a hosts.<name> is refused with its path", () => {
    const r = { ...defaultRoles(DEFAULTS), supervisor: { machine: "box-z" } };
    const v = validateRoles(r, KNOWN);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors).toEqual([
      {
        path: "supervisor.machine",
        reason: `"box-z" is neither this machine (fleet.local_name: mac) nor a configured host (hosts.box-z)`,
      },
    ]);
  });

  it("a record the schema refuses is reported with its paths", () => {
    const r = { ...defaultRoles(DEFAULTS), coordinator: { machine: "mac" } };
    const v = validateRoles(r, KNOWN);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors).toContainEqual({ path: "coordinator", reason: "unknown key" });
  });

  it("an unreadable or invalid file is refused, naming the file, and left as it is", () => {
    writeFileSync(rolesFile(home), "{ not json");
    const bad = readRoles(home, KNOWN, DEFAULTS);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/^roles\.json: /);
    expect(readFileSync(rolesFile(home), "utf8")).toBe("{ not json");

    const stray = {
      ...defaultRoles(DEFAULTS),
      broker: { ...defaultRoles(DEFAULTS).broker, machine: "box-z" },
    };
    writeFileSync(rolesFile(home), JSON.stringify(stray));
    const refused = readRoles(home, KNOWN, DEFAULTS);
    expect(refused.ok).toBe(false);
    if (!refused.ok)
      expect(refused.error).toMatch(/^roles\.json: broker\.machine: "box-z" is neither/);
  });

  it("a write is a temp file renamed over roles.json", () => {
    const calls: string[] = [];
    const fs = {
      writeFileSync: (p: string, data: string, opts: { mode: number }) => {
        calls.push(`write ${p.slice(home.length + 1)}`);
        writeFileSync(p, data, opts);
      },
      renameSync: (from: string, to: string) => {
        calls.push(`rename ${from.slice(home.length + 1)} ${to.slice(home.length + 1)}`);
        renameSync(from, to);
      },
    };
    const r = defaultRoles(DEFAULTS);
    writeRoles(home, r, fs);
    expect(calls).toEqual(["write roles.json.tmp", "rename roles.json.tmp roles.json"]);
    expect(JSON.parse(readFileSync(join(home, "roles.json"), "utf8"))).toEqual(r);
    expect(existsSync(join(home, "roles.json.tmp"))).toBe(false);
  });

  it("sameRoles compares where the roles run, not when or by whom the record was written", () => {
    const a = defaultRoles(DEFAULTS);
    expect(
      sameRoles(a, {
        ...a,
        version: 2,
        updated_at: "2026-10-25T00:00:00.000Z",
        updated_by: "admin",
      }),
    ).toBe(true);
    expect(sameRoles(a, { ...a, desk: { machine: "box-a", url: "http://box-a:5199" } })).toBe(
      false,
    );
    expect(sameRoles(a, { ...a, broker: { ...a.broker, lan: false } })).toBe(false);
  });
});
