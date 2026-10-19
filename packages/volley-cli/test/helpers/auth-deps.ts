import { writeFileSync } from "node:fs";
import type { Layout } from "../../src/auth/config";
import { type AuthDeps, realAuthDeps } from "../../src/auth/context";
import type { FakeDynsec } from "./fake-dynsec";

export type TestDeps = AuthDeps & {
  stdin: string;
  chowns: [string, number, number][];
  ctrlCalls: string[][];
  restarts: string[];
  versionCalls: string[];
  /** false: the admin login is refused (the broker does not run the plugin yet). */
  adminUp: boolean;
  binaryVersion: string | null;
};

/**
 * Real admin connections to an in-process Dynamic Security stand-in; `mosquitto_ctrl dynsec init`
 * writes the state file and seeds the admin login there; deterministic passwords and hex.
 */
export function fakeDeps(fake: FakeDynsec, layout: Layout): TestDeps {
  let n = 0;
  let h = 0;
  const deps: TestDeps = {
    stdin: "",
    chowns: [],
    ctrlCalls: [],
    restarts: [],
    versionCalls: [],
    adminUp: true,
    binaryVersion: "mosquitto version 2.1.2",
    connectAdmin: async (_url, creds) => {
      if (!deps.adminUp) throw new Error("not authorised");
      return realAuthDeps.connectAdmin(fake.url, creds);
    },
    mosquittoVersion: async (binary) => {
      deps.versionCalls.push(binary);
      return deps.binaryVersion;
    },
    ctrlInit: async (ctrl, stateFile, user, password) => {
      deps.ctrlCalls.push([ctrl, stateFile, user, password]);
      writeFileSync(stateFile, "{}\n");
      fake.setPassword(user, password, ["admin"]);
      return { code: 0, stderr: "" };
    },
    restart: async (command) => {
      deps.restarts.push(command);
      deps.adminUp = true;
      return { code: 0, stderr: "" };
    },
    layout: () => layout,
    generatePassword: () => `pw-${++n}`,
    randomHex: (bytes) => (++h).toString(16).padStart(bytes * 2, "0"),
    readStdin: async () => deps.stdin,
    brokerOwner: () => null,
    invokingUser: () => null,
    chown: (path, uid, gid) => {
      deps.chowns.push([path, uid, gid]);
    },
    restartWaitMs: 500,
  };
  return deps;
}
